import { configManager } from '../config/loader';
import { upsertBot, findBot, listBots, deleteBotCascade } from '../db/queries';

export function syncBots(): void {
  const botIds = configManager.getBotIds();
  const wanted = new Set(botIds);
  for (const id of botIds) {
    const config = configManager.getBotConfig(id);
    const configHash = JSON.stringify(config);
    upsertBot(id, config.displayName, configHash);
    console.log(`[bots] synced: ${id} (${config.displayName})`);
  }
  // Drop bot rows that are no longer in config — and their conversations,
  // since bot_id is a hard reference. Renaming a bot in config.yaml is
  // effectively a delete + create.
  for (const row of listBots() as Array<{ id: string }>) {
    if (!wanted.has(row.id)) {
      deleteBotCascade(row.id);
      console.log(`[bots] removed obsolete: ${row.id}`);
    }
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
