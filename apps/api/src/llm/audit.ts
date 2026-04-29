import { insertAudit } from '../db/queries';
import { chargeQuota } from '../core/quota';

export type TaskType =
  | 'chat' | 'review' | 'review_eval' | 'review_followup'
  | 'surfing' | 'surfing_eval' | 'title'
  | 'debate' | 'portrait' | 'perception'
  // Synthetic — written when chargeQuota throws so we can SUM(cost_usd) over
  // these and detect billing drift without scraping logs. Never produced by
  // a real LLM call.
  | 'charge_error';

export interface AuditParams {
  userId: string;
  conversationId?: string;
  taskType: TaskType;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  costUsd?: number;
  generationId?: string;
  latencyMs?: number;
}

export function logAudit(params: AuditParams): void {
  insertAudit(params);
  // Deduct the spent USD from this user's monthly quota. chargeQuota is a
  // no-op for BYOK users (they paid OpenRouter directly with their own key).
  if (params.costUsd && params.costUsd > 0) {
    try {
      chargeQuota(params.userId, params.costUsd);
    } catch (e: any) {
      // Don't let a quota DB error mask the audit row — but DO surface it.
      // A silent catch here is exactly how billing inconsistencies would
      // accumulate undetected. This goes to stderr (Fly logs) and into
      // audit_log via a synthetic row so a daily job can spot drift.
      console.error(
        `[audit] chargeQuota failed user=${params.userId.slice(0, 8)} ` +
        `task=${params.taskType} cost=${params.costUsd}: ${e?.message ?? e}`
      );
      try {
        insertAudit({
          ...params,
          taskType: 'charge_error',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          // Keep costUsd on the synthetic row so a `SELECT SUM(cost_usd)
          // WHERE task_type='charge_error'` gives the unbilled total.
        });
      } catch {
        // If even the synthetic insert fails, the original audit row at
        // least exists; better to drop the diagnostic than to throw.
      }
    }
  }
}
