import { getDb } from '../../db/index';
import { configManager } from '../../config/loader';
import { updateSurfState } from '../../db/queries';
import { messageBus } from '../../bus/router';

export function startSurfingScheduler(): void {
  setInterval(() => {
    checkAllConversations().catch(e =>
      console.error('[surf-scheduler] error:', e)
    );
  }, 60_000); // Every minute
  console.log('[surf] scheduler started');
}

async function checkAllConversations(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();

  // Find active conversations with surfing enabled
  const convs = db.query<any, [number]>(
    `SELECT c.*, b.id as bot_id_ref FROM conversations c
     JOIN bots b ON c.bot_id = b.id
     WHERE c.last_activity_at > ?`
  ).all(now - 172800); // Within 48h

  for (const conv of convs) {
    try {
      const botConfig = configManager.getBotConfig(conv.bot_id);
      if (!botConfig.surfing.enabled || !botConfig.surfing.autoTrigger) continue;

      const lastSurf = conv.surf_last_at ?? 0;
      const interval = conv.surf_interval ?? botConfig.surfing.initialIntervalSec;
      const lastActivity = conv.last_activity_at;

      // Check idle stop
      if (now - lastActivity > botConfig.surfing.idleStopSec) continue;

      // Check if enough time has passed since last surf
      if (now - lastSurf < interval) continue;

      console.log(`[surf] auto-triggering for conv ${conv.id}`);

      const replyFn = messageBus.getReplyFn(conv.id);
      if (!replyFn) continue; // No active connection

      // Run surf
      const { runSurf } = await import('./searcher');
      await runSurf(conv.id, conv.bot_id, conv.user_id, replyFn, undefined, 'auto');

      // Update decay state
      const newInterval = Math.min(
        interval * botConfig.surfing.multiplier,
        botConfig.surfing.maxIntervalSec
      );
      updateSurfState(conv.id, Math.floor(newInterval));
    } catch (e) {
      console.error(`[surf] error for conv ${conv.id}:`, e);
    }
  }
}
