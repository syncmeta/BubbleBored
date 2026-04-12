import type { ServerWebSocket } from 'bun';
import type { Channel, InboundMessage, OutboundMessage } from '../types';

export interface WebSocketData {
  userId: string;
}

export class WebChannel implements Channel {
  name = 'web';
  onMessage?: (message: InboundMessage) => void;
  private connections = new Map<string, Set<ServerWebSocket<WebSocketData>>>();

  addConnection(userId: string, ws: ServerWebSocket<WebSocketData>): void {
    let set = this.connections.get(userId);
    if (!set) {
      set = new Set();
      this.connections.set(userId, set);
    }
    set.add(ws);
    console.log(`[web] connected: ${userId} (${set.size} tabs)`);
  }

  removeConnection(userId: string, ws: ServerWebSocket<WebSocketData>): void {
    const set = this.connections.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) this.connections.delete(userId);
    }
  }

  handleMessage(userId: string, raw: string): void {
    try {
      const data = JSON.parse(raw);
      if (data.type === 'chat' && data.botId && data.content) {
        this.onMessage?.({
          channel: 'web',
          channelUserId: userId,
          botId: data.botId,
          content: data.content,
          timestamp: Date.now(),
          metadata: data.metadata,
        });
      } else if (data.type === 'surf' && data.botId) {
        this.onMessage?.({
          channel: 'web',
          channelUserId: userId,
          botId: data.botId,
          content: '/surf',
          timestamp: Date.now(),
        });
      }
    } catch (e) {
      console.error('[web] invalid message:', e);
    }
  }

  async send(userId: string, message: OutboundMessage): Promise<void> {
    const set = this.connections.get(userId);
    if (!set) return;
    const payload = JSON.stringify(message);
    for (const ws of set) {
      try {
        ws.send(payload);
      } catch {
        set.delete(ws);
      }
    }
  }

  isConnected(userId: string): boolean {
    return (this.connections.get(userId)?.size ?? 0) > 0;
  }
}

export const webChannel = new WebChannel();
