import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import {
  findConversationById, insertMessage, createConversation, createSurfRun,
  setSurfRunStatus, getSurfRun,
} from '../../db/queries';
import { recordBotMessage } from '../../honcho/memory';
import { runSurfAgent } from './agent';
import type { OutboundMessage } from '../../bus/types';

// Keyed by **surf** conversation id (the 冲浪 tab conv that owns the run).
// Multiple surfs can run concurrently; each one is independently cancellable.
export const surfEvents = new EventEmitter();
export const activeSurfs = new Map<string, AbortController>();

// Tracks which message conversations currently have a surf in flight, so the
// auto-trigger doesn't pile up multiple surfs per chat.
export const surfsByMessageConv = new Map<string, string>(); // msgConvId → surfConvId

export type SurfTrigger = 'auto' | 'user' | 'panel';

export function stopSurf(surfConvId: string): boolean {
  const controller = activeSurfs.get(surfConvId);
  if (controller) {
    controller.abort();
    activeSurfs.delete(surfConvId);
    return true;
  }
  return false;
}

// Create a surf-tab conversation that records this run. botId/userId come
// from the optional source message conv when given; otherwise the caller
// must supply them. The new conv's `surf_runs` row pins the cost budget.
export function createSurfConversation(params: {
  botId: string;
  userId: string;
  sourceMessageConvId: string | null;
  costBudgetUsd: number;
  title?: string | null;
}): string {
  const id = randomUUID();
  const title = params.title?.trim() || (params.sourceMessageConvId ? '冲浪' : '自由冲浪');
  createConversation(id, params.botId, params.userId, title, 'surf');
  createSurfRun({
    conversationId: id,
    sourceMessageConvId: params.sourceMessageConvId,
    costBudgetUsd: params.costBudgetUsd,
  });
  return id;
}

function makeEmitter(surfConvId: string) {
  let sourceMessageConvId: string | null = null;
  try {
    sourceMessageConvId = getSurfRun(surfConvId)?.source_message_conv_id ?? null;
  } catch {}

  // surf_result is delivered as a real bot message (insertMessage with
  // sender_type='bot') in deliverFinalMessage, so persisting a duplicate
  // log row here would double-render in the UI. Live SSE still goes out.
  const NO_PERSIST_TYPES = new Set(['surf_result']);

  return (content: string, type: string = 'surf_status') => {
    if (!NO_PERSIST_TYPES.has(type)) {
      try {
        insertMessage(randomUUID(), surfConvId, 'log', `surf:${type}`, content);
      } catch {}
    }
    surfEvents.emit('log', {
      surfConvId,
      conversationId: surfConvId,
      sourceMessageConvId,
      type, content, timestamp: Date.now(),
    });
  };
}

export interface RunSurfParams {
  surfConvId: string;
  sourceConvId?: string | null;
  replyFn: (msg: OutboundMessage) => void;
  signal?: AbortSignal;
  trigger?: SurfTrigger;
}

export async function runSurf(params: RunSurfParams): Promise<void> {
  const { surfConvId, sourceConvId, replyFn, signal, trigger = 'user' } = params;
  const emit = makeEmitter(surfConvId);
  setSurfRunStatus(surfConvId, 'running');

  try {
    emit(`Surfing triggered (${trigger})`);

    const surfConv = findConversationById(surfConvId);
    if (!surfConv) {
      emit('冲浪会话不存在，退出');
      setSurfRunStatus(surfConvId, 'error');
      return;
    }
    const surfRun = getSurfRun(surfConvId);
    if (!surfRun) {
      emit('冲浪 run 设置缺失，退出');
      setSurfRunStatus(surfConvId, 'error');
      return;
    }

    const botId = surfConv.bot_id;
    const userId = surfConv.user_id;

    const effectiveSourceId = sourceConvId ?? surfRun.source_message_conv_id;
    const sourceConv = effectiveSourceId ? findConversationById(effectiveSourceId) : null;

    const costBudgetUsd = surfRun.cost_budget_usd;
    emit(`预算 $${costBudgetUsd.toFixed(2)}${sourceConv ? ` · 源会话：${sourceConv.title?.trim() || sourceConv.id.slice(0, 8)}` : ' · 自由冲浪（无源会话）'}`);

    const result = await runSurfAgent({
      surfConvId,
      sourceConvId: effectiveSourceId ?? null,
      botId, userId,
      costBudgetUsd,
      emit, signal,
    });

    if (result.satisfied && result.finalMessage) {
      await deliverFinalMessage({
        surfConvId, surfConv, sourceConv,
        finalMsg: result.finalMessage, replyFn, emit,
      });
    } else {
      // Quiet finish — no push to source conv. Still leave a log line in the
      // surf tab so the user can see what happened if they look.
      const why = result.finishReason || '(没说)';
      emit(`本次未交付：${result.satisfied ? '总结为空' : '空手而归'} — ${why}`, 'surf_skipped');
    }

    setSurfRunStatus(surfConvId, 'done');
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      emit('已中断');
      setSurfRunStatus(surfConvId, 'aborted');
      return;
    }
    emit(`⚠️ 出错：${e?.message ?? e}`, 'error');
    setSurfRunStatus(surfConvId, 'error');
    throw e;
  } finally {
    activeSurfs.delete(surfConvId);
    let sourceMessageConvId: string | null = null;
    for (const [msgConv, sConv] of surfsByMessageConv) {
      if (sConv === surfConvId) {
        sourceMessageConvId = msgConv;
        surfsByMessageConv.delete(msgConv);
      }
    }
    surfEvents.emit('done', {
      surfConvId,
      conversationId: surfConvId,
      sourceMessageConvId,
      timestamp: Date.now(),
    });
  }
}

async function deliverFinalMessage(params: {
  surfConvId: string;
  surfConv: any;
  sourceConv: any | null;
  finalMsg: string;
  replyFn: (msg: OutboundMessage) => void;
  emit: (c: string, type?: string) => void;
}): Promise<void> {
  const { surfConvId, surfConv, sourceConv, finalMsg, replyFn, emit } = params;
  if (!finalMsg) {
    emit('⚠️ 未产出最终消息');
    return;
  }
  const botId = surfConv?.bot_id;
  if (!botId) return;

  const surfMsgId = randomUUID();
  insertMessage(surfMsgId, surfConvId, 'bot', botId, finalMsg);
  emit(finalMsg, 'surf_result');

  if (sourceConv) {
    const deliveredId = randomUUID();
    insertMessage(deliveredId, sourceConv.id, 'bot', botId, finalMsg);
    // Persist into Honcho session so user/bot peer representations pick it up
    // — surfing is part of the bot's "memory of having reached out to you".
    recordBotMessage({ botId, conversationId: sourceConv.id, content: finalMsg });
    replyFn({
      type: 'message',
      conversationId: sourceConv.id,
      messageId: deliveredId,
      content: finalMsg,
    });
  }

  replyFn({
    type: 'message',
    conversationId: surfConvId,
    messageId: surfMsgId,
    content: finalMsg,
    metadata: { sender_kind: 'surf_result' },
  });
}
