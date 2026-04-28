import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import {
  listSkillsForUser, findSkill, findSkillByName,
  createSkill, updateSkill, deleteSkill,
} from '../db/queries';
import {
  seedDefaultSkillsForUser, summarizeSkill, loadAnthropicPresets,
} from '../core/skills';
import { findUser, getOrCreateUser } from './_helpers';

export const skillsRoutes = new Hono();

// List the caller's skills. Seeding the bundled Anthropic presets is lazy —
// the first GET for a fresh user inserts them disabled, so the catalog isn't
// empty on first visit. Failures here should not break the response (worst
// case the user just sees an empty list and can add skills manually).
skillsRoutes.get('/', async (c) => {
  const user = findUser(c);
  try { await seedDefaultSkillsForUser(user.id); } catch (e) {
    console.error('[skills] seed failed:', e);
  }
  const rows = listSkillsForUser(user.id);
  return c.json(rows.map(summarizeSkill));
});

// Full row including body — used by the inline editor.
skillsRoutes.get('/:id', (c) => {
  const user = findUser(c);
  const row = findSkill(c.req.param('id'));
  if (!row || row.user_id !== user.id) {
    return c.json({ error: 'not found' }, 404);
  }
  return c.json({
    ...summarizeSkill(row),
    body: row.body,
  });
});

// Refresh-from-source: re-runs the seeder. Useful after pulling new bundle
// files. Only touches preset rows the user hasn't edited.
skillsRoutes.post('/reseed', async (c) => {
  const user = getOrCreateUser(c);
  await seedDefaultSkillsForUser(user.id);
  return c.json({ ok: true });
});

// Inspect what presets are available (for the "add from preset" picker).
skillsRoutes.get('/_presets/list', async (c) => {
  const presets = await loadAnthropicPresets();
  return c.json(presets.map(p => ({
    name: p.name,
    description: p.description,
    source: p.source,
    source_url: p.sourceUrl,
    license: p.license,
  })));
});

skillsRoutes.post('/', async (c) => {
  const body = await c.req.json<{
    name: string; description?: string; body?: string; enabled?: boolean;
  }>();
  const name = (body.name || '').trim();
  if (!name) return c.json({ error: 'name required' }, 400);
  const user = getOrCreateUser(c);
  if (findSkillByName(user.id, name)) {
    return c.json({ error: 'name already in use' }, 409);
  }
  const id = `sk_${randomUUID().slice(0, 12)}`;
  createSkill({
    id, userId: user.id, name,
    description: body.description ?? '',
    body: body.body ?? '',
    enabled: !!body.enabled,
    source: 'user',
  });
  return c.json({ id });
});

skillsRoutes.patch('/:id', async (c) => {
  const user = findUser(c);
  const id = c.req.param('id');
  const row = findSkill(id);
  if (!row || row.user_id !== user.id) {
    return c.json({ error: 'not found' }, 404);
  }
  const body = await c.req.json<{
    name?: string; description?: string; body?: string;
    enabled?: boolean;
  }>();
  if (body.name !== undefined) {
    const next = body.name.trim();
    if (!next) return c.json({ error: 'name required' }, 400);
    if (next !== row.name) {
      const clash = findSkillByName(user.id, next);
      if (clash && clash.id !== row.id) return c.json({ error: 'name already in use' }, 409);
    }
  }
  updateSkill(id, {
    name: body.name?.trim(),
    description: body.description,
    body: body.body,
    enabled: body.enabled,
  });
  return c.json({ ok: true });
});

skillsRoutes.delete('/:id', (c) => {
  const user = findUser(c);
  const row = findSkill(c.req.param('id'));
  if (!row || row.user_id !== user.id) {
    return c.json({ error: 'not found' }, 404);
  }
  deleteSkill(row.id);
  return c.json({ ok: true });
});
