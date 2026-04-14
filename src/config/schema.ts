import { z } from 'zod';

export const ReviewConfigSchema = z.object({
  enabled: z.boolean().default(true),
  roundInterval: z.number().int().min(1).default(8),
  timerMs: z.number().int().min(1000).default(10000),
});

export const SurfingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  autoTrigger: z.boolean().default(true),
  initialIntervalSec: z.number().int().default(1800),
  multiplier: z.number().default(1.5),
  maxIntervalSec: z.number().int().default(86400),
  idleStopSec: z.number().int().default(172800),
  maxRequests: z.number().int().default(10),
});

export const DebounceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  windowMs: z.number().int().default(2000),
  maxWaitMs: z.number().int().default(15000),
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
});

export const TelegramConfigSchema = z.object({
  enabled: z.boolean().default(false),
  token: z.string().default(''),
  defaultBot: z.string().default('default'),
  webhookUrl: z.string().optional(),
});

export const FeishuConfigSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  defaultBot: z.string().default('default'),
  verificationToken: z.string().default(''),
});

export const GlobalConfigSchema = z.object({
  server: z.object({
    port: z.number().int().default(3000),
    host: z.string().default('0.0.0.0'),
  }),
  openrouter: z.object({
    defaultModel: z.string().default('anthropic/claude-sonnet-4'),
    debounceModel: z.string().default('meta-llama/llama-3.3-70b-instruct:free'),
    reviewModel: z.string().optional(),
    surfingModel: z.string().optional(),
  }),
  defaults: z.object({
    accessMode: z.enum(['open', 'approval', 'private']).default('open'),
    review: ReviewConfigSchema.default({}),
    surfing: SurfingConfigSchema.default({}),
    debounce: DebounceConfigSchema.default({}),
  }).default({}),
  bots: z.record(z.string(), BotConfigSchema).default({}),
  telegram: TelegramConfigSchema.default({}),
  feishu: FeishuConfigSchema.default({}),
});

export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;
export type SurfingConfig = z.infer<typeof SurfingConfigSchema>;
export type DebounceConfig = z.infer<typeof DebounceConfigSchema>;
export type BotConfig = z.infer<typeof BotConfigSchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>;
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
