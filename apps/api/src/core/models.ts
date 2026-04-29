// Resolve which model slug to use for a given task.
//
// Two resolvers:
//   - modelFor({ botId, userId?, conversationId? }) — the **chat** path.
//     Precedence: per-conv override > per-user-per-bot override >
//     bot.model > config openrouter.models.chat fallback.
//   - modelForTask(task) — system-level capability slots that are not tied to
//     a specific bot persona: human analysis (Opus), agent decision (GLM),
//     skim (cheap long-context), vision (multimodal). Pulled straight from
//     openrouter.models so swapping the slot moves every caller at once.

import { configManager } from '../config/loader';
import { findConversationById, getUserBotModel } from '../db/queries';

export type SystemTask = 'humanAnalysis' | 'agentDecision' | 'skim' | 'vision';

export interface ModelForArgs {
  botId: string;
  userId?: string;
  conversationId?: string;
}

// Overload: positional botId + conversationId for legacy callers, plus the
// new options-object form that accepts userId. Both delegate to the same
// resolution logic.
export function modelFor(botId: string, conversationId?: string): string;
export function modelFor(args: ModelForArgs): string;
export function modelFor(arg1: string | ModelForArgs, arg2?: string): string {
  const args: ModelForArgs = typeof arg1 === 'string'
    ? { botId: arg1, conversationId: arg2 }
    : arg1;
  const { botId, userId, conversationId } = args;

  if (conversationId) {
    const conv = findConversationById(conversationId) as { model_override?: string | null } | undefined;
    const override = conv?.model_override?.trim();
    if (override) return override;
  }
  if (userId) {
    const userOverride = getUserBotModel(userId, botId)?.trim();
    if (userOverride) return userOverride;
  }
  return configManager.getBotConfig(botId).model;
}

export function modelForTask(task: SystemTask): string {
  return configManager.get().openrouter.models[task];
}
