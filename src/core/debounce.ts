import { configManager } from '../config/loader';
import { chatCompletion } from '../llm/client';
import { logAudit } from '../llm/audit';
import { addToDebounceBuffer, clearDebounceBuffer } from '../db/queries';
import { typedSince } from './typing';
import type { OutboundMessage } from '../bus/types';

// Debounce has two independent gates, both must resolve before flushing:
//
//   1. Judge gate  — the existing LLM judge (WAIT / FLUSH). Fires immediately
//                    on message arrival, does NOT wait for the typing gate.
//   2. Typing gate — behavioral debounce based on the user's input activity:
//        - T=0 (message arrival): start a 2s "initial" wait.
//        - At T=2s: if user has typed anything since T=0, enter a 5s window;
//                   else resolve immediately.
//        - At the end of each 5s window: if the user typed during that window,
//                   open another 5s window (up to 2 extensions, so base+ext1+ext2
//                   = 15s of typing windows, 17s total including initial).
//                   Else resolve.
//
// A hard timeout still exists as a safety net and bypasses both gates.

const INITIAL_TYPING_WAIT_MS = 2000;
const TYPING_WINDOW_MS = 5000;
const MAX_TYPING_EXTENSIONS = 2; // base + 2 extensions = 3 × 5s

interface DebounceState {
  hardTimer: Timer | null;
  pendingMessages: string[];
  // Flat list of all attachment ids accumulated across messages in this
  // debounce window — they all end up bound to the single merged user row.
  pendingAttachmentIds: string[];
  processing: boolean;       // judge is in flight
  judgeReady: boolean;       // judge resolved to FLUSH (or errored)
  typingReady: boolean;      // typing gate resolved
  typingTimer: Timer | null; // current typing-gate setTimeout handle
  typingExtensions: number;  // how many 5s extensions have been consumed
  typingAnchorAt: number;    // arrival time of the message that armed the gate
  onReady: FlushHandler | null;
}

const states = new Map<string, DebounceState>();

function getState(conversationId: string): DebounceState {
  let s = states.get(conversationId);
  if (!s) {
    s = {
      hardTimer: null,
      pendingMessages: [],
      pendingAttachmentIds: [],
      processing: false,
      judgeReady: false,
      typingReady: false,
      typingTimer: null,
      typingExtensions: 0,
      typingAnchorAt: 0,
      onReady: null,
    };
    states.set(conversationId, s);
  }
  return s;
}

export type FlushHandler = (mergedContent: string, attachmentIds: string[]) => void;

export function addMessage(
  conversationId: string,
  botId: string,
  userId: string,
  content: string,
  attachmentIds: string[] | undefined,
  replyFn: (msg: OutboundMessage) => void,
  onReady: FlushHandler,
): void {
  const botConfig = configManager.getBotConfig(botId);
  const { debounce } = botConfig;

  const atts = attachmentIds ?? [];

  if (!debounce.enabled) {
    onReady(content, atts);
    return;
  }

  const state = getState(conversationId);
  state.onReady = onReady;

  // Always accumulate attachments, even if content is empty (image-only msg).
  for (const a of atts) state.pendingAttachmentIds.push(a);
  if (content.length > 0) {
    state.pendingMessages.push(content);
    addToDebounceBuffer(conversationId, content);
  }
  console.log(`[debounce] buffered (${state.pendingMessages.length} msgs, ${state.pendingAttachmentIds.length} attachments): ${content.slice(0, 50)}`);

  // Hard timeout — safety net, bypasses both gates
  if (!state.hardTimer) {
    state.hardTimer = setTimeout(() => {
      console.log(`[debounce] hard timeout → flush`);
      doFlush(conversationId);
    }, debounce.maxWaitMs);
  }

  // Image-only messages bypass both gates — nothing for the judge to reason
  // about, and waiting on typing for a pure image upload feels laggy.
  if (state.pendingMessages.length === 0 && state.pendingAttachmentIds.length > 0) {
    console.log(`[debounce] image-only → flush immediately`);
    doFlush(conversationId);
    return;
  }

  // Each new message re-arms the typing gate. The anchor is "when did the
  // most recent message arrive", as the spec is phrased around that event.
  armTypingGate(conversationId);

  // Judge only fires if not already in flight.
  if (state.processing) return;
  judge(conversationId, botId);
}

// ── Typing gate ────────────────────────────────────────────────────────

function armTypingGate(conversationId: string): void {
  const state = states.get(conversationId);
  if (!state) return;

  if (state.typingTimer) clearTimeout(state.typingTimer);
  state.typingReady = false;
  state.typingExtensions = 0;
  state.typingAnchorAt = Date.now();

  // Initial 2s wait to see whether the user starts typing a follow-up.
  state.typingTimer = setTimeout(() => {
    const s = states.get(conversationId);
    if (!s) return;
    s.typingTimer = null;
    if (typedSince(conversationId, s.typingAnchorAt)) {
      console.log(`[debounce] typing gate: user is typing → 5s window`);
      scheduleTypingWindow(conversationId);
    } else {
      console.log(`[debounce] typing gate: no typing in 2s → resolved`);
      resolveTypingGate(conversationId);
    }
  }, INITIAL_TYPING_WAIT_MS);
}

function scheduleTypingWindow(conversationId: string): void {
  const state = states.get(conversationId);
  if (!state) return;

  const windowStart = Date.now();
  state.typingTimer = setTimeout(() => {
    const s = states.get(conversationId);
    if (!s) return;
    s.typingTimer = null;

    const typed = typedSince(conversationId, windowStart);
    if (!typed) {
      console.log(`[debounce] typing gate: 5s window idle → resolved`);
      resolveTypingGate(conversationId);
      return;
    }
    if (s.typingExtensions < MAX_TYPING_EXTENSIONS) {
      s.typingExtensions++;
      console.log(`[debounce] typing gate: still typing → extension ${s.typingExtensions}/${MAX_TYPING_EXTENSIONS}`);
      scheduleTypingWindow(conversationId);
    } else {
      console.log(`[debounce] typing gate: max extensions reached → resolved`);
      resolveTypingGate(conversationId);
    }
  }, TYPING_WINDOW_MS);
}

function resolveTypingGate(conversationId: string): void {
  const state = states.get(conversationId);
  if (!state) return;
  state.typingReady = true;
  tryFlush(conversationId);
}

// ── Judge ──────────────────────────────────────────────────────────────

async function judge(
  conversationId: string,
  botId: string,
): Promise<void> {
  const state = states.get(conversationId);
  if (!state || state.processing) return;

  state.processing = true;
  try {
    const judgePrompt = await configManager.readPrompt('debounce-judge.md');
    const messagesText = state.pendingMessages.map((m, i) => `消息${i + 1}: ${m}`).join('\n');

    console.log(`[debounce] judging (${state.pendingMessages.length} msgs)...`);
    const { result, latencyMs, costUsd } = await chatCompletion({
      model: configManager.get().openrouter.debounceModel,
      messages: [
        { role: 'system', content: judgePrompt },
        { role: 'user', content: messagesText },
      ],
      max_tokens: 10,
      provider: { sort: { by: 'latency' } },
    } as any);

    logAudit({
      conversationId,
      taskType: 'debounce',
      model: configManager.get().openrouter.debounceModel,
      inputTokens: result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.completion_tokens ?? 0,
      totalTokens: result.usage?.total_tokens ?? 0,
      costUsd,
      generationId: result.id,
      latencyMs,
    });

    const rawAnswer = result.choices[0]?.message?.content;
    const answer = rawAnswer?.trim().toUpperCase();
    console.log(`[debounce] judge → ${JSON.stringify(rawAnswer)} → ${answer ?? 'EMPTY'} (${latencyMs}ms, model: ${result.model ?? '?'})`);

    const current = states.get(conversationId);
    if (!current) return; // already flushed

    if (answer?.startsWith('WAIT')) {
      const waitSec = parseInt(answer.split(/\s+/)[1]) || 5;
      console.log(`[debounce] judge says WAIT ${waitSec}s`);
      current.processing = false;
      await Bun.sleep(waitSec * 1000);
      const still = states.get(conversationId);
      if (!still) return; // flushed or cancelled
      still.processing = false;
      judge(conversationId, botId);
      return;
    } else {
      current.judgeReady = true;
      tryFlush(conversationId);
    }
  } catch (e) {
    console.error('[debounce] judge error, marking judge gate ready:', e);
    const s = states.get(conversationId);
    if (s) {
      s.judgeReady = true;
      tryFlush(conversationId);
    }
  } finally {
    const s = states.get(conversationId);
    if (s) s.processing = false;
  }
}

// ── Flush coordination ─────────────────────────────────────────────────

function tryFlush(conversationId: string): void {
  const state = states.get(conversationId);
  if (!state) return;
  if (!state.judgeReady || !state.typingReady) return;
  doFlush(conversationId);
}

function doFlush(conversationId: string): void {
  const state = states.get(conversationId);
  if (!state) return;

  if (state.hardTimer) clearTimeout(state.hardTimer);
  if (state.typingTimer) clearTimeout(state.typingTimer);

  const merged = state.pendingMessages.join('\n');
  const atts = state.pendingAttachmentIds.slice();
  const onReady = state.onReady;
  states.delete(conversationId);
  clearDebounceBuffer(conversationId);

  // Only suppress flush if BOTH are empty. An image-only message (empty
  // content, non-empty attachments) should still make it through.
  if ((merged.trim() || atts.length > 0) && onReady) {
    console.log(`[debounce] flushed → "${merged.slice(0, 80)}${merged.length > 80 ? '...' : ''}" +${atts.length} att`);
    onReady(merged, atts);
  }
}

export function cancelPending(conversationId: string): void {
  const state = states.get(conversationId);
  if (state) {
    if (state.hardTimer) clearTimeout(state.hardTimer);
    if (state.typingTimer) clearTimeout(state.typingTimer);
    states.delete(conversationId);
    clearDebounceBuffer(conversationId);
  }
}
