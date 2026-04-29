import { insertAudit } from '../db/queries';
import { chargeQuota } from '../core/quota';

export type TaskType =
  | 'chat' | 'review' | 'review_eval' | 'review_followup'
  | 'surfing' | 'surfing_eval' | 'title'
  | 'debate' | 'portrait' | 'perception';

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
    try { chargeQuota(params.userId, params.costUsd); } catch {}
  }
}
