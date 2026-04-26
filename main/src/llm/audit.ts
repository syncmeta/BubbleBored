import { insertAudit } from '../db/queries';

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
}
