export interface InboundMessage {
  channel: string;
  channelUserId: string;
  channelMessageId?: string;
  botId: string;
  // Optional explicit conversation id. Used by web (multi-conversation per
  // (botId, userId) pair). External channels omit it and the router falls
  // back to "most recent conversation, create if none".
  conversationId?: string;
  content: string;
  // Attachment ids returned by POST /api/upload. Server binds them to the
  // user message row inside the orchestrator. May be empty/undefined.
  attachmentIds?: string[];
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  type:
    | 'stream_start'
    | 'stream_delta'
    | 'segment_complete'
    | 'stream_end'
    | 'message'
    | 'user_message_ack'
    | 'error'
    | 'surf_status'
    | 'surf_result'
    | 'title_update'
    | 'conversation_created'
    // Bot is preparing/sending a reply. Client shows a typing indicator
    // for as long as any generation is active for this conversation.
    | 'bot_typing';
  conversationId: string;
  messageId?: string;
  segmentIndex?: number;
  content?: string;
  delta?: string;
  totalSegments?: number;
  title?: string;
  active?: boolean;
  metadata?: Record<string, unknown>;
}

export interface Channel {
  name: string;
  send(userId: string, message: OutboundMessage): Promise<void>;
  onMessage?: (message: InboundMessage) => void;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
