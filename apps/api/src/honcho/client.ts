import { Honcho } from '@honcho-ai/sdk';

let client: Honcho | null = null;

export function isHonchoConfigured(): boolean {
  return !!(process.env.HONCHO_API_KEY && process.env.HONCHO_WORKSPACE_ID);
}

export function getHonchoClient(): Honcho | null {
  if (!isHonchoConfigured()) return null;
  if (!client) {
    client = new Honcho({
      apiKey: process.env.HONCHO_API_KEY,
      workspaceId: process.env.HONCHO_WORKSPACE_ID,
      baseURL: process.env.HONCHO_BASE_URL || undefined,
    });
  }
  return client;
}

export async function initHoncho(): Promise<void> {
  if (!isHonchoConfigured()) {
    console.log('[honcho] not configured, using SQLite-only memory');
    return;
  }
  getHonchoClient();
  console.log(`[honcho] client initialized (workspace=${process.env.HONCHO_WORKSPACE_ID})`);
}

// Peer/session IDs must match /^[a-zA-Z0-9_-]+$/ and be ≤100 chars. Replace
// any non-conforming chars so upstream validation never kills the write.
function sanitize(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
}

export const userPeerId = (userId: string) => sanitize(`user-${userId}`);
export const botPeerId = (botId: string) => sanitize(`bot-${botId}`);
export const sessionIdFor = (conversationId: string) => sanitize(conversationId);
