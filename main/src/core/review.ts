import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { configManager } from '../config/loader';
import { chatCompletion } from '../llm/client';
import { logAudit } from '../llm/audit';
import {
  findConversationById, getMessages, insertMessage, createConversation,
  createReviewRun, getReviewRun, setReviewRunStatus,
} from '../db/queries';
import { getUserProfile, recordBotMessage } from '../honcho/memory';
import { runSearchLoop } from './search/loop';
import { modelFor } from './models';
import type { OutboundMessage } from '../bus/types';

export const reviewEvents = new EventEmitter();

// Pending correction timers, keyed by review conv id. The timer covers the
// "wait timerMs before delivering" gap that lets a fast follow-up user message
// cancel the correction.
const pendingTimers = new Map<string, Timer>();

// Track which message convs currently have a review running, mirroring the
// surf side. Lets the chat-header review button show busy + prevents pile-up.
export const reviewsByMessageConv = new Map<string, string>(); // msgConvId → reviewConvId

interface SearchBlock {
  need: boolean;
  queries: string[];
  reason: string;
}

function emit(reviewConvId: string, content: string, kind: string = 'status') {
  // Persist as a log message in the review conv
  try {
    insertMessage(randomUUID(), reviewConvId, 'log', `review:${kind}`, content);
  } catch {}
  reviewEvents.emit('log', {
    reviewConvId, conversationId: reviewConvId,
    sourceMessageConvId: getReviewRun(reviewConvId)?.source_message_conv_id ?? null,
    kind, content, timestamp: Date.now(),
  });
}

function extractTag(text: string, tag: string): string {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() ?? '';
}

function parseSearchBlock(text: string): SearchBlock {
  const raw = extractTag(text, '搜索');
  if (!raw) return { need: false, queries: [], reason: '' };
  const json = raw.match(/\{[\s\S]*\}/);
  if (!json) return { need: false, queries: [], reason: '' };
  try {
    const obj = JSON.parse(json[0]);
    return {
      need: !!obj.need,
      queries: Array.isArray(obj.queries) ? obj.queries.filter((q: any) => typeof q === 'string' && q.trim().length > 0) : [],
      reason: typeof obj.reason === 'string' ? obj.reason : '',
    };
  } catch {
    return { need: false, queries: [], reason: '' };
  }
}

// Create a 回顾 tab conversation that records this review run.
export function createReviewConversation(params: {
  botId: string;
  userId: string;
  sourceMessageConvId: string | null;
  modelSlug: string;
  title?: string | null;
}): string {
  const id = randomUUID();
  const title = params.title?.trim() || (params.sourceMessageConvId ? '回顾' : '自由回顾');
  createConversation(id, params.botId, params.userId, title, 'review');
  createReviewRun({
    conversationId: id,
    sourceMessageConvId: params.sourceMessageConvId,
    modelSlug: params.modelSlug,
  });
  return id;
}

export interface RunReviewParams {
  reviewConvId: string;
  sourceConvId?: string | null;
  replyFn: (msg: OutboundMessage) => void;
  trigger?: 'auto' | 'user' | 'panel';
}

export async function runReview(params: RunReviewParams): Promise<void> {
  const { reviewConvId, sourceConvId, replyFn, trigger = 'user' } = params;
  setReviewRunStatus(reviewConvId, 'running');

  try {
    const reviewConv = findConversationById(reviewConvId);
    if (!reviewConv) {
      setReviewRunStatus(reviewConvId, 'error');
      return;
    }
    const run = getReviewRun(reviewConvId);
    if (!run) {
      setReviewRunStatus(reviewConvId, 'error');
      return;
    }

    const effectiveSourceId = sourceConvId ?? run.source_message_conv_id;
    const sourceConv = effectiveSourceId ? findConversationById(effectiveSourceId) : null;

    emit(reviewConvId, `Review triggered (${trigger})`);
    if (sourceConv) {
      emit(reviewConvId, `源会话：${sourceConv.title?.trim() || sourceConv.id.slice(0, 8)}（轮 ${sourceConv.round_count ?? 0}）`);
    } else {
      emit(reviewConvId, '自由回顾（无源会话）— 仅基于本会话历史');
    }

    // Pull the history we'll review. Prefer the source message conv when given.
    const historyConvId = effectiveSourceId ?? reviewConvId;
    const history = getMessages(historyConvId, 30).filter(m => m.sender_type !== 'log');
    if (history.length < 2) {
      emit(reviewConvId, 'Skipped: not enough history', 'skip');
      setReviewRunStatus(reviewConvId, 'done');
      return;
    }
    emit(reviewConvId, `Loaded ${history.length} messages for review`);

    // Long-term profile (best effort)
    let profileText = '';
    try {
      const profile = await getUserProfile(reviewConv.user_id);
      if (profile.card.length > 0 || profile.representation) {
        profileText = `用户画像：\n${profile.card.join('\n')}${profile.representation ? '\n' + profile.representation : ''}`;
      }
    } catch (e: any) {
      console.warn('[review] profile load failed:', e?.message ?? e);
    }

    const reviewPrompt = await configManager.readPrompt('review.md');
    const model = run.model_slug || modelFor('review');
    emit(reviewConvId, `模型：${model}`);

    const historyMessages = history.map((m: any) => ({
      role: (m.sender_type === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content as string,
    }));

    const leadIn = profileText
      ? `${profileText}\n\n（以下是最近的对话历史）`
      : '（以下是最近的对话历史）';

    const messages = [
      { role: 'system' as const, content: reviewPrompt },
      { role: 'user' as const, content: leadIn },
      ...historyMessages,
      { role: 'user' as const, content: '请按系统指令对你上面的发言进行自我审视，同时评估对方现在的处境，按要求的 4 段式输出。' },
    ];

    emit(reviewConvId, 'Calling LLM…');
    const { result, latencyMs, costUsd } = await chatCompletion({ model, messages });

    logAudit({
      conversationId: reviewConvId, taskType: 'review', model,
      inputTokens: result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.completion_tokens ?? 0,
      totalTokens: result.usage?.total_tokens ?? 0,
      costUsd, generationId: result.id, latencyMs,
    });

    const rawText = result.choices[0]?.message?.content?.trim() ?? '';
    emit(reviewConvId, `LLM responded (${latencyMs}ms, ${result.usage?.total_tokens ?? 0} tokens)`);

    const evaluation = extractTag(rawText, '评价');
    const insights = extractTag(rawText, '洞察');
    const search = parseSearchBlock(rawText);
    let conclusion = extractTag(rawText, '结论') || rawText;

    if (evaluation) emit(reviewConvId, `评价:\n${evaluation}`, 'evaluation');
    if (insights && insights !== '无') emit(reviewConvId, `洞察:\n${insights}`, 'insights');

    if (search.need && search.queries.length > 0) {
      emit(reviewConvId, `需要搜索（${search.reason}）:\n${search.queries.map((q, i) => `${i + 1}. ${q}`).join('\n')}`, 'search');

      const botConfig = configManager.getBotConfig(reviewConv.bot_id);
      const { findings } = await runSearchLoop({
        conversationId: reviewConvId,
        model,
        queries: search.queries,
        budget: botConfig.review.maxSearchRequests,
        evalPromptName: 'review-eval.md',
        taskType: 'review_eval',
        emitLog: (c) => emit(reviewConvId, c, 'search'),
      });

      emit(reviewConvId, `搜索完成，收集 ${findings.length} 条发现`);

      const findingsText = findings.length > 0
        ? findings.map(f => `- ${f.content}${f.source ? ` (来源: ${f.source})` : ''}`).join('\n')
        : '（未找到有价值的信息）';

      const finalMessages = [
        { role: 'system' as const, content: reviewPrompt },
        { role: 'user' as const, content: leadIn },
        ...historyMessages,
        { role: 'assistant' as const, content: rawText },
        {
          role: 'user' as const,
          content: [
            '以下是你刚才要求的搜索结果：',
            findingsText,
            '',
            '请基于这些信息给出最终的 <结论>。',
            '只需要输出 <结论>...</结论> 这一段（[OK] 或一句自然口吻的追加消息，不要写"经过审视我发现"这类话）。',
          ].join('\n'),
        },
      ];

      const { result: finalResult, latencyMs: finalLatency, costUsd: finalCost } = await chatCompletion({
        model, messages: finalMessages,
      });

      logAudit({
        conversationId: reviewConvId, taskType: 'review', model,
        inputTokens: finalResult.usage?.prompt_tokens ?? 0,
        outputTokens: finalResult.usage?.completion_tokens ?? 0,
        totalTokens: finalResult.usage?.total_tokens ?? 0,
        costUsd: finalCost, generationId: finalResult.id, latencyMs: finalLatency,
      });

      const finalText = finalResult.choices[0]?.message?.content?.trim() ?? '';
      emit(reviewConvId, `LLM final (${finalLatency}ms, ${finalResult.usage?.total_tokens ?? 0} tokens)`);

      conclusion = extractTag(finalText, '结论') || finalText;
    }

    conclusion = conclusion.trim();
    if (!conclusion || conclusion === '[OK]' || conclusion === '[PENDING]') {
      emit(reviewConvId, '结论: [OK] — no correction needed', 'ok');
      setReviewRunStatus(reviewConvId, 'done');
      reviewEvents.emit('done', {
        reviewConvId, conversationId: reviewConvId,
        sourceMessageConvId: effectiveSourceId,
        result: 'ok', timestamp: Date.now(),
      });
      return;
    }

    emit(reviewConvId, `结论（${sourceConv ? '将追加到源会话' : '只留在本回顾'}）:\n${conclusion}`, 'conclusion');

    // Always store the conclusion as a bot message in the review conv too,
    // so the 回顾 tab view shows the result inline.
    insertMessage(randomUUID(), reviewConvId, 'bot', reviewConv.bot_id, conclusion);

    if (sourceConv) {
      const botConfig = configManager.getBotConfig(reviewConv.bot_id);
      const timer = setTimeout(() => {
        pendingTimers.delete(reviewConvId);
        const msgId = randomUUID();
        insertMessage(msgId, sourceConv.id, 'bot', reviewConv.bot_id, conclusion);
        recordBotMessage({ botId: reviewConv.bot_id, conversationId: sourceConv.id, content: conclusion });
        replyFn({
          type: 'message',
          conversationId: sourceConv.id,
          messageId: msgId,
          content: conclusion,
        });
        emit(reviewConvId, 'Correction sent to source conv', 'delivered');
        setReviewRunStatus(reviewConvId, 'done');
        reviewEvents.emit('done', {
          reviewConvId, conversationId: reviewConvId,
          sourceMessageConvId: sourceConv.id,
          result: 'corrected', timestamp: Date.now(),
        });
      }, botConfig.review.timerMs);
      pendingTimers.set(reviewConvId, timer);
      emit(reviewConvId, `Scheduling correction in ${botConfig.review.timerMs}ms…`);
    } else {
      // Free review: nothing to deliver to. Mark done.
      setReviewRunStatus(reviewConvId, 'done');
      reviewEvents.emit('done', {
        reviewConvId, conversationId: reviewConvId,
        sourceMessageConvId: null,
        result: 'noted', timestamp: Date.now(),
      });
    }
  } catch (e: any) {
    emit(reviewConvId, `⚠️ 出错：${e?.message ?? e}`, 'error');
    setReviewRunStatus(reviewConvId, 'error');
    reviewEvents.emit('done', {
      reviewConvId, conversationId: reviewConvId,
      sourceMessageConvId: null,
      result: 'error', timestamp: Date.now(),
    });
    throw e;
  } finally {
    // Drop the per-message-conv guard if this review was bound to one.
    for (const [msgConv, rConv] of reviewsByMessageConv) {
      if (rConv === reviewConvId) reviewsByMessageConv.delete(msgConv);
    }
  }
}

// Auto / manual entry point from message conv flows: creates a 回顾 tab
// conv pinned to the message conv as source, then runs the review there.
// Replaces the old "review attached to a message conv" behavior.
export async function checkAndTriggerReview(
  messageConvId: string,
  botId: string,
  replyFn: (msg: OutboundMessage) => void,
  manual = false,
): Promise<void> {
  const conv = findConversationById(messageConvId);
  if (!conv) return;

  const botConfig = configManager.getBotConfig(botId);
  if (!botConfig.review.enabled) return;

  if (!manual) {
    if (conv.round_count === 0) return;
    if (conv.round_count % botConfig.review.roundInterval !== 0) return;
  }

  if (reviewsByMessageConv.has(messageConvId)) {
    console.log(`[review] already running for message conv ${messageConvId}`);
    return;
  }

  const reviewConvId = createReviewConversation({
    botId,
    userId: conv.user_id,
    sourceMessageConvId: messageConvId,
    modelSlug: modelFor('review'),
    title: manual ? '回顾' : '自动回顾',
  });
  reviewsByMessageConv.set(messageConvId, reviewConvId);

  await runReview({
    reviewConvId,
    sourceConvId: messageConvId,
    replyFn,
    trigger: manual ? 'user' : 'auto',
  }).catch(e => console.error('[review] error:', e));
}

// Cancel a pending correction timer keyed by the SOURCE message conv id.
// Called when a new user message arrives in the source conv — that's the
// signal that the review's correction is no longer needed.
export function cancelPendingReview(messageConvId: string): void {
  const reviewConvId = reviewsByMessageConv.get(messageConvId);
  if (!reviewConvId) return;
  const timer = pendingTimers.get(reviewConvId);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(reviewConvId);
    emit(reviewConvId, 'Pending correction cancelled (new message arrived)', 'cancelled');
    setReviewRunStatus(reviewConvId, 'done');
    reviewsByMessageConv.delete(messageConvId);
  }
}

export function getPendingReviews(): string[] {
  return Array.from(pendingTimers.keys());
}
