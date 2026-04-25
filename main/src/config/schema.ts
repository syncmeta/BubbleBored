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
  maxRequests: z.number().int().default(10),
  // Burn one serendipity slot (legacy blind wanderer + curator + bridges)
  // every N successful runs. 0 disables the slot. The vector path is the
  // default; this just keeps cross-domain surprise alive at low frequency.
  serendipityEveryN: z.number().int().min(0).default(5),
  // Days within which a (topic, mode) vector is treated as "recently dug"
  // and skipped by the picker. Surfaced in the 你 tab.
  dedupWindowDays: z.number().int().min(0).default(14),
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
  }),
  openrouter: z.object({
    defaultModel: z.string().default('anthropic/claude-sonnet-4'),
    debounceModel: z.string().default('openrouter/free'),
    reviewModel: z.string().optional(),
    surfingModel: z.string().optional(),
    titleModel: z.string().optional(),
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
