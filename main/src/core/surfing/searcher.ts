import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { configManager } from '../../config/loader';
import {
  findConversationById, insertMessage, createConversation, createSurfRun,
  setSurfRunStatus, getSurfRun,
} from '../../db/queries';
import { runPlanner } from './planner';
import { runWanderer } from './wanderer';
import { runCurator } from './curator';
import { modelFor } from '../models';
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
// must supply them. The new conv's `surf_runs` row pins the model + budget.
export function createSurfConversation(params: {
  botId: string;
  userId: string;
  sourceMessageConvId: string | null;
  modelSlug: string;
  budget: number;
  title?: string | null;
}): string {
  const id = randomUUID();
  const title = params.title?.trim() || (params.sourceMessageConvId ? '冲浪' : '自由冲浪');
  createConversation(id, params.botId, params.userId, title, 'surf');
  createSurfRun({
    conversationId: id,
    sourceMessageConvId: params.sourceMessageConvId,
    modelSlug: params.modelSlug,
    budget: params.budget,
  });
  return id;
}

function makeEmitter(surfConvId: string) {
  // Resolve the source message conv (if any) once per emitter so SSE
  // subscribers can correlate without doing a per-event DB lookup.
  let sourceMessageConvId: string | null = null;
  try {
    sourceMessageConvId = getSurfRun(surfConvId)?.source_message_conv_id ?? null;
  } catch {}

  return (content: string, type: string = 'surf_status') => {
    try {
      insertMessage(randomUUID(), surfConvId, 'log', `surf:${type}`, content);
    } catch {}
    surfEvents.emit('log', {
      surfConvId,
      conversationId: surfConvId,
      sourceMessageConvId,
      type, content, timestamp: Date.now(),
    });
  };
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
}

export interface RunSurfParams {
  surfConvId: string;             // the 冲浪 tab conv that owns this run
  sourceConvId?: string | null;   // optional message conv that provides planner context
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

    // Source conversation provides planner context (known_profile etc).
    // For free-standing surfs, planner gets minimal context and leans heavily
    // on wanderer.
    const effectiveSourceId = sourceConvId ?? surfRun.source_message_conv_id;
    const sourceConv = effectiveSourceId ? findConversationById(effectiveSourceId) : null;

    const model = surfRun.model_slug || modelFor('surfing');
    const totalBudget = surfRun.budget;

    // Reserve budget for curator: at least 2, or up to 25% of total, whichever is larger.
    const curatorReserve = Math.max(2, Math.floor(totalBudget * 0.25));
    const wandererBudget = Math.max(1, totalBudget - curatorReserve);

    emit(`预算：总 ${totalBudget}，wanderer 上限 ${wandererBudget}，curator 保底 ≥${curatorReserve}`);
    emit(`模型：${model}${sourceConv ? ` · 源会话：${sourceConv.title?.trim() || sourceConv.id.slice(0, 8)}` : ' · 自由冲浪（无源会话）'}`);

    // Phase 1+2: planner + wanderer in parallel.
    checkAborted(signal);
    emit('启动 planner 和 wanderer（并行）');

    // Planner needs a conversation to read history from. If source is set we
    // use it; for free-standing surfs we still pass surfConvId — planner will
    // see only meta-messages but the wanderer carries the load.
    const plannerConvId = effectiveSourceId ?? surfConvId;

    const [plan, wanderResult] = await Promise.all([
      runPlanner({
        conversationId: plannerConvId, botId, userId, model,
        emitLog: (c) => emit(`[planner] ${c}`),
        signal,
      }),
      runWanderer({
        conversationId: surfConvId, model,
        budget: wandererBudget,
        emitLog: (c) => emit(c),
        signal,
      }),
    ]);

    // Planner summary
    if (plan.blind_spots) emit(`[planner] 盲区：${plan.blind_spots}`);
    if (plan.needs) emit(`[planner] 需要：${plan.needs}`);
    const kp = plan.known_profile;
    if (kp.topics_covered.length > 0) emit(`[planner] 已聊主题：${kp.topics_covered.join('、')}`);
    if (kp.open_questions.length > 0) emit(`[planner] 未解问题：${kp.open_questions.join('、')}`);
    if (kp.interests.length > 0) emit(`[planner] 长期兴趣：${kp.interests.join('、')}`);

    // Wanderer summary
    emit(`[wanderer] 完成：${wanderResult.findings.length} 条发现，${wanderResult.toolCallsUsed}/${wandererBudget} 次工具（${wanderResult.turns} 轮）`);
    if (wanderResult.findings.length > 0) {
      const list = wanderResult.findings.map((f, i) => `  ${i + 1}. ${f.title}`).join('\n');
      emit(`[wanderer] raw_findings:\n${list}`);
    }

    if (!plan.blind_spots && kp.topics_covered.length === 0 && wanderResult.findings.length === 0) {
      emit('⚠️ planner 输出不足、wanderer 也没收获，放弃本次冲浪');
      setSurfRunStatus(surfConvId, 'done');
      return;
    }

    // Phase 3: curator
    checkAborted(signal);
    const curatorBudget = Math.max(curatorReserve, totalBudget - wanderResult.toolCallsUsed);
    emit(`启动 curator，预算 ${curatorBudget} 次`);

    const curatorResult = await runCurator({
      conversationId: surfConvId, model,
      plan, rawFindings: wanderResult.findings,
      budget: curatorBudget,
      emitLog: (c) => emit(c),
      signal,
    });

    emit(`[curator] 完成：${curatorResult.turns} 轮，${curatorResult.toolCallsUsed}/${curatorBudget} 次工具`);

    // Bridges
    if (curatorResult.bridges.length > 0) {
      const bridgesText = curatorResult.bridges.map((b, i) =>
        `  ${i + 1}. "${b.finding}" ↔ "${b.user_interest}"\n     → ${b.connection}`,
      ).join('\n');
      emit(`🌉 bridges (${curatorResult.bridges.length}):\n${bridgesText}`, 'surf_bridges');
    } else {
      emit('🌉 bridges: (无——wanderer 捡回来的东西都太直白或太偏离)');
    }

    if (curatorResult.novelFindings.length > 0) {
      emit(`✨ novel:\n${curatorResult.novelFindings.map((x, i) => `  ${i + 1}. ${x}`).join('\n')}`);
    }
    if (curatorResult.discardedAsKnown.length > 0) {
      emit(`♻️  已知淘汰:\n${curatorResult.discardedAsKnown.map((x, i) => `  ${i + 1}. ${x}`).join('\n')}`);
    }
    if (curatorResult.discardedIrrelevant.length > 0) {
      emit(`🗑️  无关淘汰:\n${curatorResult.discardedIrrelevant.map((x, i) => `  ${i + 1}. ${x}`).join('\n')}`);
    }

    // Delivery
    const finalMsg = curatorResult.finalMessage;
    if (!finalMsg) {
      emit('⚠️ curator 未产出最终消息');
      setSurfRunStatus(surfConvId, 'done');
      return;
    }

    // 1) Always record the final message in the surf conversation.
    const surfMsgId = randomUUID();
    insertMessage(surfMsgId, surfConvId, 'bot', botId, finalMsg);
    emit(finalMsg, 'surf_result');

    // 2) If a source message conv was provided, also deliver into it as a
    // bot message (preserves the "bot proactively shares" UX in chat).
    if (sourceConv) {
      const deliveredId = randomUUID();
      insertMessage(deliveredId, sourceConv.id, 'bot', botId, finalMsg);
      replyFn({
        type: 'message',
        conversationId: sourceConv.id,
        messageId: deliveredId,
        content: finalMsg,
      });
    }

    // Always echo to the surf conv channel so the surf-tab view updates live.
    replyFn({
      type: 'message',
      conversationId: surfConvId,
      messageId: surfMsgId,
      content: finalMsg,
      metadata: { sender_kind: 'surf_result' },
    });

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
    // Clean up the per-message-conv guard if this surf was bound to one.
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
