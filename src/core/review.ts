import { randomUUID } from 'crypto';
import { configManager } from '../config/loader';
import { chatCompletion } from '../llm/client';
import { logAudit } from '../llm/audit';
import { findConversationById, getMessages, insertMessage } from '../db/queries';
import type { OutboundMessage } from '../bus/types';

const pendingTimers = new Map<string, Timer>();

export async function checkAndTriggerReview(
  conversationId: string,
  botId: string,
  replyFn: (msg: OutboundMessage) => void,
): Promise<void> {
  const conv = findConversationById(conversationId);
  if (!conv) return;

  const botConfig = configManager.getBotConfig(botId);
  if (!botConfig.review.enabled) return;
  if (conv.round_count === 0) return;
  if (conv.round_count % botConfig.review.roundInterval !== 0) return;

  console.log(`[review] triggered for conv ${conversationId} at round ${conv.round_count}`);

  // Get recent history
  const history = getMessages(conversationId, 30);
  if (history.length < 2) return;

  const reviewPrompt = await configManager.readPrompt('review.md');
  const model = configManager.get().openrouter.reviewModel ?? botConfig.model;

  const messages = [
    { role: 'system' as const, content: reviewPrompt },
    ...history.map(m => ({
      role: (m.sender_type === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content,
    })),
  ];

  console.log(`[review] calling LLM (model: ${model})...`);
  const { result, latencyMs } = await chatCompletion({ model, messages });

  logAudit({
    conversationId, taskType: 'review', model,
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
    totalTokens: result.usage?.total_tokens ?? 0,
    latencyMs,
  });

  const reviewText = result.choices[0]?.message?.content?.trim();
  console.log(`[review] result (${latencyMs}ms):\n---\n${reviewText}\n---`);
  if (!reviewText || reviewText === '[OK]') {
    console.log(`[review] all good, no correction needed`);
    return;
  }

  // Start timer to proactively send correction
  console.log(`[review] scheduling correction in ${botConfig.review.timerMs}ms...`);
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
  }, botConfig.review.timerMs);

  pendingTimers.set(conversationId, timer);
}

export function cancelPendingReview(conversationId: string): void {
  const timer = pendingTimers.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(conversationId);
    console.log(`[review] cancelled pending correction (new message arrived)`);
  }
}
