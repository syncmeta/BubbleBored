import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { configManager } from '../config/loader';
import { chatCompletion } from '../llm/client';
import { logAudit } from '../llm/audit';
import { findConversationById, getMessages, insertMessage } from '../db/queries';
import { getUserProfile, recordBotMessage } from '../honcho/memory';
import { runSearchLoop } from './search/loop';
import type { OutboundMessage } from '../bus/types';

export const reviewEvents = new EventEmitter();
const pendingTimers = new Map<string, Timer>();

interface SearchBlock {
  need: boolean;
  queries: string[];
  reason: string;
}

function emitLog(botId: string, conversationId: string, content: string) {
  reviewEvents.emit('log', { botId, conversationId, content, timestamp: Date.now() });
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

export async function checkAndTriggerReview(
  conversationId: string,
  botId: string,
  replyFn: (msg: OutboundMessage) => void,
  manual = false,
): Promise<void> {
  const conv = findConversationById(conversationId);
  if (!conv) return;

  const botConfig = configManager.getBotConfig(botId);
  if (!botConfig.review.enabled) return;

  if (!manual) {
    if (conv.round_count === 0) return;
    if (conv.round_count % botConfig.review.roundInterval !== 0) return;
  }

  console.log(`[review] triggered for conv ${conversationId} at round ${conv.round_count}`);
  emitLog(botId, conversationId, `Review triggered (round ${conv.round_count})`);

  const history = getMessages(conversationId, 30);
  if (history.length < 2) {
    emitLog(botId, conversationId, 'Skipped: not enough history');
    return;
  }
  emitLog(botId, conversationId, `Loaded ${history.length} messages for review`);

  // Load user profile (new — from surfing)
  let profileText = '';
  try {
    const profile = await getUserProfile(conv.user_id);
    if (profile.card.length > 0 || profile.representation) {
      profileText = `用户画像：\n${profile.card.join('\n')}${profile.representation ? '\n' + profile.representation : ''}`;
    }
  } catch (e: any) {
    console.warn('[review] profile load failed:', e?.message ?? e);
  }

  const reviewPrompt = await configManager.readPrompt('review.md');
  const model = configManager.get().openrouter.reviewModel ?? botConfig.model;

  const historyMessages = history.map(m => ({
    role: (m.sender_type === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: m.content,
  }));

  const leadIn = profileText
    ? `${profileText}\n\n（以下是最近的对话历史）`
    : '（以下是最近的对话历史）';

  const messages = [
    { role: 'system' as const, content: reviewPrompt },
    { role: 'user' as const, content: leadIn },
    ...historyMessages,
    // Anthropic requires the conversation to end with a user turn.
    { role: 'user' as const, content: '请按系统指令对你上面的发言进行自我审视，同时评估对方现在的处境，按要求的 4 段式输出。' },
  ];

  emitLog(botId, conversationId, `Calling LLM (${model})...`);
  const { result, latencyMs, costUsd } = await chatCompletion({ model, messages });

  logAudit({
    conversationId, taskType: 'review', model,
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
    totalTokens: result.usage?.total_tokens ?? 0,
    costUsd,
    generationId: result.id,
    latencyMs,
  });

  const rawText = result.choices[0]?.message?.content?.trim() ?? '';
  console.log(`[review] pass-1 response (${latencyMs}ms):\n---\n${rawText}\n---`);
  emitLog(botId, conversationId, `LLM responded (${latencyMs}ms, ${result.usage?.total_tokens ?? 0} tokens)`);

  const evaluation = extractTag(rawText, '评价');
  const insights = extractTag(rawText, '洞察');
  const search = parseSearchBlock(rawText);
  let conclusion = extractTag(rawText, '结论') || rawText;

  if (evaluation) emitLog(botId, conversationId, `评价:\n${evaluation}`);
  if (insights && insights !== '无') emitLog(botId, conversationId, `洞察:\n${insights}`);

  // Search path (optional)
  if (search.need && search.queries.length > 0) {
    emitLog(botId, conversationId, `需要搜索（${search.reason}）:\n${search.queries.map((q, i) => `${i + 1}. ${q}`).join('\n')}`);

    const { findings } = await runSearchLoop({
      conversationId,
      model,
      queries: search.queries,
      budget: botConfig.review.maxSearchRequests,
      evalPromptName: 'review-eval.md',
      taskType: 'review_eval',
      emitLog: (content) => emitLog(botId, conversationId, content),
    });

    emitLog(botId, conversationId, `搜索完成，收集 ${findings.length} 条发现`);

    // Second LLM call to produce final conclusion given findings
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
      conversationId, taskType: 'review', model,
      inputTokens: finalResult.usage?.prompt_tokens ?? 0,
      outputTokens: finalResult.usage?.completion_tokens ?? 0,
      totalTokens: finalResult.usage?.total_tokens ?? 0,
      costUsd: finalCost,
      generationId: finalResult.id,
      latencyMs: finalLatency,
    });

    const finalText = finalResult.choices[0]?.message?.content?.trim() ?? '';
    console.log(`[review] pass-2 response (${finalLatency}ms):\n---\n${finalText}\n---`);
    emitLog(botId, conversationId, `LLM final (${finalLatency}ms, ${finalResult.usage?.total_tokens ?? 0} tokens)`);

    conclusion = extractTag(finalText, '结论') || finalText;
  }

  // Normalize & act on conclusion
  conclusion = conclusion.trim();
  if (!conclusion || conclusion === '[OK]' || conclusion === '[PENDING]') {
    console.log(`[review] all good, no correction needed`);
    emitLog(botId, conversationId, '结论: [OK] — no correction needed');
    reviewEvents.emit('done', { botId, conversationId, result: 'ok', timestamp: Date.now() });
    return;
  }

  const reviewText = conclusion;
  emitLog(botId, conversationId, `结论（将追加）:\n${reviewText}`);

  console.log(`[review] scheduling correction in ${botConfig.review.timerMs}ms...`);
  emitLog(botId, conversationId, `Scheduling correction in ${botConfig.review.timerMs}ms...`);

  const timer = setTimeout(() => {
    pendingTimers.delete(conversationId);
    const msgId = randomUUID();
    insertMessage(msgId, conversationId, 'bot', botId, reviewText);
    recordBotMessage({ botId, conversationId, content: reviewText });
    replyFn({
      type: 'message',
      conversationId,
      messageId: msgId,
      content: reviewText,
    });
    console.log(`[review] sent correction for conv ${conversationId}`);
    emitLog(botId, conversationId, 'Correction sent to user');
    reviewEvents.emit('done', { botId, conversationId, result: 'corrected', timestamp: Date.now() });
  }, botConfig.review.timerMs);

  pendingTimers.set(conversationId, timer);
}

export function cancelPendingReview(conversationId: string): void {
  const timer = pendingTimers.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(conversationId);
    console.log(`[review] cancelled pending correction (new message arrived)`);
    reviewEvents.emit('log', { botId: '', conversationId, content: 'Pending correction cancelled (new message arrived)', timestamp: Date.now() });
  }
}

export function getPendingReviews(): string[] {
  return Array.from(pendingTimers.keys());
}
