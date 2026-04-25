import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import {
  findUserByChannel, createUser, findUserById,
  getUserDashboardProfile, upsertUserDashboardProfile, setUserDisplayName,
  listAiPicks, createAiPick, softDeleteAiPick, hardDeleteAiPick,
  listProviderModels, createProviderModel, updateProviderModelEnabled,
  deleteProviderModel,
  findProviderModelBySlug,
} from '../db/queries';

export const meRoutes = new Hono();

// Resolve / lazily create the user behind a web userId. Most 你-tab routes
// take ?userId= as the channel-side id (same as everywhere else).
function ensureUser(channelUserId: string) {
  let user = findUserByChannel('web', channelUserId);
  if (!user) {
    const newId = randomUUID();
    createUser(newId, 'web', channelUserId, `User-${channelUserId.slice(0, 6)}`);
    user = findUserByChannel('web', channelUserId);
  }
  return user;
}

// ── Profile ──

meRoutes.get('/profile', (c) => {
  const channelUserId = c.req.query('userId');
  if (!channelUserId) return c.json({ error: 'userId required' }, 400);
  const user = findUserByChannel('web', channelUserId);
  if (!user) return c.json({ display_name: '', bio: '', avatar_path: null });
  const dash = getUserDashboardProfile(user.id);
  return c.json({
    user_id: user.id,
    display_name: user.display_name,
    bio: dash?.bio ?? '',
    avatar_path: dash?.avatar_path ?? null,
    custom_fields: dash?.custom_fields_json ? safeParse(dash.custom_fields_json) : {},
  });
});

meRoutes.patch('/profile', async (c) => {
  const body = await c.req.json<{
    userId: string;
    displayName?: string;
    bio?: string;
    avatarPath?: string | null;
    customFields?: Record<string, unknown>;
  }>();
  if (!body.userId) return c.json({ error: 'userId required' }, 400);
  const user = ensureUser(body.userId);
  if (!user) return c.json({ error: 'user creation failed' }, 500);

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
  const channelUserId = c.req.query('userId');
  if (!channelUserId) return c.json({ error: 'userId required' }, 400);
  const includeRemoved = c.req.query('includeRemoved') === '1';
  const user = findUserByChannel('web', channelUserId);
  if (!user) return c.json([]);
  return c.json(listAiPicks(user.id, includeRemoved));
});

// Manual user-side add (typically picks come from AI tools, but the user
// can also bookmark something they want the AI to remember).
meRoutes.post('/picks', async (c) => {
  const body = await c.req.json<{
    userId: string; title: string; url?: string;
    summary?: string; whyPicked?: string;
  }>();
  if (!body.userId || !body.title) return c.json({ error: 'userId + title required' }, 400);
  const user = ensureUser(body.userId);
  if (!user) return c.json({ error: 'user creation failed' }, 500);

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

// ── Provider models (mirrors /api/debate/provider-models so the 你 tab
//    can manage the same library standalone).
meRoutes.get('/provider-models', (c) => {
  return c.json(listProviderModels(false));
});

meRoutes.post('/provider-models', async (c) => {
  const body = await c.req.json<{ provider: string; slug: string; displayName: string }>();
  if (!body.slug || !body.displayName) {
    return c.json({ error: 'slug + displayName required' }, 400);
  }
  if (findProviderModelBySlug(body.slug)) {
    return c.json({ error: '该 slug 已存在' }, 400);
  }
  const id = `pm_${body.slug.replace(/[^a-z0-9]/gi, '_')}_${randomUUID().slice(0, 6)}`;
  createProviderModel(id, body.provider || 'custom', body.slug, body.displayName);
  return c.json({ id });
});

meRoutes.patch('/provider-models/:id', async (c) => {
  const body = await c.req.json<{ enabled?: boolean }>();
  if (typeof body.enabled === 'boolean') {
    updateProviderModelEnabled(c.req.param('id'), body.enabled);
  }
  return c.json({ ok: true });
});

meRoutes.delete('/provider-models/:id', (c) => {
  deleteProviderModel(c.req.param('id'));
  return c.json({ ok: true });
});

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}
