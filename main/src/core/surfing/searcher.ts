import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { configManager } from '../../config/loader';
import {
  findConversationById, insertMessage, createConversation, createSurfRun,
  setSurfRunStatus, setSurfRunKind, setSurfRunVectorJson, getSurfRun,
  recordSurfVector, runsSinceLastSerendipity,
} from '../../db/queries';
import { runVectorPicker, vectorHash, type DiggingVector } from './vector-picker';
import { runDigger } from './digger';
import { runSynthesizer } from './synthesizer';
import { runWanderer } from './wanderer';
import { runPlanner } from './planner';
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

export interface VectorOverride {
  topic: string;
  mode: DiggingVector['mode'];
  freshness_window?: string;
}

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
  sourceConvId?: string | null;   // optional message conv that provides picker context
  replyFn: (msg: OutboundMessage) => void;
  signal?: AbortSignal;
  trigger?: SurfTrigger;
  // User-specified vector override (skips picker entirely).
  vectorOverride?: VectorOverride | null;
  // Force this run to burn a serendipity slot regardless of counter state.
  forceSerendipity?: boolean;
}

export async function runSurf(params: RunSurfParams): Promise<void> {
  const {
    surfConvId, sourceConvId, replyFn, signal, trigger = 'user',
    vectorOverride = null, forceSerendipity = false,
  } = params;
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

    const model = surfRun.model_slug || modelFor('surfing');
    const totalBudget = surfRun.budget;

    emit(`模型：${model}${sourceConv ? ` · 源会话：${sourceConv.title?.trim() || sourceConv.id.slice(0, 8)}` : ' · 自由冲浪（无源会话）'}`);
    emit(`总预算：${totalBudget}`);

    // ── Decide kind: serendipity slot vs. vector run ──
    let useSerendipity = forceSerendipity;
    if (!useSerendipity && !vectorOverride) {
      const everyN = configManager.getBotConfig(botId).surfing.serendipityEveryN ?? 5;
      if (everyN > 0) {
        const since = runsSinceLastSerendipity(userId, botId);
        if (since >= everyN) {
          useSerendipity = true;
          emit(`🎲 serendipity slot 触发（距上次 ${since === Number.MAX_SAFE_INTEGER ? '从未' : since} 次运行 ≥ ${everyN}）`);
        }
      }
    }

    if (useSerendipity) {
      setSurfRunKind(surfConvId, 'serendipity');
      await runSerendipityPath({
        surfConvId, sourceConv, botId, userId,
        model, totalBudget, signal, emit, replyFn,
      });
      return;
    }

    setSurfRunKind(surfConvId, 'vector');

    // ── Vector path ──
    checkAborted(signal);

    const picker = await runVectorPicker({
      surfConvId, sourceConvId: effectiveSourceId ?? null,
      botId, userId, model,
      budgetHint: totalBudget,
      emitLog: (c) => emit(c),
      signal,
      override: vectorOverride,
    });

    if (picker.candidates.length > 0) {
      const lines = picker.candidates.map((c, i) => {
        const sel = picker.picked.includes(c) ? '✓' : ' ';
        const score = c.score_hint != null ? ` (s=${c.score_hint.toFixed(2)})` : '';
        const fresh = c.freshness_window ? ` [${c.freshness_window}]` : '';
        return `  ${sel} ${i + 1}. [${c.mode}]${fresh} ${c.topic}${score} — ${c.why_now}`;
      }).join('\n');
      emit(`[picker] 候选向量：\n${lines}`);
    }

    if (picker.picked.length === 0) {
      emit('⚠️ picker 没产出任何可用向量，退化到 serendipity');
      setSurfRunKind(surfConvId, 'serendipity');
      await runSerendipityPath({
        surfConvId, sourceConv, botId, userId,
        model, totalBudget, signal, emit, replyFn,
      });
      return;
    }

    if (picker.blindSpotsNote) {
      emit(`[picker] blind_spots note：${picker.blindSpotsNote}`);
    }

    setSurfRunVectorJson(surfConvId, JSON.stringify(picker.picked));

    // Record one row per picked vector for dedup.
    for (const v of picker.picked) {
      try {
        recordSurfVector({
          id: randomUUID(),
          userId, botId, surfConvId,
          vectorHash: vectorHash(v.topic, v.mode),
          topic: v.topic, mode: v.mode,
          whyNow: v.why_now,
          freshnessWindow: v.freshness_window,
          wasOverride: !!vectorOverride,
        });
      } catch (e: any) {
        console.warn('[surf] recordSurfVector failed:', e?.message ?? e);
      }
    }

    // Split budget across pickers: synthesizer gets a small fixed reserve;
    // diggers split the rest evenly.
    const synthReserve = 0; // synthesizer doesn't use search tools
    const diggerBudgetTotal = Math.max(1, totalBudget - synthReserve);
    const perDigger = Math.max(2, Math.floor(diggerBudgetTotal / picker.picked.length));
    emit(`启动 digger × ${picker.picked.length}（每个预算 ${perDigger}）`);

    checkAborted(signal);

    const diggerResults = await Promise.all(picker.picked.map(v =>
      runDigger({
        conversationId: surfConvId, model,
        vector: v, knownProfile: picker.knownProfile,
        budget: perDigger,
        emitLog: (c) => emit(c),
        signal,
      })
    ));

    const totalFindings = diggerResults.reduce((n, r) => n + r.findings.length, 0);
    emit(`所有 digger 完成：${totalFindings} 条 finding（共 ${diggerResults.reduce((n, r) => n + r.toolCallsUsed, 0)} 次工具调用）`);

    if (totalFindings === 0) {
      emit('⚠️ 所有 digger 都空手而归，跳过 synthesizer');
    }

    checkAborted(signal);

    const synth = await runSynthesizer({
      conversationId: surfConvId, model,
      diggerResults, knownProfile: picker.knownProfile,
      emitLog: (c) => emit(c),
      signal,
    });

    if (synth.droppedIndices.length > 0) {
      const list = synth.droppedIndices.map(d => `  ${d.index}: ${d.reason}`).join('\n');
      emit(`[synth] dropped:\n${list}`);
    }

    await deliverFinalMessage({
      surfConvId, surfConv, sourceConv,
      finalMsg: synth.finalMessage, replyFn, emit,
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

// Periodic blind-wander slot. Mirrors the original planner+wanderer+curator
// pipeline so we keep the cross-domain bridge style alive at low frequency.
async function runSerendipityPath(params: {
  surfConvId: string;
  sourceConv: any | null;
  botId: string;
  userId: string;
  model: string;
  totalBudget: number;
  signal: AbortSignal | undefined;
  emit: (c: string, type?: string) => void;
  replyFn: (msg: OutboundMessage) => void;
}): Promise<void> {
  const { surfConvId, sourceConv, botId, userId, model, totalBudget, signal, emit, replyFn } = params;

  const curatorReserve = Math.max(2, Math.floor(totalBudget * 0.25));
  const wandererBudget = Math.max(1, totalBudget - curatorReserve);
  emit(`[serendipity] wanderer 预算 ${wandererBudget}，curator 保底 ≥${curatorReserve}`);

  const plannerConvId = sourceConv?.id ?? surfConvId;
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

  if (plan.blind_spots) emit(`[planner] 盲区：${plan.blind_spots}`);
  if (plan.needs) emit(`[planner] 需要：${plan.needs}`);
  const kp = plan.known_profile;
  if (kp.topics_covered.length > 0) emit(`[planner] 已聊主题：${kp.topics_covered.join('、')}`);
  if (kp.open_questions.length > 0) emit(`[planner] 未解问题：${kp.open_questions.join('、')}`);

  emit(`[wanderer] 完成：${wanderResult.findings.length} 条`);

  if (!plan.blind_spots && kp.topics_covered.length === 0 && wanderResult.findings.length === 0) {
    emit('⚠️ planner 输出不足、wanderer 也没收获，放弃本次冲浪');
    setSurfRunStatus(surfConvId, 'done');
    return;
  }

  checkAborted(signal);
  const curatorBudget = Math.max(curatorReserve, totalBudget - wanderResult.toolCallsUsed);
  const curatorResult = await runCurator({
    conversationId: surfConvId, model,
    plan, rawFindings: wanderResult.findings,
    budget: curatorBudget,
    emitLog: (c) => emit(c),
    signal,
  });

  if (curatorResult.bridges.length > 0) {
    const bridgesText = curatorResult.bridges.map((b, i) =>
      `  ${i + 1}. "${b.finding}" ↔ "${b.user_interest}"\n     → ${b.connection}`,
    ).join('\n');
    emit(`🌉 bridges (${curatorResult.bridges.length}):\n${bridgesText}`, 'surf_bridges');
  }

  await deliverFinalMessage({
    surfConvId,
    surfConv: findConversationById(surfConvId),
    sourceConv,
    finalMsg: curatorResult.finalMessage,
    replyFn, emit,
  });

  setSurfRunStatus(surfConvId, 'done');
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
