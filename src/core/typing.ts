// Tracks the most recent "user is typing" tick per conversation.
// The web client sends `typing_tick` on input changes; non-web channels
// simply never tick and the gate falls through on its initial check.

const lastTickAt = new Map<string, number>();

export function noteTypingTick(conversationId: string): void {
  if (!conversationId) return;
  lastTickAt.set(conversationId, Date.now());
}

export function lastTypingAt(conversationId: string): number {
  return lastTickAt.get(conversationId) ?? 0;
}

// Has the user typed anything strictly after `since` (ms epoch)?
export function typedSince(conversationId: string, since: number): boolean {
  const t = lastTickAt.get(conversationId);
  return t !== undefined && t > since;
}
