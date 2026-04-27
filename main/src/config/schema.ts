import { z } from 'zod';

export const ReviewConfigSchema = z.object({
  enabled: z.boolean().default(true),
  roundInterval: z.number().int().min(1).default(8),
  timerMs: z.number().int().min(1000).default(10000),
  maxSearchRequests: z.number().int().default(10),
});

export const SurfingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  autoTrigger: z.boolean().default(true),
  initialIntervalSec: z.number().int().default(1800),
  multiplier: z.number().default(1.5),
  maxIntervalSec: z.number().int().default(86400),
  idleStopSec: z.number().int().default(172800),
  // Hard cost cap per surf run (USD). The agent sees its own cumulative spend
  // each turn and decides when to wrap up; this is the upper bound that
  // forces a finish even if the agent wanted to keep going.
  costBudgetUsd: z.number().positive().default(0.30),
  // How many recent first-person journal entries to surface in the chat
  // system prompt so the bot can naturally reference its own surf experiences.
  journalEntriesInChat: z.number().int().min(0).default(5),
});

export const DebounceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxWaitMs: z.number().int().default(15000),
});

export const TelegramBotConfigSchema = z.object({
  enabled: z.boolean().default(false),
  token: z.string().default(''),
  webhookUrl: z.string().optional(),
});

export const FeishuBotConfigSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  verificationToken: z.string().default(''),
});

export const BotConfigSchema = z.object({
  displayName: z.string(),
  model: z.string().optional(),
  promptFile: z.string().optional(),
  accessMode: z.enum(['open', 'approval', 'private']).optional(),
  creators: z.array(z.string()).optional(),
  review: ReviewConfigSchema.partial().optional(),
  surfing: SurfingConfigSchema.partial().optional(),
  debounce: DebounceConfigSchema.partial().optional(),
  skills: z.array(z.string()).optional(),
  telegram: TelegramBotConfigSchema.optional(),
  feishu: FeishuBotConfigSchema.optional(),
});

export const GlobalConfigSchema = z.object({
  server: z.object({
    port: z.number().int().default(3000),
    host: z.string().default('0.0.0.0'),
    // Optional public-facing base URL (scheme + host + optional port). When
    // set, the iOS share-link admin panel defaults to this URL so links
    // sent over WeChat/email work from anywhere on the internet — not just
    // the LAN you happen to be admin'ing from. Example: "https://bot.example.com".
    publicURL: z.string().optional(),
  }),
  openrouter: z.object({
    // Per-task model assignment. `chat` is the fallback for bots that don't
    // set their own `model`. The other slots are system-wide capabilities
    // invoked by features (surfing, vision routing) regardless of which bot
    // the user is talking to.
    models: z.object({
      // Default chat model when a bot omits its own. Per-bot override via
      // bots.<id>.model still wins (each preset bot is its own model).
      chat: z.string().default('x-ai/grok-4.20'),
      // Anything that requires reading the user — profile / picks / surf
      // summary / first-person bot journal. "涉及人的分析"
      humanAnalysis: z.string().default('anthropic/claude-opus-4.7'),
      // Agent loop drivers — what to search next, when to stop.
      // "涉及 agent 决策"
      agentDecision: z.string().default('z-ai/glm-5.1'),
      // Long-page compression behind the read_url tool.
      skim: z.string().default('deepseek/deepseek-v4-pro'),
      // Routed when a user message carries an image attachment, regardless of
      // the bot's own model. Defaults to the same model as humanAnalysis.
      vision: z.string().default('anthropic/claude-opus-4.7'),
    }).default({}),
  }),
  defaults: z.object({
    accessMode: z.enum(['open', 'approval', 'private']).default('open'),
    review: ReviewConfigSchema.default({}),
    surfing: SurfingConfigSchema.default({}),
    debounce: DebounceConfigSchema.default({}),
  }).default({}),
  bots: z.record(z.string(), BotConfigSchema).default({}),
});

export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;
export type SurfingConfig = z.infer<typeof SurfingConfigSchema>;
export type DebounceConfig = z.infer<typeof DebounceConfigSchema>;
export type BotConfig = z.infer<typeof BotConfigSchema>;
export type TelegramBotConfig = z.infer<typeof TelegramBotConfigSchema>;
export type FeishuBotConfig = z.infer<typeof FeishuBotConfigSchema>;
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

export interface ResolvedBotConfig {
  id: string;
  displayName: string;
  model: string;
  promptFile: string;
  accessMode: 'open' | 'approval' | 'private';
  creators: string[];
  review: ReviewConfig;
  surfing: SurfingConfig;
  debounce: DebounceConfig;
  skills: string[];
}
