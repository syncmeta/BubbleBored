import {
  getHonchoClient, isHonchoConfigured,
  userPeerId, botPeerId, sessionIdFor,
} from './client';

// Per-session FIFO queue: addMessages() must land in order, and chaining on
// the session id avoids unbounded concurrency when a conversation is
// chatty. One failed write doesn't poison the chain.
const sessionChains = new Map<string, Promise<unknown>>();

function enqueue(sessionKey: string, fn: () => Promise<unknown>): void {
  const prev = sessionChains.get(sessionKey) ?? Promise.resolve();
  const next = prev.then(fn).catch(err => {
    console.warn('[honcho] write failed:', err?.message ?? err);
  });
  sessionChains.set(sessionKey, next);
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

export async function getUserProfile(userId: string): Promise<{
  card: string[];
  representation: string;
}> {
  if (!isHonchoConfigured()) return { card: [], representation: '' };
  const client = getHonchoClient();
  if (!client) return { card: [], representation: '' };

  try {
    const peer = await client.peer(userPeerId(userId));
    // One call returns both the representation text and the peer card.
    const ctx = await peer.context();
    return {
      card: Array.isArray(ctx.peerCard) ? ctx.peerCard.filter(s => typeof s === 'string') : [],
      representation: (ctx.representation ?? '').trim(),
    };
  } catch (err: any) {
    console.warn('[honcho] getUserProfile failed:', err?.message ?? err);
    return { card: [], representation: '' };
  }
}

