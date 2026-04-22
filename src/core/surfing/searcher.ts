import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { configManager } from '../../config/loader';
import { findConversationById, insertMessage } from '../../db/queries';
import { runPlanner } from './planner';
import { runWanderer } from './wanderer';
import { runCurator } from './curator';
import type { OutboundMessage } from '../../bus/types';

// Keyed by conversationId — multiple conversations under the same bot can
// surf concurrently, and each one is cancellable independently.
export const surfEvents = new EventEmitter();
export const activeSurfs = new Map<string, AbortController>();

export type SurfTrigger = 'auto' | 'user';

export function stopSurf(conversationId: string): boolean {
  const controller = activeSurfs.get(conversationId);
  if (controller) {
    controller.abort();
    activeSurfs.delete(conversationId);
    return true;
  }
  return false;
}

function makeEmitter(botId: string, conversationId: string) {
  return (content: string, type: string = 'surf_status') => {
    surfEvents.emit('log', {
      botId, conversationId, type, content, timestamp: Date.now(),
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

export async function runSurf(
  conversationId: string,
  botId: string,
  userId: string,
  replyFn: (msg: OutboundMessage) => void,
  signal?: AbortSignal,
  trigger: SurfTrigger = 'auto',
): Promise<void> {
  const emit = makeEmitter(botId, conversationId);

  try {
    emit(`Surfing triggered (${trigger})`);

    const conv = findConversationById(conversationId);
    if (!conv) {
      emit('会话不存在，退出');
      return;
    }

    const botConfig = configManager.getBotConfig(botId);
    if (!botConfig.surfing.enabled) {
      emit('该 bot 未启用 surfing，退出');
      return;
    }

    const model = configManager.get().openrouter.surfingModel ?? botConfig.model;
    const totalBudget = botConfig.surfing.maxRequests;

    // Reserve budget for curator: at least 2, or up to 25% of total, whichever is larger.
    // Wanderer gets the remainder; curator gets whatever wanderer doesn't spend + its reserve.
    const curatorReserve = Math.max(2, Math.floor(totalBudget * 0.25));
    const wandererBudget = Math.max(1, totalBudget - curatorReserve);

    emit(`预算：总 ${totalBudget}，wanderer 上限 ${wandererBudget}，curator 保底 ≥${curatorReserve}`);

    // Phase 1+2: planner and wanderer run in parallel.
    //   - planner reads user's long history to extract known_profile / blind_spots
    //   - wanderer roams the internet with NO user context (aimless serendipity)
    checkAborted(signal);
    emit('启动 planner 和 wanderer（并行）');

    const [plan, wanderResult] = await Promise.all([
      runPlanner({
        conversationId, botId, userId, model,
        emitLog: (c) => emit(`[planner] ${c}`),
        signal,
      }),
      runWanderer({
        conversationId, model,
        budget: wandererBudget,
        emitLog: (c) => emit(c),  // wanderer already prefixes its logs
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

    if (!plan.blind_spots && kp.topics_covered.length === 0) {
      emit('⚠️ planner 输出不足，放弃本次冲浪');
      return;
    }

    // Phase 3: curator — has user context, filters wanderer's haul, synthesizes message
    checkAborted(signal);
    const curatorBudget = Math.max(curatorReserve, totalBudget - wanderResult.toolCallsUsed);
    emit(`启动 curator，预算 ${curatorBudget} 次`);

    const curatorResult = await runCurator({
      conversationId, model,
      plan, rawFindings: wanderResult.findings,
      budget: curatorBudget,
      emitLog: (c) => emit(c),  // curator prefixes its logs
      signal,
    });

    emit(`[curator] 完成：${curatorResult.turns} 轮，${curatorResult.toolCallsUsed}/${curatorBudget} 次工具`);

    // Bridges — the headline deliverable
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
      emit('⚠️ curator 未产出最终消息，放弃交付');
      return;
    }

    // Persist as a bot message so it shows up in the conversation transcript
    // and survives reloads, same as review.ts does for corrections.
    const msgId = randomUUID();
    insertMessage(msgId, conversationId, 'bot', botId, finalMsg);
    replyFn({
      type: 'message',
      conversationId,
      messageId: msgId,
      content: finalMsg,
    });
    // Also keep a surf_result log on the monitor panel's SSE stream.
    emit(finalMsg, 'surf_result');
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      emit('已中断');
      return;
    }
    throw e;
  } finally {
    activeSurfs.delete(conversationId);
    surfEvents.emit('done', { botId, conversationId, timestamp: Date.now() });
  }
}
