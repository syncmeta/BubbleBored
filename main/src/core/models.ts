// Resolve the model slug to use for a given task type.
//
// Source of truth: model_assignments table (UI-managed). config.yaml's
// openrouter.* fields are kept only as the seed values for first-time setup
// and as a last-resort fallback when the table doesn't have a row yet.

import {
  getModelAssignment, upsertModelAssignment,
  type ModelTaskType,
} from '../db/queries';
import { configManager } from '../config/loader';

function configFallback(taskType: ModelTaskType): string {
  const c = configManager.get().openrouter;
  switch (taskType) {
    case 'chat':       return c.defaultModel;
    case 'review':     return c.reviewModel ?? c.defaultModel;
    case 'surfing':    return c.surfingModel ?? c.defaultModel;
    case 'title':      return c.titleModel ?? c.debounceModel ?? c.defaultModel;
    case 'perception': return c.debounceModel ?? c.defaultModel;
    case 'portrait':   return c.defaultModel;
  }
}

export function modelFor(taskType: ModelTaskType): string {
  const assigned = getModelAssignment(taskType);
  if (assigned) return assigned;
  return configFallback(taskType);
}

// One-time seed: ensure each task type has an assignment, defaulting to the
// config.yaml value. Picker pulls the searchable list from OpenRouter, so we
// don't need to register the slug anywhere local.
export function ensureModelAssignmentsSeeded(): void {
  const taskTypes: ModelTaskType[] = [
    'chat', 'review', 'surfing', 'title', 'perception', 'portrait',
  ];
  for (const t of taskTypes) {
    if (getModelAssignment(t)) continue;
    const slug = configFallback(t);
    if (!slug) continue;
    upsertModelAssignment(t, slug);
  }
}
