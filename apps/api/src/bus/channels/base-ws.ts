import type { ServerWebSocket } from 'bun';
import type { Channel, InboundMessage, OutboundMessage } from '../types';
import { noteTypingTick } from '../../core/typing';

export interface WsChannelData {
  userId: string;
}

/**
 * Shared WebSocket channel implementation for the live web + iOS clients.
 * Both speak the same wire protocol; the only runtime difference is the
 * channel name that rides along on inbound messages (and in the future,
 * an APNs fallback inside `iosChannel.send()` when no socket is connected).
 */
export abstract class BaseWebSocketChannel<Data extends WsChannelData> implements Channel {
  abstract readonly name: 'web' | 'ios';
  onMessage?: (message: InboundMessage) => void;
  protected connections = new Map<string, Set<ServerWebSocket<Data>>>();

  // Label for console logs — keeps the existing "connected: uid (N tabs)" style.
  protected get logLabel(): string { return this.name; }
  protected get unitPluralized(): string { return this.name === 'web' ? 'tabs' : 'device(s)'; }

  addConnection(userId: string, ws: ServerWebSocket<Data>): void {
    let set = this.connections.get(userId);
    if (!set) {
      set = new Set();
      this.connections.set(userId, set);
    }
    set.add(ws);
    console.log(`[${this.logLabel}] connected: ${userId} (${set.size} ${this.unitPluralized})`);
  }

  removeConnection(userId: string, ws: ServerWebSocket<Data>): void {
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
          channel: this.name,
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
          channel: this.name,
          channelUserId: userId,
          botId: data.botId,
          conversationId: data.conversationId,
          content: '/surf',
          timestamp: Date.now(),
        });
      } else if (data.type === 'typing_tick' && typeof data.conversationId === 'string') {
        // Cheap side-channel — doesn't go through the message bus/handler.
        noteTypingTick(data.conversationId);
      }
    } catch (e) {
      console.error(`[${this.logLabel}] invalid message:`, e);
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
    // Subclasses may override to add an offline-delivery fallback (e.g. APNs).
    await this.sendOffline(userId, message);
  }

  protected async sendOffline(_userId: string, _message: OutboundMessage): Promise<void> {
    // Default: drop silently — mirrors existing web/ios behaviour when no
    // socket is connected.
  }

  isConnected(userId: string): boolean {
    return (this.connections.get(userId)?.size ?? 0) > 0;
  }
}
