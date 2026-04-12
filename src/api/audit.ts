import { Hono } from 'hono';
import { getAuditSummary, getAuditDetails } from '../db/queries';

export const auditRoutes = new Hono();

auditRoutes.get('/summary', (c) => {
  const groupBy = c.req.query('groupBy') ?? 'task_type';
  const from = parseInt(c.req.query('from') ?? '0') || 0;
  const to = parseInt(c.req.query('to') ?? '0') || Math.floor(Date.now() / 1000);
  const data = getAuditSummary(from, to, groupBy);
  return c.json(data);
});

auditRoutes.get('/details', (c) => {
  const limit = parseInt(c.req.query('limit') ?? '100');
  const offset = parseInt(c.req.query('offset') ?? '0');
  const data = getAuditDetails(limit, offset);
  return c.json(data);
});
