import { Hono } from 'hono';
import { getAuditSummary, getAuditDetails } from '../db/queries';
import { findUser } from './_helpers';

// Token audit, scoped to the calling user. Admin "see everyone" lives in
// admin.ts at /api/admin/audit/* — this endpoint never returns rows for
// any user other than the caller, so it's safe to expose to all accounts.
export const auditRoutes = new Hono();

auditRoutes.get('/summary', (c) => {
  const user = findUser(c);
  const groupByRaw = c.req.query('groupBy') ?? 'task_type';
  const groupBy: 'task_type' | 'model' =
    groupByRaw === 'model' ? 'model' : 'task_type';
  const from = parseInt(c.req.query('from') ?? '0') || 0;
  const to = parseInt(c.req.query('to') ?? '0') || Math.floor(Date.now() / 1000);
  return c.json(getAuditSummary(from, to, groupBy, user.id));
});

auditRoutes.get('/details', (c) => {
  const user = findUser(c);
  const limit = parseInt(c.req.query('limit') ?? '100');
  const offset = parseInt(c.req.query('offset') ?? '0');
  return c.json(getAuditDetails(limit, offset, user.id));
});
