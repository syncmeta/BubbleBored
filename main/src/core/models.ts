// Resolve which model slug to use for a given task.
//
// Two resolvers:
//   - modelFor(botId, conversationId?) — the **chat** path. Each bot owns its
//     personality and its model (per-conv override > bot.model > config
//     openrouter.models.chat fallback).
//   - modelForTask(task) — system-level capability slots that are not tied to
//     a specific bot persona: human analysis (Opus), agent decision (GLM),
//     skim (cheap long-context), vision (multimodal). Pulled straight from
//     openrouter.models so swapping the slot moves every caller at once.

import { configManager } from '../config/loader';
import { findConversationById } from '../db/queries';

export type SystemTask = 'humanAnalysis' | 'agentDecision' | 'skim' | 'vision';

export function modelFor(botId: string, conversationId?: string): string {
  if (conversationId) {
    const conv = findConversationById(conversationId) as { model_override?: string | null } | undefined;
    const override = conv?.model_override?.trim();
    if (override) return override;
  }
  return configManager.getBotConfig(botId).model;
}

export function modelForTask(task: SystemTask): string {
  return configManager.get().openrouter.models[task];
}
