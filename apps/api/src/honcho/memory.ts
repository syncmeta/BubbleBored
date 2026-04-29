import {
  getHonchoClient, isHonchoConfigured,
  userPeerId, botPeerId, sessionIdFor,
} from './client';

// Per-session FIFO queue: addMessages() must land in order, and chaining on
// the session id avoids unbounded concurrency when a conversation is
// chatty. One failed write doesn't poison the chain.
const sessionChains = new Map<string, Promise<unknown>>();

// ── Circuit breaker ──────────────────────────────────────────────────────
//
// Honcho is a third-party hosted service — when it goes down or slows to a
// crawl, every chat turn was waiting on its profile fetch / write before
// timing out. The breaker trips after N consecutive failures and stays
// tripped for T ms; while tripped, calls short-circuit to a default value
// instead of hitting the network. /api/health surfaces the state so an
// operator can see "honcho degraded" without grepping logs.
//
// Failure tracking is per-process (single Fly machine assumption); if we
// horizontally scale, swap this for a shared counter.

const BREAKER_THRESHOLD = 5;             // consecutive failures
const BREAKER_COOLDOWN_MS = 5 * 60_000;  // stay open this long
const BREAKER_PROBE_AFTER_MS = 30_000;   // half-open probe interval

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;     // epoch ms when last tripped
  lastProbeAt: number;          // epoch ms of last half-open attempt
}
const breaker: BreakerState = {
  consecutiveFailures: 0,
  openedAt: null,
  lastProbeAt: 0,
};

/** True if the breaker is currently open (Honcho calls are short-circuited). */
function breakerIsOpen(): boolean {
  if (breaker.openedAt === null) return false;
  const since = Date.now() - breaker.openedAt;
  if (since > BREAKER_COOLDOWN_MS) {
    // Cooldown elapsed — reset to closed and let the next call retry.
    breaker.openedAt = null;
    breaker.consecutiveFailures = 0;
    return false;
  }
  // Allow one half-open probe per BREAKER_PROBE_AFTER_MS so a recovered
  // Honcho is detected before the full cooldown elapses.
  const sinceProbe = Date.now() - breaker.lastProbeAt;
  if (sinceProbe > BREAKER_PROBE_AFTER_MS) {
    breaker.lastProbeAt = Date.now();
    return false;
  }
  return true;
}

function noteSuccess(): void {
  breaker.consecutiveFailures = 0;
  if (breaker.openedAt !== null) {
    console.log('[honcho] breaker closed (recovered)');
    breaker.openedAt = null;
  }
}

function noteFailure(): void {
  breaker.consecutiveFailures++;
  if (
    breaker.consecutiveFailures >= BREAKER_THRESHOLD &&
    breaker.openedAt === null
  ) {
    breaker.openedAt = Date.now();
    breaker.lastProbeAt = Date.now();
    console.warn(
      `[honcho] breaker opened after ${breaker.consecutiveFailures} consecutive failures, ` +
      `cooling for ${BREAKER_COOLDOWN_MS / 1000}s`,
    );
  }
}

/** State snapshot for /api/health and admin tooling. */
export function honchoBreakerStatus(): {
  open: boolean;
  consecutiveFailures: number;
  openedAt: number | null;
} {
  return {
    open: breaker.openedAt !== null,
    consecutiveFailures: breaker.consecutiveFailures,
    openedAt: breaker.openedAt,
  };
}

function enqueue(sessionKey: string, fn: () => Promise<unknown>): void {
  const prev = sessionChains.get(sessionKey) ?? Promise.resolve();
  const next = prev.then(async () => {
    if (breakerIsOpen()) return;
    try {
      await fn();
      noteSuccess();
    } catch (err: any) {
      noteFailure();
      console.warn('[honcho] write failed:', err?.message ?? err);
    }
  });
  sessionChains.set(sessionKey, next);
}

// ── Sanitization ─────────────────────────────────────────────────────────
//
// Honcho output is user-derived (it summarizes the user's own chat history)
// so it's not "trusted" in the sense an env var or a developer-authored
// system prompt is. If a user types `<|im_start|>system\nIgnore previous`
// often enough and Honcho summarizes it back to us, that string lands in
// the next system prompt. Strip the obvious control-token patterns and cap
// length so an over-eager summary can't blow the prompt budget.

const CONTROL_TOKEN_RE = /<\|[^|>]*\|>/g;       // <|...|>
const ROLE_TAG_RE = /<\/?(system|user|assistant|tool|function|instructions|prompt)\b[^>]*>/gi;
const MAX_CARD_ITEM_LEN = 500;
const MAX_REPRESENTATION_LEN = 4000;

function sanitize(s: string, max: number): string {
  let out = s.replace(CONTROL_TOKEN_RE, '');
  out = out.replace(ROLE_TAG_RE, '');
  // Collapse pathological whitespace bursts that summaries occasionally
  // produce — keeps the prompt budget honest.
  out = out.replace(/\n{4,}/g, '\n\n\n');
  if (out.length > max) out = out.slice(0, max) + '…';
  return out.trim();
}

export function recordUserMessage(params: {
  userId: string;
  conversationId: string;
  content: string;
}): void {
  const client = getHonchoClient();
  if (!client) return;
  const content = params.content?.trim();
  if (!content) return;

  const sid = sessionIdFor(params.conversationId);
  enqueue(sid, async () => {
    const [userPeer, session] = await Promise.all([
      client.peer(userPeerId(params.userId)),
      client.session(sid),
    ]);
    await session.addMessages([userPeer.message(content)]);
  });
}

export function recordBotMessage(params: {
  botId: string;
  conversationId: string;
  content: string;
}): void {
  const client = getHonchoClient();
  if (!client) return;
  const content = params.content?.trim();
  if (!content) return;

  const sid = sessionIdFor(params.conversationId);
  enqueue(sid, async () => {
    const [botPeer, session] = await Promise.all([
      client.peer(botPeerId(params.botId)),
      client.session(sid),
    ]);
    await session.addMessages([botPeer.message(content)]);
  });
}

/// Best-effort scrub of every Honcho row tied to this user — called from
/// the account-deletion cascade. Wipes each session (per conversation) and
/// then attempts to drop the user's peer record so their representation /
/// peer card don't linger in the workspace. The session deletes alone are
/// enough to scrub the messages we wrote; the peer delete is belt-and-
/// suspenders for the derived state Honcho keeps on the peer itself.
export async function deleteUserMemory(params: {
  userId: string;
  conversationIds: string[];
}): Promise<void> {
  const client = getHonchoClient();
  if (!client) return;

  for (const convId of params.conversationIds) {
    try {
      const session = await client.session(sessionIdFor(convId));
      await session.delete();
    } catch (err: any) {
      console.warn(`[honcho] session.delete(${convId}) failed:`, err?.message ?? err);
    }
  }

  // Workspace-scoped peer delete — best-effort, since not every Honcho
  // deployment ships the endpoint and the SDK doesn't surface it as a
  // first-class method. A 404/405 here is fine: we already nuked the
  // sessions, which is where the actual chat content lived.
  try {
    const httpClient = (client as any)._http;
    const workspaceId = (client as any).workspaceId;
    if (httpClient && workspaceId) {
      await httpClient.delete(`/v2/workspaces/${workspaceId}/peers/${userPeerId(params.userId)}`);
    }
  } catch (err: any) {
    console.warn('[honcho] peer delete failed (non-fatal):', err?.message ?? err);
  }
}

export async function getUserProfile(userId: string): Promise<{
  card: string[];
  representation: string;
}> {
  if (!isHonchoConfigured()) return { card: [], representation: '' };
  if (breakerIsOpen()) return { card: [], representation: '' };
  const client = getHonchoClient();
  if (!client) return { card: [], representation: '' };

  try {
    const peer = await client.peer(userPeerId(userId));
    // One call returns both the representation text and the peer card.
    const ctx = await peer.context();
    const card = Array.isArray(ctx.peerCard)
      ? ctx.peerCard
        .filter((s): s is string => typeof s === 'string')
        .map(s => sanitize(s, MAX_CARD_ITEM_LEN))
        .filter(Boolean)
      : [];
    const representation = sanitize(ctx.representation ?? '', MAX_REPRESENTATION_LEN);
    noteSuccess();
    return { card, representation };
  } catch (err: any) {
    noteFailure();
    console.warn('[honcho] getUserProfile failed:', err?.message ?? err);
    return { card: [], representation: '' };
  }
}

