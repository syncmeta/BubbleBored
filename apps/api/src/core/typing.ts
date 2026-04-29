// Tracks the most recent "user is typing" tick per conversation.
// The web client sends `typing_tick` on input changes; non-web channels
// simply never tick and the gate falls through on its initial check.

import { refreshPerceptionInBackground } from './perception';

const lastTickAt = new Map<string, number>();

// Throttle perception pre-warming — recomputing every keystroke would
// hammer the perception model with effectively duplicate work. Once per
// conversation per ~10s is plenty: by the time the user hits send, the
// fresh block is in cache.
const PERCEPTION_PREWARM_THROTTLE_MS = 10_000;
const lastPerceptionPrewarmAt = new Map<string, number>();

export function noteTypingTick(conversationId: string): void {
  if (!conversationId) return;
  lastTickAt.set(conversationId, Date.now());

  // Side effect: opportunistically refresh the perception block while the
  // user is still composing. The chat-build path uses whatever's cached, so
  // by send-time the block is already current — no LLM wait inside
  // `buildPrompt`.
  const last = lastPerceptionPrewarmAt.get(conversationId) ?? 0;
  if (Date.now() - last >= PERCEPTION_PREWARM_THROTTLE_MS) {
    lastPerceptionPrewarmAt.set(conversationId, Date.now());
    refreshPerceptionInBackground(conversationId);
  }
}

// Has the user typed anything strictly after `since` (ms epoch)?
export function typedSince(conversationId: string, since: number): boolean {
  const t = lastTickAt.get(conversationId);
  return t !== undefined && t > since;
}
