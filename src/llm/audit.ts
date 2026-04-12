import { insertAudit } from '../db/queries';

export type TaskType = 'chat' | 'debounce' | 'review' | 'surfing' | 'surfing_eval';

export interface AuditParams {
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
