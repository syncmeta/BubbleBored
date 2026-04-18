import type { ServerWebSocket } from 'bun';
import type { Channel, InboundMessage, OutboundMessage } from '../types';

export interface IOSWebSocketData {
  userId: string;
}

/**
 * iOS native client channel.
 *
 * Phase 1 (current): transport = WebSocket only. When the app is in the foreground
 * the iPhone holds a WS to /ws/mobile and messages flow just like the web channel.
 *
 * Phase 2 (with Apple Developer account): transport = WebSocket + APNs fallback.
 * The `send()` method already has the hook — when WS is not connected we will
 * push the OutboundMessage via APNs instead. See src/push/apns.ts (to be added)
 * and the `device_tokens` SQLite table.
 */
export class IOSChannel implements Channel {
  name = 'ios';
  onMessage?: (message: InboundMessage) => void;
  private connections = new Map<string, Set<ServerWebSocket<IOSWebSocketData>>>();

  addConnection(userId: string, ws: ServerWebSocket<IOSWebSocketData>): void {
    let set = this.connections.get(userId);
    if (!set) {
      set = new Set();
      this.connections.set(userId, set);
    }
    set.add(ws);
    console.log(`[ios] connected: ${userId} (${set.size} device(s))`);
  }

  removeConnection(userId: string, ws: ServerWebSocket<IOSWebSocketData>): void {
    const set = this.connections.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) this.connections.delete(userId);
    }
  }

  handleMessage(userId: string, raw: string): void {
    try {
      const data = JSON.parse(raw);
      const hasContent = typeof data.content === 'string' && data.content.length > 0;
      const hasAttachments = Array.isArray(data.attachmentIds) && data.attachmentIds.length > 0;
      if (data.type === 'chat' && data.botId && (hasContent || hasAttachments)) {
        this.onMessage?.({
          channel: 'ios',
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
          channel: 'ios',
          channelUserId: userId,
          botId: data.botId,
          conversationId: data.conversationId,
          content: '/surf',
          timestamp: Date.now(),
        });
      }
    } catch (e) {
      console.error('[ios] invalid message:', e);
    }
  }

  async send(userId: string, message: OutboundMessage): Promise<void> {
    const set = this.connections.get(userId);
    if (set && set.size > 0) {
      const payload = JSON.stringify(message);
      for (const ws of set) {
        try {
          ws.send(payload);
        } catch {
          set.delete(ws);
        }
      }
      return;
    }

    // Phase 2 hook: no live WS → fall back to APNs.
    // When APNs is wired up we'll look up device_tokens by userId here and push.
    // For now just drop the message (matches web channel behavior when user is offline).
    // TODO(apns): import pushApns from '../../push/apns' and call it here.
  }

  isConnected(userId: string): boolean {
    return (this.connections.get(userId)?.size ?? 0) > 0;
  }
}

export const iosChannel = new IOSChannel();
