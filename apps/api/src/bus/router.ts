import { randomUUID } from 'crypto';
import type { Channel, InboundMessage, OutboundMessage } from './types';
import { configManager } from '../config/loader';
import {
  findUserByChannel, createUser, findConversation, findConversationById,
  createConversation, findUserById,
} from '../db/queries';

export class MessageBus {
  private channels = new Map<string, Channel>();
  private conversationChannels = new Map<string, { channel: string; userId: string }>();
  private onMessageHandler?: (params: {
    conversationId: string;
    botId: string;
    userId: string;
    content: string;
    attachmentIds?: string[];
    metadata?: Record<string, unknown>;
    replyFn: (msg: OutboundMessage) => void;
  }) => void;

  register(channel: Channel): void {
    this.channels.set(channel.name, channel);
    channel.onMessage = (msg) => this.handleInbound(msg);
  }

  setMessageHandler(handler: typeof this.onMessageHandler): void {
    this.onMessageHandler = handler;
  }

  private async handleInbound(msg: InboundMessage): Promise<void> {
    // Resolve or create user
    let user = findUserByChannel(msg.channel, msg.channelUserId);
    if (!user) {
      const userId = randomUUID();
      const displayName = msg.metadata?.displayName as string ?? `User-${msg.channelUserId.slice(0, 6)}`;
      createUser(userId, msg.channel, msg.channelUserId, displayName);
      user = findUserByChannel(msg.channel, msg.channelUserId);
    }

    if (!user || user.status === 'blocked') return;

    // Check access control
    const botConfig = configManager.getBotConfig(msg.botId);
    if (botConfig.accessMode === 'private') {
      if (!botConfig.creators.includes(user.id)) return;
    }
    if (botConfig.accessMode === 'approval' && user.status === 'pending') {
      const channel = this.channels.get(msg.channel);
      if (channel) {
        await channel.send(msg.channelUserId, {
          type: 'error',
          conversationId: '',
          content: '等待管理员审批中',
        });
      }
      return;
    }

    // Resolve conversation:
    // - If channel passed an explicit conversationId (web with multi-conversation), use it directly.
    // - Otherwise fall back to the most recent (botId, user.id) conversation, creating one
    //   if none exists. This is the natural behavior for external channels (Telegram/Feishu),
    //   where one chat thread = one conversation.
    let conv = msg.conversationId
      ? findConversationById(msg.conversationId)
      : findConversation(msg.botId, user.id);

    // Safety: if explicit conversationId was given but doesn't match this user/bot, ignore it
    if (msg.conversationId && conv && (conv.user_id !== user.id || conv.bot_id !== msg.botId)) {
      conv = null;
    }

    if (!conv && !msg.conversationId) {
      const convId = randomUUID();
      createConversation(convId, msg.botId, user.id);
      conv = findConversationById(convId);
    }

    if (!conv) return;

    // Track which channel owns this conversation for replies
    this.conversationChannels.set(conv.id, { channel: msg.channel, userId: msg.channelUserId });

    // Build reply function
    const channel = this.channels.get(msg.channel)!;
    const replyFn = (outMsg: OutboundMessage) => {
      channel.send(msg.channelUserId, outMsg).catch(e =>
        console.error('[bus] send error:', e)
      );
    };

    // Pass to handler
    if (this.onMessageHandler) {
      this.onMessageHandler({
        conversationId: conv.id,
        botId: msg.botId,
        userId: user.id,
        content: msg.content,
        attachmentIds: msg.attachmentIds,
        metadata: msg.metadata,
        replyFn,
      });
    }
  }

  getReplyFn(conversationId: string): ((msg: OutboundMessage) => void) | null {
    const info = this.conversationChannels.get(conversationId);
    if (!info) return null;
    const channel = this.channels.get(info.channel);
    if (!channel) return null;
    return (msg: OutboundMessage) => {
      channel.send(info.userId, msg).catch(e => console.error('[bus] send error:', e));
    };
  }

  // Returns the platform kind for a conversation: 'web' | 'ios' | 'telegram'
  // | 'feishu' | null. Channel names are either bare ('web', 'ios') or
  // 'kind:botId' (telegram/feishu) — strip the suffix.
  getChannelKind(conversationId: string): string | null {
    const info = this.conversationChannels.get(conversationId);
    if (!info) return null;
    return info.channel.split(':')[0];
  }
}

export const messageBus = new MessageBus();
