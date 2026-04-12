import { configManager } from '../config/loader';
import { upsertBot, findBot } from '../db/queries';

export function syncBots(): void {
  const botIds = configManager.getBotIds();
  for (const id of botIds) {
    const config = configManager.getBotConfig(id);
    const configHash = JSON.stringify(config);
    upsertBot(id, config.displayName, configHash);
    console.log(`[bots] synced: ${id} (${config.displayName})`);
  }
}

export function getBotDisplayName(botId: string): string {
  try {
    return configManager.getBotConfig(botId).displayName;
  } catch {
    const bot = findBot(botId);
    return bot?.display_name ?? botId;
  }
}
