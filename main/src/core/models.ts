// Resolve the model slug to use for a given task type.
//
// Source of truth: model_assignments table (UI-managed). config.yaml's
// openrouter.* fields are kept only as the seed values for first-time setup
// and as a last-resort fallback when the table doesn't have a row yet.

import {
  getModelAssignment, upsertModelAssignment,
  listProviderModels, findProviderModelBySlug, createProviderModel,
  type ModelTaskType,
} from '../db/queries';
import { configManager } from '../config/loader';

function configFallback(taskType: ModelTaskType): string {
  const c = configManager.get().openrouter;
  switch (taskType) {
    case 'chat':       return c.defaultModel;
    case 'debounce':   return c.debounceModel ?? c.defaultModel;
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
// config.yaml value, and ensure the slugs being assigned exist in the
// provider_models library so the UI picker shows them.
export function ensureModelAssignmentsSeeded(): void {
  const taskTypes: ModelTaskType[] = [
    'chat', 'debounce', 'review', 'surfing', 'title', 'perception', 'portrait',
  ];
  for (const t of taskTypes) {
    if (getModelAssignment(t)) continue;
    const slug = configFallback(t);
    if (!slug) continue;
    if (!findProviderModelBySlug(slug)) {
      // Auto-register the slug with a friendly name derived from the slug
      // so the picker has it available.
      const id = `pm_${slug.replace(/[^a-z0-9]/gi, '_')}`;
      const provider = slug.split('/')[0] ?? 'custom';
      const displayName = slug.split('/').slice(1).join('/') || slug;
      try {
        createProviderModel(id, provider, slug, displayName);
      } catch {
        // Already exists from a race — ignore.
      }
    }
    upsertModelAssignment(t, slug);
  }
}
