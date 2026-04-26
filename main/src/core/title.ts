import { configManager } from '../config/loader';
import { chatCompletion } from '../llm/client';
import { logAudit } from '../llm/audit';
import {
  findConversationById, getMessages, updateConversationTitle,
} from '../db/queries';
import { modelFor } from './models';
import type { OutboundMessage } from '../bus/types';

// Generate (or regenerate) a short title for a conversation by summarizing
// recent messages. Called:
//   - after the first bot reply (self-heals for untitled conversations)
//   - every 3 rounds thereafter (keeps the title fresh as topic drifts)
// Non-blocking: runs async, swallows errors, never blocks the chat path.
export async function generateTitle(
  conversationId: string,
  replyFn: (msg: OutboundMessage) => void,
  opts: { force?: boolean } = {},
): Promise<void> {
  try {
    const conv = findConversationById(conversationId);
    if (!conv) return;
    // force=true skips the "already titled" guard — used by the periodic
    // re-title path so the title can track a drifting conversation.
    if (!opts.force && conv.title && conv.title.trim().length > 0) return;

    // More history for the periodic re-title — the whole point is to reflect
    // where the conversation has moved to, not just the opening exchange.
    const historyLimit = opts.force ? 24 : 6;
    const history = getMessages(conversationId, historyLimit);
    if (history.length < 2) return; // need at least one exchange

    const model = modelFor('title');

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
      // 120 leaves headroom for models that emit <think>…</think> reasoning
      // before the title itself. 40 was barely enough for the title alone.
      max_tokens: 120,
    });

    const raw = result.choices[0]?.message?.content ?? '';
    console.log(`[title] raw (${latencyMs}ms, ${model}): ${JSON.stringify(raw)}`);

    // Some free reasoning models wrap their chain-of-thought in <think>…</think>
    // before the actual answer. Strip that so we don't title the conversation
    // "让我想想用户在说什么".
    let title = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // If only the opening <think> made it through (truncated), keep whatever is
    // after the last closing tag we saw, otherwise fall back to raw.
    if (!title && /<think>/i.test(raw)) {
      const after = raw.split(/<\/think>/i).pop() ?? '';
      title = after.trim();
    }
    // Take just the first non-empty line — title prompts sometimes get a list.
    title = (title.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? '').trim();
    // Strip surrounding quotes/whitespace/punctuation the model might add anyway
    title = title.replace(/^["「『《【\s]+|["」』》】\s。．.！!？?]+$/g, '').trim();
    // Cap length defensively
    if (title.length > 40) title = title.slice(0, 40);

    if (!title) {
      console.log(`[title] empty result for conv ${conversationId} (${latencyMs}ms, model: ${result.model ?? model})`);
      return;
    }

    updateConversationTitle(conversationId, title);

    logAudit({
      userId: conv.user_id,
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
