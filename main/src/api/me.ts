import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import {
  getUserDashboardProfile, upsertUserDashboardProfile, setUserDisplayName,
  listAiPicks, createAiPick, softDeleteAiPick, hardDeleteAiPick,
  listModelAssignments, upsertModelAssignment, MODEL_TASK_TYPES,
  type ModelTaskType,
} from '../db/queries';
import { modelFor } from '../core/models';
import { findUser, getOrCreateUser } from './_helpers';

export const meRoutes = new Hono();

// "Who am I?" — drives the web client's initial render. 401 from the global
// middleware → frontend shows the login/redeem screen.
meRoutes.get('/', (c) => {
  const user = findUser(c);
  return c.json({
    user_id: user.id,
    display_name: user.display_name,
    is_admin: !!user.is_admin,
  });
});

// ── Profile ──

meRoutes.get('/profile', (c) => {
  const user = findUser(c);
  const dash = getUserDashboardProfile(user.id);
  return c.json({
    user_id: user.id,
    display_name: user.display_name,
    is_admin: !!user.is_admin,
    bio: dash?.bio ?? '',
    avatar_path: dash?.avatar_path ?? null,
    custom_fields: dash?.custom_fields_json ? safeParse(dash.custom_fields_json) : {},
  });
});

meRoutes.patch('/profile', async (c) => {
  const body = await c.req.json<{
    displayName?: string;
    bio?: string;
    avatarPath?: string | null;
    customFields?: Record<string, unknown>;
  }>();
  const user = getOrCreateUser(c);

  if (typeof body.displayName === 'string' && body.displayName.trim()) {
    setUserDisplayName(user.id, body.displayName.trim());
  }
  if (
    typeof body.bio === 'string' || body.avatarPath !== undefined ||
    body.customFields !== undefined
  ) {
    const existing = getUserDashboardProfile(user.id);
    upsertUserDashboardProfile({
      userId: user.id,
      bio: body.bio ?? existing?.bio ?? null,
      avatarPath: body.avatarPath !== undefined
        ? body.avatarPath
        : (existing?.avatar_path ?? null),
      customFieldsJson: body.customFields !== undefined
        ? JSON.stringify(body.customFields)
        : (existing?.custom_fields_json ?? null),
    });
  }
  return c.json({ ok: true });
});

// ── AI picks ──

meRoutes.get('/picks', (c) => {
  const includeRemoved = c.req.query('includeRemoved') === '1';
  const user = findUser(c);
  return c.json(listAiPicks(user.id, includeRemoved));
});

// Manual user-side add (typically picks come from AI tools, but the user
// can also bookmark something they want the AI to remember).
meRoutes.post('/picks', async (c) => {
  const body = await c.req.json<{
    title: string; url?: string;
    summary?: string; whyPicked?: string;
  }>();
  if (!body.title) return c.json({ error: 'title required' }, 400);
  const user = getOrCreateUser(c);

  const id = `pk_${randomUUID().slice(0, 12)}`;
  createAiPick({
    id, userId: user.id, title: body.title,
    url: body.url, summary: body.summary, whyPicked: body.whyPicked,
    pickedByBotId: null,
  });
  return c.json({ id });
});

meRoutes.delete('/picks/:id', (c) => {
  const hard = c.req.query('hard') === '1';
  if (hard) hardDeleteAiPick(c.req.param('id'));
  else softDeleteAiPick(c.req.param('id'));
  return c.json({ ok: true });
});

// ── Model assignments (one slug per task type) ──

meRoutes.get('/model-assignments', (c) => {
  const rows = listModelAssignments();
  const map: Record<string, string> = {};
  for (const t of MODEL_TASK_TYPES) {
    // modelFor() falls back to config.yaml if the row is missing. The UI
    // sees a fully-populated map either way, so the user always knows what
    // model is in effect.
    map[t] = rows.find(r => r.task_type === t)?.slug ?? modelFor(t);
  }
  return c.json(map);
});

meRoutes.patch('/model-assignments', async (c) => {
  const body = await c.req.json<Partial<Record<ModelTaskType, string>>>();
  for (const taskType of MODEL_TASK_TYPES) {
    const slug = body[taskType];
    if (typeof slug === 'string' && slug.trim()) {
      upsertModelAssignment(taskType, slug.trim());
    }
  }
  return c.json({ ok: true });
});

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}
