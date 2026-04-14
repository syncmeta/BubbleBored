import type { Channel, InboundMessage, OutboundMessage } from '../types';

interface TelegramChannelConfig {
  token: string;
  defaultBot: string;
  webhookUrl?: string;
}

export class TelegramChannel implements Channel {
  name = 'telegram';
  onMessage?: (message: InboundMessage) => void;

  private config: TelegramChannelConfig;
  private userBotMap = new Map<string, string>();
  private pollingActive = false;
  private pollingOffset = 0;

  constructor(config: TelegramChannelConfig) {
    this.config = config;
  }

  private get api() {
    return `https://api.telegram.org/bot${this.config.token}`;
  }

  async start(): Promise<void> {
    if (this.config.webhookUrl) {
      await this.setWebhook(this.config.webhookUrl);
      console.log(`[telegram] webhook mode: ${this.config.webhookUrl}`);
    } else {
      await this.deleteWebhook();
      this.pollingActive = true;
      this.poll().catch(e => console.error('[telegram] polling crashed:', e));
      console.log('[telegram] polling mode started');
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
          console.error('[telegram] polling error:', e);
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

    // Commands
    if (text === '/start') {
      this.sendText(chatId,
        `BubbleBored 已连接\n当前 bot: ${this.getBotId(chatId)}\n\n` +
        `/bots - 查看当前 bot\n/bot <name> - 切换 bot\n/surf - 触发冲浪`,
      );
      return;
    }

    if (text === '/bots') {
      this.sendText(chatId, `当前 bot: ${this.getBotId(chatId)}\n用 /bot <name> 切换`);
      return;
    }

    if (text.startsWith('/bot ')) {
      const botId = text.slice(5).trim();
      if (botId) {
        this.userBotMap.set(chatId, botId);
        this.sendText(chatId, `已切换到: ${botId}`);
      }
      return;
    }

    if (text === '/surf') {
      this.onMessage?.({
        channel: 'telegram',
        channelUserId: chatId,
        botId: this.getBotId(chatId),
        content: '/surf',
        timestamp: msg.date * 1000,
      });
      return;
    }

    // Skip other slash commands from Telegram (e.g. /help set by BotFather)
    if (text.startsWith('/')) return;

    // Regular message → forward to bus
    const displayName =
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || undefined;

    this.onMessage?.({
      channel: 'telegram',
      channelUserId: chatId,
      channelMessageId: String(msg.message_id),
      botId: this.getBotId(chatId),
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
    // Ignore streaming events & surf_status — Telegram gets final messages only
  }

  // --- Helpers ---

  private getBotId(chatId: string): string {
    return this.userBotMap.get(chatId) ?? this.config.defaultBot;
  }

  private async sendText(chatId: string, text: string): Promise<void> {
    try {
      await fetch(`${this.api}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    } catch (e) {
      console.error('[telegram] send error:', e);
    }
  }

  private async setWebhook(url: string): Promise<void> {
    const res = await fetch(`${this.api}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = (await res.json()) as any;
    if (!data.ok) console.error('[telegram] setWebhook failed:', data);
  }

  private async deleteWebhook(): Promise<void> {
    await fetch(`${this.api}/deleteWebhook`, { method: 'POST' }).catch(() => {});
  }
}
