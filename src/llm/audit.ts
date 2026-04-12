import { insertAudit, updateAuditCost } from '../db/queries';
import { fetchGenerationStats } from './client';

export type TaskType = 'chat' | 'debounce' | 'review' | 'surfing' | 'surfing_eval';

export interface AuditParams {
  conversationId?: string;
  taskType: TaskType;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  generationId?: string;
  latencyMs?: number;
}

export function logAudit(params: AuditParams): void {
  insertAudit(params);

  // Async fetch detailed cost from OpenRouter
  if (params.generationId) {
    fetchGenerationStats(params.generationId).then(stats => {
      if (stats) {
        updateAuditCost(
          params.generationId!,
          stats.totalCost ?? 0,
          stats.upstreamCost ?? 0,
          stats.generationTimeMs ?? 0
        );
      }
    }).catch(() => {});
  }
}
