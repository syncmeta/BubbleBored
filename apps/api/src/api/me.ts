import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import {
  getUserDashboardProfile, upsertUserDashboardProfile, setUserDisplayName,
  listAiPicks, createAiPick, softDeleteAiPick, hardDeleteAiPick,
} from '../db/queries';
import { findUser, getOrCreateUser } from './_helpers';
import { saveOpenrouterByok, saveJinaByok, summarizeByok } from '../core/byok';
import { getQuotaSummary } from '../core/quota';

export const meRoutes = new Hono();

// "Who am I?" — drives the web client's initial render. 401 from the global
// middleware → frontend shows the login/redeem screen.
meRoutes.get('/', (c) => {
  const user = findUser(c);
  return c.json({
    user_id: user.id,
    display_name: user.display_name,
    email: user.email ?? null,
    first_name: user.first_name ?? null,
    last_name: user.last_name ?? null,
    username: user.username ?? null,
    image_url: user.image_url ?? null,
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
    email: user.email ?? null,
    first_name: user.first_name ?? null,
    last_name: user.last_name ?? null,
    username: user.username ?? null,
    image_url: user.image_url ?? null,
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

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}

// ── BYOK (bring-your-own-key) ─────────────────────────────────────────────
//
// Lets a user supply their own OpenRouter (and optionally Jina) API key. When
// set, all LLM calls made on behalf of that user route through their key —
// they pay OpenRouter directly and bypass the platform quota entirely.
//
// We never return decrypted keys; only `configured` + `last4` so the UI can
// say "✓ saved (sk-xxxx)". To rotate, the user re-PUTs; to remove, DELETE.

meRoutes.get('/keys', (c) => {
  const user = findUser(c);
  return c.json(summarizeByok(user.id));
});

meRoutes.put('/keys', async (c) => {
  const body = await c.req.json<{
    openrouter?: string | null;
    jina?: string | null;
  }>().catch(() => ({} as { openrouter?: string | null; jina?: string | null }));
  const user = getOrCreateUser(c);
  if (body.openrouter !== undefined) saveOpenrouterByok(user.id, body.openrouter ?? null);
  if (body.jina !== undefined) saveJinaByok(user.id, body.jina ?? null);
  return c.json(summarizeByok(user.id));
});

meRoutes.delete('/keys', (c) => {
  const user = getOrCreateUser(c);
  saveOpenrouterByok(user.id, null);
  saveJinaByok(user.id, null);
  return c.json(summarizeByok(user.id));
});

// ── Quota status (powers the "this month: $0.07 / $0.30" UI) ─────────────

meRoutes.get('/quota', (c) => {
  const user = findUser(c);
  return c.json(getQuotaSummary(user.id));
});
