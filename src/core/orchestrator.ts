import { randomUUID } from 'crypto';
import { configManager } from '../config/loader';
import { chatCompletionStream } from '../llm/client';
import { streamWithSplit, type StreamMeta } from '../llm/stream';
import { logAudit } from '../llm/audit';
import { buildPrompt } from './prompt-builder';
import { checkSilent } from './silent';
import {
  insertMessage, updateConversationRound, updateConversationActivity,
  resetSurfInterval, findConversationById,
} from '../db/queries';
import type { OutboundMessage } from '../bus/types';

// Interrupt tracking: when a new user message arrives during generation,
// give the current generation a 2s grace period then drop remaining segments.
const interruptSignals = new Map<string, number>();

export function signalNewMessage(conversationId: string) {
  interruptSignals.set(conversationId, Date.now());
}

function isInterrupted(conversationId: string): boolean {
  const t = interruptSignals.get(conversationId);
  if (!t) return false;
  return (Date.now() - t) >= 2000;
}

export async function handleUserMessage(params: {
  conversationId: string;
  botId: string;
  userId: string;
  mergedContent: string;
  replyFn: (msg: OutboundMessage) => void;
  extraContext?: string;
}): Promise<void> {
  const { conversationId, botId, userId, mergedContent, replyFn, extraContext } = params;
  interruptSignals.delete(conversationId); // clear stale interrupt from triggering message
  const botConfig = configManager.getBotConfig(botId);

  console.log(`\n[chat] ← user(${userId.slice(0, 8)}) → bot(${botId}): ${mergedContent}`);

  // Store user message
  const userMsgId = randomUUID();
  insertMessage(userMsgId, conversationId, 'user', userId, mergedContent);

  // Update round counter
  const conv = findConversationById(conversationId);
  if (conv) {
    let newRound = conv.round_count;
    if (conv.last_sender === 'bot') {
      newRound++;
    }
    updateConversationRound(conversationId, newRound, 'user');
    console.log(`[chat] round: ${newRound}`);

    if (botConfig.surfing.enabled) {
      resetSurfInterval(conversationId, botConfig.surfing.initialIntervalSec);
    }
  }

  // Build prompt
  console.log(`[chat] building prompt...`);
  const messages = await buildPrompt({
    botId,
    conversationId,
    userMessage: mergedContent,
    extraContext,
  });
  console.log(`[chat] prompt: ${messages.length} messages, model: ${botConfig.model}`);

  const messageId = randomUUID();
  const startTime = Date.now();
  const streamMeta: StreamMeta = {};

  try {
    console.log(`[chat] calling LLM...`);
    const { stream } = await chatCompletionStream({
      model: botConfig.model,
      messages,
    });

    let fullOutput = '';
    let silentDetected = false;
    const segments: Map<number, string> = new Map();
    const sentSegments = new Set<number>();
    let earlyBuffer = '';
    let earlyCheckDone = false;

    const rawSegments: string[] = [];
    const onSegmentReady = (segmentIndex: number, fullText: string) => {
      rawSegments[segmentIndex] = fullText;
      const trimmed = fullText.trim();
      if (trimmed) segments.set(segmentIndex, trimmed);
    };

    const sendSegment = (idx: number) => {
      if (sentSegments.has(idx)) return;
      if (isInterrupted(conversationId)) return; // new message arrived, grace expired
      const content = segments.get(idx);
      if (content) {
        sentSegments.add(idx);
        replyFn({
          type: 'message',
          conversationId,
          messageId: idx === 0 ? messageId : randomUUID(),
          content,
        });
      }
    };

    for await (const seg of streamWithSplit(stream, onSegmentReady, streamMeta)) {
      // Check if new message arrived and grace period expired
      if (isInterrupted(conversationId)) {
        console.log(`[chat] interrupted by new message, stopping generation`);
        break;
      }

      fullOutput += seg.delta;

      // Early [SILENT] detection
      if (!earlyCheckDone) {
        earlyBuffer += seg.delta;
        if (earlyBuffer.length >= 10) {
          earlyCheckDone = true;
          if (checkSilent(earlyBuffer).isSilent) {
            silentDetected = true;
            break;
          }
        }
      }

      // When a segment boundary is hit, immediately send completed segments
      if (seg.isNewSegment) {
        for (const [idx] of segments) {
          sendSegment(idx);
        }
      }
    }

    // Check [SILENT]
    if (!silentDetected && checkSilent(fullOutput).isSilent) {
      silentDetected = true;
    }

    const latencyMs = Date.now() - startTime;

    // Log raw output with escape sequences visible
    const rawModelOutput = rawSegments.join('|||');
    console.log(`[chat] → raw (${latencyMs}ms): ${JSON.stringify(rawModelOutput)}`);

    if (silentDetected) {
      console.log(`[chat] → [SILENT]`);
      updateConversationActivity(conversationId);
      logAudit({
        conversationId, taskType: 'chat', model: botConfig.model,
        inputTokens: streamMeta.usage?.prompt_tokens ?? 0,
        outputTokens: streamMeta.usage?.completion_tokens ?? 0,
        totalTokens: streamMeta.usage?.total_tokens ?? 0,
        costUsd: streamMeta.usage?.cost,
        generationId: streamMeta.generationId,
        latencyMs,
      });
      return;
    }

    // If no segments from the splitter, treat full output as one message
    if (segments.size === 0 && fullOutput.trim()) {
      segments.set(0, fullOutput.trim());
    }

    // Send any unsent segments (sendSegment checks interrupt)
    for (const [idx] of segments) {
      sendSegment(idx);
    }

    const wasInterrupted = interruptSignals.has(conversationId);
    if (wasInterrupted) {
      console.log(`[chat] → interrupted, sent ${sentSegments.size}/${segments.size} segments`);
    } else {
      console.log(`[chat] → sent ${segments.size} messages`);
    }

    // Store bot messages — only those actually sent to the user
    for (const idx of sentSegments) {
      const content = segments.get(idx);
      if (!content) continue;
      const segMsgId = idx === 0 ? messageId : randomUUID();
      insertMessage(segMsgId, conversationId, 'bot', botId, content, idx);
    }

    // Update conversation sender only if we actually sent something
    if (sentSegments.size > 0) {
      const freshConv = findConversationById(conversationId);
      updateConversationRound(conversationId, freshConv?.round_count ?? 0, 'bot');
    }

    logAudit({
      conversationId, taskType: 'chat', model: botConfig.model,
      inputTokens: streamMeta.usage?.prompt_tokens ?? 0,
      outputTokens: streamMeta.usage?.completion_tokens ?? 0,
      totalTokens: streamMeta.usage?.total_tokens ?? 0,
      generationId: streamMeta.generationId,
      latencyMs,
    });

    // Check review
    if (botConfig.review.enabled) {
      const updatedConv = findConversationById(conversationId);
      if (updatedConv && updatedConv.round_count > 0 &&
          updatedConv.round_count % botConfig.review.roundInterval === 0) {
        console.log(`[review] triggering at round ${updatedConv.round_count}`);
        const { checkAndTriggerReview } = await import('./review');
        checkAndTriggerReview(conversationId, botId, replyFn).catch(e =>
          console.error('[review] error:', e)
        );
      }
    }

  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    console.error(`[chat] ✗ LLM error (${latencyMs}ms):`, err.message ?? err);
    logAudit({
      conversationId, taskType: 'chat', model: botConfig.model,
      inputTokens: streamMeta.usage?.prompt_tokens ?? 0,
      outputTokens: streamMeta.usage?.completion_tokens ?? 0,
      totalTokens: streamMeta.usage?.total_tokens ?? 0,
      generationId: streamMeta.generationId,
      latencyMs,
    });
    throw err;
  }
}
