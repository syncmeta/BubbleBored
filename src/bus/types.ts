export interface InboundMessage {
  channel: string;
  channelUserId: string;
  channelMessageId?: string;
  botId: string;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  type: 'stream_start' | 'stream_delta' | 'segment_complete' | 'stream_end' | 'message' | 'error' | 'surf_status';
  conversationId: string;
  messageId?: string;
  segmentIndex?: number;
  content?: string;
  delta?: string;
  totalSegments?: number;
  metadata?: Record<string, unknown>;
}

export interface Channel {
  name: string;
  send(userId: string, message: OutboundMessage): Promise<void>;
  onMessage?: (message: InboundMessage) => void;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
