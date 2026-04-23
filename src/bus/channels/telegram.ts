import type { Channel, InboundMessage, OutboundMessage } from '../types';

interface TelegramChannelConfig {
  botId: string;
  token: string;
  webhookUrl?: string;
}

export class TelegramChannel implements Channel {
  readonly name: string;
  readonly botId: string;
  readonly webhookUrl?: string;
  onMessage?: (message: InboundMessage) => void;

  private token: string;
  private pollingActive = false;
  private pollingOffset = 0;

  constructor(config: TelegramChannelConfig) {
    this.botId = config.botId;
    this.name = `telegram:${config.botId}`;
    this.token = config.token;
    this.webhookUrl = config.webhookUrl;
  }

  private get api() {
    return `https://api.telegram.org/bot${this.token}`;
  }

  async start(): Promise<void> {
    if (this.webhookUrl) {
      await this.setWebhook(this.webhookUrl);
      console.log(`[${this.name}] webhook mode: ${this.webhookUrl}`);
    } else {
      await this.deleteWebhook();
      this.pollingActive = true;
      this.poll().catch(e => console.error(`[${this.name}] polling crashed:`, e));
      console.log(`[${this.name}] polling mode started`);
    }
  }

  async stop(): Promise<void> {
    this.pollingActive = false;
  }

  // --- Polling ---

  private async poll(): Promise<void> {
    while (this.pollingActive) {
      try {
        const res = await fetch(
          `${this.api}/getUpdates?offset=${this.pollingOffset}&timeout=30`,
          { signal: AbortSignal.timeout(35_000) },
        );
        const data = (await res.json()) as any;
        if (data.ok && data.result?.length) {
          for (const update of data.result) {
            this.pollingOffset = update.update_id + 1;
            this.handleUpdate(update);
          }
        }
      } catch (e: any) {
        if (e?.name !== 'AbortError') {
          console.error(`[${this.name}] polling error:`, e);
          await Bun.sleep(5000);
        }
      }
    }
  }

  // --- Webhook / Inbound ---

  handleUpdate(update: any): void {
    const msg = update.message;
    if (!msg?.text) return;

    const chatId = String(msg.chat.id);
    const text = msg.text.trim();

    if (text === '/start') {
      this.sendText(chatId, 'PendingBot 已连接，直接发消息开始聊天。');
      return;
    }

    if (text === '/surf') {
      this.onMessage?.({
        channel: this.name,
        channelUserId: chatId,
        botId: this.botId,
        content: '/surf',
        timestamp: msg.date * 1000,
      });
      return;
    }

    // Skip other slash commands
    if (text.startsWith('/')) return;

    const displayName =
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || undefined;

    this.onMessage?.({
      channel: this.name,
      channelUserId: chatId,
      channelMessageId: String(msg.message_id),
      botId: this.botId,
      content: text,
      timestamp: msg.date * 1000,
      metadata: { displayName },
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

  private async sendText(chatId: string, text: string): Promise<void> {
    try {
      await fetch(`${this.api}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    } catch (e) {
      console.error(`[${this.name}] send error:`, e);
    }
  }

  private async setWebhook(url: string): Promise<void> {
    const res = await fetch(`${this.api}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = (await res.json()) as any;
    if (!data.ok) console.error(`[${this.name}] setWebhook failed:`, data);
  }

  private async deleteWebhook(): Promise<void> {
    await fetch(`${this.api}/deleteWebhook`, { method: 'POST' }).catch(() => {});
  }
}
