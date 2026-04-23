import type { Channel, InboundMessage, OutboundMessage } from '../types';

interface FeishuChannelConfig {
  botId: string;
  appId: string;
  appSecret: string;
  verificationToken?: string;
}

const API = 'https://open.feishu.cn/open-apis';

export class FeishuChannel implements Channel {
  readonly name: string;
  readonly botId: string;
  onMessage?: (message: InboundMessage) => void;

  private appId: string;
  private appSecret: string;
  private verificationToken: string;
  private tenantToken = '';
  private tokenExpiresAt = 0;
  private processedEvents = new Set<string>();

  constructor(config: FeishuChannelConfig) {
    this.botId = config.botId;
    this.name = `feishu:${config.botId}`;
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.verificationToken = config.verificationToken ?? '';
  }

  async start(): Promise<void> {
    await this.refreshToken();
    console.log(`[${this.name}] channel ready`);
  }

  // --- Webhook handler (called from Hono route) ---

  async handleEvent(body: any): Promise<any> {
    // URL verification challenge (v1 shape — body.token, body.challenge)
    if (body.type === 'url_verification') {
      if (this.verificationToken && body.token !== this.verificationToken) {
        console.warn(`[${this.name}] url_verification: bad token`);
        return { code: 403 };
      }
      return { challenge: body.challenge };
    }

    // v2 event — token is in body.header.token
    if (body.schema === '2.0' && body.header) {
      if (this.verificationToken && body.header.token !== this.verificationToken) {
        console.warn(`[${this.name}] event: bad token`);
        return { code: 403 };
      }
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

    if (content === '/start') {
      this.sendText(senderId, 'PendingBot 已连接，直接发消息开始聊天。');
      return;
    }

    if (content === '/surf') {
      this.onMessage?.({
        channel: this.name,
        channelUserId: senderId,
        botId: this.botId,
        content: '/surf',
        timestamp: parseInt(msg.create_time) || Date.now(),
      });
      return;
    }

    if (content.startsWith('/')) return;

    const displayName = event.sender?.sender_id?.user_id || undefined;

    this.onMessage?.({
      channel: this.name,
      channelUserId: senderId,
      channelMessageId: msg.message_id,
      botId: this.botId,
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
        console.error(`[${this.name}] send error:`, data.code, data.msg);
      }
    } catch (e) {
      console.error(`[${this.name}] send error:`, e);
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
          app_id: this.appId,
          app_secret: this.appSecret,
        }),
      });
      const data = (await res.json()) as any;
      if (data.code === 0) {
        this.tenantToken = data.tenant_access_token;
        this.tokenExpiresAt = Date.now() + data.expire * 1000;
        console.log(`[${this.name}] token refreshed`);
      } else {
        console.error(`[${this.name}] token refresh failed:`, data.code, data.msg);
      }
    } catch (e) {
      console.error(`[${this.name}] token refresh error:`, e);
    }
  }
}
