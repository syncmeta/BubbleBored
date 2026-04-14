import type { Channel, InboundMessage, OutboundMessage } from '../types';

interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  defaultBot: string;
  verificationToken?: string;
}

const API = 'https://open.feishu.cn/open-apis';

export class FeishuChannel implements Channel {
  name = 'feishu';
  onMessage?: (message: InboundMessage) => void;

  private config: FeishuChannelConfig;
  private tenantToken = '';
  private tokenExpiresAt = 0;
  private userBotMap = new Map<string, string>();
  private processedEvents = new Set<string>();

  constructor(config: FeishuChannelConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    await this.refreshToken();
    console.log('[feishu] channel ready');
  }

  // --- Webhook handler (called from Hono route) ---

  async handleEvent(body: any): Promise<any> {
    // URL verification challenge
    if (body.type === 'url_verification') {
      return { challenge: body.challenge };
    }

    // v2 event
    if (body.schema === '2.0' && body.header) {
      const eventId = body.header.event_id;

      // Deduplicate — Feishu retries if it doesn't get 200 fast enough
      if (this.processedEvents.has(eventId)) return { code: 0 };
      this.processedEvents.add(eventId);
      if (this.processedEvents.size > 1000) {
        const arr = [...this.processedEvents];
        this.processedEvents = new Set(arr.slice(-500));
      }

      if (body.header.event_type === 'im.message.receive_v1') {
        this.handleMessage(body.event);
      }
    }

    return { code: 0 };
  }

  // --- Inbound ---

  private handleMessage(event: any): void {
    const msg = event.message;
    if (!msg || msg.message_type !== 'text') return;

    const senderId = event.sender?.sender_id?.open_id;
    if (!senderId) return;

    let content: string;
    try {
      const parsed = JSON.parse(msg.content);
      content = parsed.text ?? '';
    } catch {
      return;
    }

    // Strip bot @mentions in group chats
    if (msg.mentions?.length) {
      for (const mention of msg.mentions) {
        content = content.replace(mention.key, '').trim();
      }
    }

    if (!content) return;

    // Commands
    if (content === '/start') {
      this.sendText(senderId, `BubbleBored 已连接\n当前 bot: ${this.getBotId(senderId)}`);
      return;
    }

    if (content.startsWith('/bot ')) {
      const botId = content.slice(5).trim();
      if (botId) {
        this.userBotMap.set(senderId, botId);
        this.sendText(senderId, `已切换到: ${botId}`);
      }
      return;
    }

    if (content === '/surf') {
      this.onMessage?.({
        channel: 'feishu',
        channelUserId: senderId,
        botId: this.getBotId(senderId),
        content: '/surf',
        timestamp: parseInt(msg.create_time) || Date.now(),
      });
      return;
    }

    // Regular message
    const displayName = event.sender?.sender_id?.user_id || undefined;

    this.onMessage?.({
      channel: 'feishu',
      channelUserId: senderId,
      channelMessageId: msg.message_id,
      botId: this.getBotId(senderId),
      content,
      timestamp: parseInt(msg.create_time) || Date.now(),
      metadata: { displayName, chatId: msg.chat_id, chatType: msg.chat_type },
    });
  }

  // --- Outbound ---

  async send(userId: string, message: OutboundMessage): Promise<void> {
    if (message.type === 'message' && message.content) {
      await this.sendText(userId, message.content);
    } else if (message.type === 'error' && message.content) {
      await this.sendText(userId, `⚠️ ${message.content}`);
    }
  }

  // --- Helpers ---

  private getBotId(userId: string): string {
    return this.userBotMap.get(userId) ?? this.config.defaultBot;
  }

  private async sendText(openId: string, text: string): Promise<void> {
    await this.ensureToken();
    try {
      const res = await fetch(`${API}/im/v1/messages?receive_id_type=open_id`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.tenantToken}`,
        },
        body: JSON.stringify({
          receive_id: openId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
      });
      const data = (await res.json()) as any;
      if (data.code !== 0) {
        console.error('[feishu] send error:', data.code, data.msg);
      }
    } catch (e) {
      console.error('[feishu] send error:', e);
    }
  }

  // --- Token management ---

  private async ensureToken(): Promise<void> {
    if (Date.now() < this.tokenExpiresAt - 60_000) return;
    await this.refreshToken();
  }

  private async refreshToken(): Promise<void> {
    try {
      const res = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      });
      const data = (await res.json()) as any;
      if (data.code === 0) {
        this.tenantToken = data.tenant_access_token;
        this.tokenExpiresAt = Date.now() + data.expire * 1000;
        console.log('[feishu] token refreshed');
      } else {
        console.error('[feishu] token refresh failed:', data.code, data.msg);
      }
    } catch (e) {
      console.error('[feishu] token refresh error:', e);
    }
  }
}
