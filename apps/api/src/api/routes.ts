import { Hono } from 'hono';
import { listBots, findBot } from '../db/queries';
import { configManager } from '../config/loader';
import { resolveRawKey, setSessionCookie } from './_helpers';

export const apiRoutes = new Hono();

// Session install — POST { key } sets the pb_session cookie server-side.
// Recovery path for when the cookie has been lost: `bun run reset-admin-key`
// mints a fresh key, the user pastes a one-line `fetch` in the browser
// console to install it. Direct `document.cookie = '...'` can't work
// because the cookie is HttpOnly.
apiRoutes.post('/session/install', async (c) => {
  const body = await c.req.json<{ key?: string }>().catch(() => ({} as { key?: string }));
  const raw = (body.key ?? '').trim();
  if (!raw) return c.json({ error: 'key required' }, 400);
  const resolved = resolveRawKey(raw);
  if (!resolved) return c.json({ error: 'invalid key' }, 401);
  setSessionCookie(c, raw);
  return c.json({ ok: true, user_id: resolved.user.id });
});

// Bot list
apiRoutes.get('/bots', (c) => {
  const bots = listBots();
  const botConfigs = bots.map(b => {
    try {
      const config = configManager.getBotConfig(b.id);
      return { ...b, config };
    } catch {
      return b;
    }
  });
  return c.json(botConfigs);
});

// Bot detail
apiRoutes.get('/bots/:id', (c) => {
  const bot = findBot(c.req.param('id'));
  if (!bot) return c.json({ error: 'not found' }, 404);
  try {
    const config = configManager.getBotConfig(bot.id);
    return c.json({ ...bot, config });
  } catch {
    return c.json(bot);
  }
});
