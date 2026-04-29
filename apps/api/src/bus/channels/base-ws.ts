import type { ServerWebSocket } from 'bun';
import { z } from 'zod';
import type { Channel, InboundMessage, OutboundMessage } from '../types';
import { noteTypingTick } from '../../core/typing';

// Wire-protocol bounds. These are deliberately tight — a chat message is
// a short string + small attachment list; a typing tick has no payload at
// all. The Bun WS layer already caps raw bytes (see index.ts maxPayloadLength)
// — these caps are the additional schema-level shape check.
const MAX_CONTENT_LEN = 16_000;
const MAX_ATTACHMENTS = 10;
const MAX_BOT_ID_LEN = 128;
const MAX_CONV_ID_LEN = 128;
const ATTACHMENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

const ChatMessageSchema = z.object({
  type: z.literal('chat'),
  botId: z.string().min(1).max(MAX_BOT_ID_LEN).regex(ID_RE),
  conversationId: z.string().min(1).max(MAX_CONV_ID_LEN).regex(ID_RE),
  content: z.string().max(MAX_CONTENT_LEN).optional().default(''),
  attachmentIds: z.array(z.string().regex(ATTACHMENT_ID_RE)).max(MAX_ATTACHMENTS).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const SurfMessageSchema = z.object({
  type: z.literal('surf'),
  botId: z.string().min(1).max(MAX_BOT_ID_LEN).regex(ID_RE),
  conversationId: z.string().min(1).max(MAX_CONV_ID_LEN).regex(ID_RE),
});

const TypingTickSchema = z.object({
  type: z.literal('typing_tick'),
  conversationId: z.string().min(1).max(MAX_CONV_ID_LEN).regex(ID_RE),
});

const InboundWsMessageSchema = z.discriminatedUnion('type', [
  ChatMessageSchema,
  SurfMessageSchema,
  TypingTickSchema,
]);

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
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error(`[${this.logLabel}] invalid JSON from ${userId}`);
      return;
    }

    const result = InboundWsMessageSchema.safeParse(parsed);
    if (!result.success) {
      // Don't log full issues — attacker-controlled payload could spam
      // logs with crafted error messages. Just count and drop.
      console.warn(`[${this.logLabel}] schema rejected message from ${userId}`);
      return;
    }
    const data = result.data;

    if (data.type === 'chat') {
      const content = data.content ?? '';
      const atts = data.attachmentIds ?? [];
      // Allow image-only messages: content may be empty if attachmentIds
      // carries at least one id.
      if (!content && atts.length === 0) return;
      this.onMessage?.({
        channel: this.name,
        channelUserId: userId,
        botId: data.botId,
        conversationId: data.conversationId,
        content,
        attachmentIds: atts.length > 0 ? atts : undefined,
        timestamp: Date.now(),
        metadata: data.metadata,
      });
    } else if (data.type === 'surf') {
      this.onMessage?.({
        channel: this.name,
        channelUserId: userId,
        botId: data.botId,
        conversationId: data.conversationId,
        content: '/surf',
        timestamp: Date.now(),
      });
    } else if (data.type === 'typing_tick') {
      // Cheap side-channel — doesn't go through the message bus/handler.
      noteTypingTick(data.conversationId);
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
