import { Hono } from 'hono';
import {
  listUsers, setUserAdmin, findUserById,
  getAuditSummary, getAuditDetails, countAdmins,
} from '../db/queries';
import { requireAdminMiddleware } from './_helpers';

/**
 * Admin-only routes. Mounted at /api/admin behind requireAdminMiddleware
 * so a normal user gets a clean 403 instead of a confusing empty payload.
 *
 * Two responsibilities live here:
 *   1. User management (list, promote/demote admins).
 *   2. Cross-user token audit (see who's burning what).
 *
 * Per-user "my own audit" stays in audit.ts and is automatically scoped to
 * the authenticated user — admins use these endpoints when they need the
 * global view.
 */
export const adminRoutes = new Hono();

adminRoutes.use('*', requireAdminMiddleware);

// ── Users ──────────────────────────────────────────────────────────────────

adminRoutes.get('/users', (c) => {
  return c.json(listUsers());
});

adminRoutes.patch('/users/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ isAdmin?: boolean }>().catch(() => ({} as any));

  const target = findUserById(id);
  if (!target) return c.json({ error: 'not found' }, 404);

  if (typeof body.isAdmin === 'boolean') {
    // Refuse to demote the last admin — easy way to lock yourself out.
    if (!body.isAdmin && target.is_admin && countAdmins() <= 1) {
      return c.json({ error: 'cannot demote the only admin' }, 400);
    }
    setUserAdmin(id, body.isAdmin);
  }

  return c.json({ ok: true });
});

// ── Audit (global) ─────────────────────────────────────────────────────────

adminRoutes.get('/audit/summary', (c) => {
  const groupByRaw = c.req.query('groupBy') ?? 'task_type';
  const groupBy: 'task_type' | 'model' | 'user' =
    groupByRaw === 'model' ? 'model' :
    groupByRaw === 'user' ? 'user' : 'task_type';
  const from = parseInt(c.req.query('from') ?? '0') || 0;
  const to = parseInt(c.req.query('to') ?? '0') || Math.floor(Date.now() / 1000);
  return c.json(getAuditSummary(from, to, groupBy));
});

adminRoutes.get('/audit/details', (c) => {
  const limit = parseInt(c.req.query('limit') ?? '100');
  const offset = parseInt(c.req.query('offset') ?? '0');
  const userIdFilter = c.req.query('userId') || null;
  return c.json(getAuditDetails(limit, offset, userIdFilter));
});
