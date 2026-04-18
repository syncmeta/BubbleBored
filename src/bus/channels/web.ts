import type { ServerWebSocket } from 'bun';
import type { Channel, InboundMessage, OutboundMessage } from '../types';
import { noteTypingTick } from '../../core/typing';

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
      // Allow image-only messages: content may be empty if attachmentIds
      // carries at least one id.
      const hasContent = typeof data.content === 'string' && data.content.length > 0;
      const hasAttachments = Array.isArray(data.attachmentIds) && data.attachmentIds.length > 0;
      if (data.type === 'chat' && data.botId && (hasContent || hasAttachments)) {
        this.onMessage?.({
          channel: 'web',
          channelUserId: userId,
          botId: data.botId,
          conversationId: data.conversationId,
          content: typeof data.content === 'string' ? data.content : '',
          attachmentIds: hasAttachments ? data.attachmentIds.filter((x: any) => typeof x === 'string') : undefined,
          timestamp: Date.now(),
          metadata: data.metadata,
        });
      } else if (data.type === 'surf' && data.botId) {
        this.onMessage?.({
          channel: 'web',
          channelUserId: userId,
          botId: data.botId,
          conversationId: data.conversationId,
          content: '/surf',
          timestamp: Date.now(),
        });
      } else if (data.type === 'typing_tick' && typeof data.conversationId === 'string') {
        // Cheap side-channel — does not go through the message bus/handler.
        noteTypingTick(data.conversationId);
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
