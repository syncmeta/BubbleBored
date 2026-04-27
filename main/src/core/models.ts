// Resolve the model slug to use. The bot owns its model — every task (chat,
// review, surfing, title, perception, portrait, debate) runs through the bot
// the conversation belongs to, so model selection is normally a function of
// `botId`. config.yaml's `bots.<id>.model` is the source of truth, with
// `openrouter.defaultModel` as the last-resort fallback when a bot omits it.
//
// One exception: the chat path threads `conversationId` through, and a
// per-conversation override (set from the iOS chat action sheet) trumps the
// bot's default. The override is stored on the conversation row.

import { configManager } from '../config/loader';
import { findConversationById } from '../db/queries';

export function modelFor(botId: string, conversationId?: string): string {
  if (conversationId) {
    const conv = findConversationById(conversationId) as { model_override?: string | null } | undefined;
    const override = conv?.model_override?.trim();
    if (override) return override;
  }
  return configManager.getBotConfig(botId).model;
}
