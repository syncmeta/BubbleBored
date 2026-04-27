import { randomUUID } from 'crypto';
import { configManager } from '../config/loader';
import { chatCompletionStream } from '../llm/client';
import { streamWithSplit, type StreamMeta } from '../llm/stream';
import { logAudit } from '../llm/audit';
import { buildPrompt, type ChatTone } from './prompt-builder';
import { checkSilent } from './silent';
import { augmentWithWebSearch } from './search/augment';
import {
  insertMessage, updateConversationRound, updateConversationActivity,
  resetSurfInterval, findConversationById, bindAttachmentsToMessage,
  getAttachmentsForMessage,
} from '../db/queries';
import { recordUserMessage, recordBotMessage } from '../honcho/memory';
import { modelFor } from './models';
import { checkAndTriggerReview } from './review';
import { generateTitle } from './title';
import type { OutboundMessage } from '../bus/types';

// Interrupt tracking: when a new user message arrives during generation,
// give the current generation a 2s grace period then drop remaining segments.
// The stored value is the ms timestamp at which the signal was raised; callers
// pass the generation's own start time so older signals (from before this gen
// began) are ignored rather than being wiped at entry — that prevented the
// race where a signalNewMessage landed just before handleUserMessage's entry
// clear and got silently discarded.
const interruptSignals = new Map<string, number>();

export function signalNewMessage(conversationId: string) {
  interruptSignals.set(conversationId, Date.now());
}

function isInterrupted(conversationId: string, genStartedAt: number): boolean {
  const t = interruptSignals.get(conversationId);
  if (!t || t < genStartedAt) return false;
  return (Date.now() - t) >= 2000;
}

function hasFreshInterrupt(conversationId: string, genStartedAt: number): boolean {
  const t = interruptSignals.get(conversationId);
  return t !== undefined && t >= genStartedAt;
}

// Counts how many handleUserMessage calls are currently running for a given
// conversation. The counter alone isn't enough to prevent flicker across an
// interrupt handoff, because the old call ends (counter 1→0) before the new
// call begins (0→1) — debounce and the typing gate sit between them. So we
// also hold the "off" signal whenever there's an outstanding interrupt signal
// (= a new user message is pending) and cancel the hold when beginTyping is
// called next. A safety timer ensures we never leave the indicator stuck.
const activeGenerations = new Map<string, number>();
const pendingTypingOff = new Map<string, Timer>();
const TYPING_HANDOFF_SAFETY_MS = 30_000;

function beginTyping(conversationId: string, replyFn: (msg: OutboundMessage) => void) {
  // A new generation is starting — cancel any "off" signal we were holding.
  const pending = pendingTypingOff.get(conversationId);
  if (pending) {
    clearTimeout(pending);
    pendingTypingOff.delete(conversationId);
  }
  const prev = activeGenerations.get(conversationId) ?? 0;
  activeGenerations.set(conversationId, prev + 1);
  if (prev === 0) {
    // Redundant emits while already-on are harmless (client ignores same state).
    replyFn({ type: 'bot_typing', conversationId, active: true });
  }
}

function endTyping(
  conversationId: string,
  replyFn: (msg: OutboundMessage) => void,
  genStartedAt: number,
) {
  const next = (activeGenerations.get(conversationId) ?? 0) - 1;
  if (next > 0) {
    activeGenerations.set(conversationId, next);
    return;
  }
  activeGenerations.delete(conversationId);

  // If an interrupt signal fresher than this gen is present, a new user
  // message is pending and a new generation is imminent. Hold the "off" so
  // the UI doesn't flicker. beginTyping will cancel this timer when the new
  // gen starts; otherwise the safety timer fires after 30s.
  if (hasFreshInterrupt(conversationId, genStartedAt)) {
    const prev = pendingTypingOff.get(conversationId);
    if (prev) clearTimeout(prev);
    pendingTypingOff.set(conversationId, setTimeout(() => {
      pendingTypingOff.delete(conversationId);
      if ((activeGenerations.get(conversationId) ?? 0) === 0) {
        replyFn({ type: 'bot_typing', conversationId, active: false });
      }
    }, TYPING_HANDOFF_SAFETY_MS));
    return;
  }

  replyFn({ type: 'bot_typing', conversationId, active: false });
}

// One user send = one PendingEntry = one DB row. Multiple entries accumulate
// when the debounce window merges rapid-fire sends — storage + display stay
// per-entry; only the prompt-builder collapses consecutive user rows into a
// single API message joined by \n\n.
export interface UserMessageEntry {
  content: string;
  attachmentIds?: string[];
}

export async function handleUserMessage(params: {
  conversationId: string;
  botId: string;
  userId: string;
  // At least one entry when !regenerate. Ignored on regenerate (the caller
  // has already rewound the transcript to the edit point).
  userMessages: UserMessageEntry[];
  replyFn: (msg: OutboundMessage) => void;
  extraContext?: string;
  // Per-message tone choice from the client. Defaults to 'wechat' when
  // omitted so existing channels (Telegram/Feishu) keep their current
  // behaviour.
  tone?: ChatTone;
  // 联网搜索: when true, run a one-shot Jina search_web on the user's text
  // before the LLM call and inject the result as extra system context. The
  // search activity is reported live via surf_status so the chat shows a
  // "searching…" log above the bot reply (reuses the existing surf-log UI).
  webSearch?: boolean;
  // Re-run the LLM for an existing user message without inserting a new row,
  // binding attachments, or bumping the round counter. The caller is
  // responsible for having already deleted the stale bot reply(ies) from DB.
  regenerate?: boolean;
}): Promise<void> {
  const { conversationId, botId, userId, userMessages, replyFn, extraContext: extraContextIn, tone, webSearch, regenerate } = params;
  let extraContext = extraContextIn;
  // Per-gen start timestamp — isInterrupted/hasFreshInterrupt ignore signals
  // raised before this, so we don't need to wipe the map at entry and can't
  // accidentally swallow a just-arrived signal.
  const genStartedAt = Date.now();
  const botConfig = configManager.getBotConfig(botId);

  const totalAtt = userMessages.reduce((n, e) => n + (e.attachmentIds?.length ?? 0), 0);
  const previewJoined = userMessages.map(e => e.content).filter(Boolean).join(' ‖ ');
  console.log(`\n[chat] ${regenerate ? '↻ regen' : '←'} user(${userId.slice(0, 8)}) → bot(${botId}): ${previewJoined}${totalAtt ? ` [+${totalAtt} attachment(s)]` : ''}`);

  // Start the typing indicator as early as possible — it covers prompt
  // building + LLM call + segment streaming. The counter in end/beginTyping
  // handles the interrupt handoff, so we never flicker off between two
  // back-to-back generations for the same conversation.
  beginTyping(conversationId, replyFn);
  try {

  if (!regenerate) {
    // One DB row per entry — preserves the user's message granularity across
    // refresh and keeps each bubble addressable for edit/regenerate/delete.
    for (const entry of userMessages) {
      const userMsgId = randomUUID();
      insertMessage(userMsgId, conversationId, 'user', userId, entry.content);
      recordUserMessage({ userId, conversationId, content: entry.content });

      const atts = entry.attachmentIds ?? [];
      if (atts.length > 0) {
        // bindAttachmentsToMessage rejects ids whose conversation doesn't
        // match — an attacker passing someone else's upload id silently fails
        // rather than leaking pixels.
        const bound = bindAttachmentsToMessage(atts, userMsgId, conversationId);
        if (bound !== atts.length) {
          console.warn(`[chat] attachments: requested ${atts.length}, bound ${bound} (others rejected — stale/foreign id?)`);
        }
        // Echo a dedicated user_message_ack so the client can reconcile its
        // optimistic local render (blob URL previews) with the server-assigned
        // message id + canonical /uploads/<id> URLs.
        const attSummaries = getAttachmentsForMessage(userMsgId).map(a => ({
          id: a.id, kind: a.kind, mime: a.mime, size: a.size,
          width: a.width, height: a.height, url: `/uploads/${a.id}`,
        }));
        replyFn({
          type: 'user_message_ack',
          conversationId,
          messageId: userMsgId,
          content: entry.content,
          metadata: { attachments: attSummaries, attachmentIds: atts },
        });
      }
    }

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
  }

  // 联网搜索: run search BEFORE building the prompt so findings are part
  // of the same system message. Result merges into extraContext (if the
  // caller already passed something, the search block is appended after).
  if (webSearch && userMessages.length > 0) {
    const queryText = userMessages.map(e => e.content).filter(Boolean).join('\n').trim();
    if (queryText) {
      const augment = await augmentWithWebSearch({
        userId, conversationId, query: queryText,
        emitLog: (content) => replyFn({ type: 'surf_status', conversationId, content }),
      });
      if (augment.context) {
        extraContext = extraContext
          ? `${extraContext}\n\n${augment.context}`
          : augment.context;
      }
    }
  }

  // Build prompt
  console.log(`[chat] building prompt...`);
  const messages = await buildPrompt({
    botId,
    conversationId,
    userId,
    extraContext,
    tone,
  });
  const chatModel = modelFor(botId, conversationId);
  console.log(`[chat] prompt: ${messages.length} messages, model: ${chatModel}`);

  const messageId = randomUUID();
  const startTime = Date.now();
  const streamMeta: StreamMeta = {};

  try {
    console.log(`[chat] calling LLM...`);
    const { stream } = await chatCompletionStream({
      model: chatModel,
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
      if (isInterrupted(conversationId, genStartedAt)) return; // new message arrived, grace expired
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

    for await (const seg of streamWithSplit(stream, onSegmentReady, streamMeta, { disableSplit: tone === 'normal' })) {
      // Check if new message arrived and grace period expired
      if (isInterrupted(conversationId, genStartedAt)) {
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
    const rawModelOutput = rawSegments.join('\n\n');
    console.log(`[chat] → raw (${latencyMs}ms): ${JSON.stringify(rawModelOutput)}`);

    if (silentDetected) {
      console.log(`[chat] → [SILENT]`);
      updateConversationActivity(conversationId);
      logAudit({
        userId, conversationId, taskType: 'chat', model: botConfig.model,
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

    const wasInterrupted = hasFreshInterrupt(conversationId, genStartedAt);
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
      recordBotMessage({ botId, conversationId, content });
    }

    // Update conversation sender only if we actually sent something
    if (sentSegments.size > 0) {
      const freshConv = findConversationById(conversationId);
      updateConversationRound(conversationId, freshConv?.round_count ?? 0, 'bot');
    }

    logAudit({
      userId, conversationId, taskType: 'chat', model: botConfig.model,
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
        checkAndTriggerReview(conversationId, botId, replyFn).catch(e =>
          console.error('[review] error:', e)
        );
      }
    }

    // Auto-title:
    //   - Initial: fire whenever the conversation has no title yet and we
    //     sent a bot reply. generateTitle re-checks internally, so failed
    //     calls self-heal on the next reply.
    //   - Refresh: every 3 rounds (round_count = 3, 6, 9, …) force a
    //     regeneration so the title tracks where the conversation has drifted.
    const finalConv = findConversationById(conversationId);
    if (finalConv && sentSegments.size > 0) {
      const currentTitle = finalConv.title?.trim() ?? '';
      const isEmpty = currentTitle.length === 0;
      const isRefreshRound = finalConv.round_count > 0 && finalConv.round_count % 3 === 0;
      if (isEmpty || isRefreshRound) {
        const mode = isRefreshRound && !isEmpty ? 'refresh' : 'initial';
        console.log(`[title] triggering ${mode} for conv ${conversationId.slice(0, 8)} (round ${finalConv.round_count})`);
        generateTitle(conversationId, replyFn, { force: isRefreshRound }).catch(e =>
          console.error('[title] error:', e)
        );
      }
    }

  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    console.error(`[chat] ✗ LLM error (${latencyMs}ms):`, err.message ?? err);
    logAudit({
      userId, conversationId, taskType: 'chat', model: botConfig.model,
      inputTokens: streamMeta.usage?.prompt_tokens ?? 0,
      outputTokens: streamMeta.usage?.completion_tokens ?? 0,
      totalTokens: streamMeta.usage?.total_tokens ?? 0,
      generationId: streamMeta.generationId,
      latencyMs,
    });
    throw err;
  }
  } finally {
    endTyping(conversationId, replyFn, genStartedAt);
  }
}
