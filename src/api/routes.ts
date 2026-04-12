import { Hono } from 'hono';
import { listBots, findBot } from '../db/queries';
import { configManager } from '../config/loader';

export const apiRoutes = new Hono();

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
