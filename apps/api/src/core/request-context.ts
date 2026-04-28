import { AsyncLocalStorage } from 'async_hooks';

// Async-scoped "who is the human behind this LLM call" context. Set once at
// the top-level entry point of a request (HTTP handler, message-bus dispatch,
// scheduled surf trigger) and read deep in the LLM client / audit hook
// without threading userId through every callsite.
//
// Only the entry point should call runWithUser. Every awaited descendant
// inherits the context for free via Node's async-hooks.

export interface RequestContext {
  userId: string;
}

const als = new AsyncLocalStorage<RequestContext>();

export function runWithUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ userId }, fn);
}

export function currentUserId(): string | null {
  return als.getStore()?.userId ?? null;
}

export function requireUserId(): string {
  const id = currentUserId();
  if (!id) throw new Error('no request user in context — wrap entry point with runWithUser');
  return id;
}
