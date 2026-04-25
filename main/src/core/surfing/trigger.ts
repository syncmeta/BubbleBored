import { getDb } from '../../db/index';
import { configManager } from '../../config/loader';
import { updateSurfState } from '../../db/queries';
import { messageBus } from '../../bus/router';
import { activeSurfs, surfsByMessageConv, createSurfConversation, runSurf } from './searcher';
import { modelFor } from '../models';

// Auto-triggers a surf for active message conversations whose surf cooldown
// has expired. Each auto-triggered surf creates a new 冲浪 tab conversation
// (with source_message_conv_id set), then runs there. The final curator
// message is delivered into both the surf conv and the source message conv.
export function startSurfingScheduler(): void {
  setInterval(() => {
    checkAllConversations().catch(e =>
      console.error('[surf-scheduler] error:', e)
    );
  }, 60_000);
  console.log('[surf] scheduler started');
}

async function checkAllConversations(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();

  // Auto-trigger only fires for message conversations — surfing the 冲浪 /
  // 议论 / 画像 tabs themselves makes no sense.
  const convs = db.query<any, [number]>(
    `SELECT c.* FROM conversations c
     WHERE c.feature_type = 'message' AND c.last_activity_at > ?`
  ).all(now - 172800); // Within 48h

  for (const conv of convs) {
    try {
      const botConfig = configManager.getBotConfig(conv.bot_id);
      if (!botConfig.surfing.enabled || !botConfig.surfing.autoTrigger) continue;

      const lastSurf = conv.surf_last_at ?? 0;
      const interval = conv.surf_interval ?? botConfig.surfing.initialIntervalSec;
      const lastActivity = conv.last_activity_at;

      if (now - lastActivity > botConfig.surfing.idleStopSec) continue;
      if (now - lastSurf < interval) continue;
      if (surfsByMessageConv.has(conv.id)) continue;

      const replyFn = messageBus.getReplyFn(conv.id);
      if (!replyFn) continue; // No active connection to deliver back to

      console.log(`[surf] auto-triggering for message conv ${conv.id}`);

      const surfConvId = createSurfConversation({
        botId: conv.bot_id, userId: conv.user_id,
        sourceMessageConvId: conv.id,
        modelSlug: modelFor('surfing'),
        budget: botConfig.surfing.maxRequests,
        title: '自动冲浪',
      });

      const controller = new AbortController();
      activeSurfs.set(surfConvId, controller);
      surfsByMessageConv.set(conv.id, surfConvId);

      // Fire-and-forget — the scheduler shouldn't block on the surf.
      runSurf({
        surfConvId,
        sourceConvId: conv.id,
        replyFn,
        signal: controller.signal,
        trigger: 'auto',
      }).catch(e => console.error(`[surf] auto error for ${conv.id}:`, e));

      // Update decay state on the message conv
      const newInterval = Math.min(
        interval * botConfig.surfing.multiplier,
        botConfig.surfing.maxIntervalSec,
      );
      updateSurfState(conv.id, Math.floor(newInterval));
    } catch (e) {
      console.error(`[surf] error for conv ${conv.id}:`, e);
    }
  }
}
