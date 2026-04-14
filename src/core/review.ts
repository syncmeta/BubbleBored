import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { configManager } from '../config/loader';
import { chatCompletion } from '../llm/client';
import { logAudit } from '../llm/audit';
import { findConversationById, getMessages, insertMessage } from '../db/queries';
import type { OutboundMessage } from '../bus/types';

export const reviewEvents = new EventEmitter();
const pendingTimers = new Map<string, Timer>();

function emitLog(botId: string, conversationId: string, content: string) {
  reviewEvents.emit('log', { botId, conversationId, content, timestamp: Date.now() });
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

  // Get recent history
  const history = getMessages(conversationId, 30);
  if (history.length < 2) {
    emitLog(botId, conversationId, 'Skipped: not enough history');
    return;
  }

  emitLog(botId, conversationId, `Loaded ${history.length} messages for review`);

  const reviewPrompt = await configManager.readPrompt('review.md');
  const model = configManager.get().openrouter.reviewModel ?? botConfig.model;

  const messages = [
    { role: 'system' as const, content: reviewPrompt },
    ...history.map(m => ({
      role: (m.sender_type === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content,
    })),
    // Anthropic requires the conversation to end with a user turn.
    // Review history typically ends with the bot's last reply, so append a
    // trailing user prompt that asks the model to produce the review output.
    { role: 'user' as const, content: '请按系统指令对你上面的发言进行自我审视与回顾，按要求输出。' },
  ];

  emitLog(botId, conversationId, `Calling LLM (${model})...`);
  console.log(`[review] calling LLM (model: ${model})...`);
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

  const reviewText = result.choices[0]?.message?.content?.trim();
  console.log(`[review] result (${latencyMs}ms):\n---\n${reviewText}\n---`);

  emitLog(botId, conversationId, `LLM responded (${latencyMs}ms, ${result.usage?.total_tokens ?? 0} tokens)`);

  if (!reviewText || reviewText === '[OK]') {
    console.log(`[review] all good, no correction needed`);
    emitLog(botId, conversationId, 'Result: [OK] — no correction needed');
    reviewEvents.emit('done', { botId, conversationId, result: 'ok', timestamp: Date.now() });
    return;
  }

  emitLog(botId, conversationId, `Correction found:\n${reviewText}`);

  // Start timer to proactively send correction
  console.log(`[review] scheduling correction in ${botConfig.review.timerMs}ms...`);
  emitLog(botId, conversationId, `Scheduling correction in ${botConfig.review.timerMs}ms...`);

  const timer = setTimeout(() => {
    pendingTimers.delete(conversationId);
    // Send proactive message
    const msgId = randomUUID();
    insertMessage(msgId, conversationId, 'bot', botId, reviewText);
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
