import { parse } from 'yaml';
import { watchFile } from 'fs';
import { GlobalConfigSchema, type GlobalConfig, type ResolvedBotConfig } from './schema';
import { join } from 'path';

const ROOT = join(import.meta.dir, '../..');

class ConfigManager {
  private config!: GlobalConfig;
  private listeners = new Set<(config: GlobalConfig) => void>();

  async load(): Promise<GlobalConfig> {
    const raw = await Bun.file(join(ROOT, 'config.yaml')).text();
    const parsed = parse(raw);
    this.config = GlobalConfigSchema.parse(parsed);
    return this.config;
  }

  watch(): void {
    watchFile(join(ROOT, 'config.yaml'), { interval: 1000 }, async () => {
      try {
        await this.load();
        for (const fn of this.listeners) fn(this.config);
        console.log('[config] reloaded config.yaml');
      } catch (e: any) {
        console.error('[config] invalid config, keeping previous:', e.message);
      }
    });
  }

  get(): GlobalConfig {
    return this.config;
  }

  async readPrompt(relativePath: string): Promise<string> {
    return Bun.file(join(ROOT, 'prompts', relativePath)).text();
  }

  getBotConfig(botId: string): ResolvedBotConfig {
    const bot = this.config.bots[botId];
    if (!bot) {
      throw new Error(`Bot "${botId}" not found in config`);
    }
    const d = this.config.defaults;
    return {
      id: botId,
      displayName: bot.displayName,
      model: bot.model ?? this.config.openrouter.models.chat,
      promptFile: bot.promptFile ?? `${botId}.md`,
      accessMode: bot.accessMode ?? d.accessMode,
      creators: bot.creators ?? [],
      review: { ...d.review, ...bot.review },
      surfing: { ...d.surfing, ...bot.surfing },
      debounce: { ...d.debounce, ...bot.debounce },
      skills: bot.skills ?? [],
    };
  }

  getBotIds(): string[] {
    return Object.keys(this.config.bots);
  }

  onChange(fn: (config: GlobalConfig) => void): void {
    this.listeners.add(fn);
  }
}

export const configManager = new ConfigManager();
