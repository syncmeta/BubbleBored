import { configManager } from '../config/loader';
import { chatCompletion } from '../llm/client';
import { logAudit } from '../llm/audit';
import {
  findConversationById, getMessages, updateConversationTitle,
} from '../db/queries';
import type { OutboundMessage } from '../bus/types';

// Generate a short title for a conversation by summarizing the first few messages.
// Called once per conversation, after the first round (user → bot reply) completes.
// Non-blocking: runs async, swallows errors, never blocks the chat path.
export async function generateTitle(
  conversationId: string,
  replyFn: (msg: OutboundMessage) => void,
): Promise<void> {
  try {
    const conv = findConversationById(conversationId);
    if (!conv) return;
    if (conv.title && conv.title.trim().length > 0) return; // already titled

    const history = getMessages(conversationId, 6);
    if (history.length < 2) return; // need at least one exchange

    const cfg = configManager.get();
    const model = cfg.openrouter.titleModel ?? cfg.openrouter.debounceModel;

    const promptText = await configManager.readPrompt('title.md');

    // Inline the conversation as plain text. The title-generating model is cheap
    // and we want low latency, so we keep the call simple.
    const transcript = history
      .map(m => `${m.sender_type === 'user' ? '用户' : '对方'}: ${m.content}`)
      .join('\n');

    const start = Date.now();
    const { result, latencyMs, costUsd } = await chatCompletion({
      model,
      messages: [
        { role: 'system', content: promptText },
        { role: 'user', content: transcript },
      ],
      max_tokens: 40,
    });

    let title = result.choices[0]?.message?.content?.trim() ?? '';
    // Strip surrounding quotes/whitespace/punctuation the model might add anyway
    title = title.replace(/^["「『《【\s]+|["」』》】\s。．.！!？?]+$/g, '').trim();
    // Cap length defensively
    if (title.length > 40) title = title.slice(0, 40);

    if (!title) {
      console.log(`[title] empty result for conv ${conversationId} (${latencyMs}ms)`);
      return;
    }

    updateConversationTitle(conversationId, title);

    logAudit({
      conversationId,
      taskType: 'title',
      model,
      inputTokens: result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.completion_tokens ?? 0,
      totalTokens: result.usage?.total_tokens ?? 0,
      costUsd,
      generationId: result.id,
      latencyMs,
    });

    console.log(`[title] conv ${conversationId.slice(0, 8)}: "${title}" (${Date.now() - start}ms)`);

    // Notify the client so the sidebar updates without a refresh
    replyFn({
      type: 'title_update',
      conversationId,
      title,
    });
  } catch (e) {
    console.error('[title] generation failed:', e);
  }
}
