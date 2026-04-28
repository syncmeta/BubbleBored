import {
  getUserQuota, upsertUserQuota, rolloverQuotaPeriod, chargeUserQuota,
  type UserQuotaRow,
} from '../db/queries';
import { readOpenrouterByok } from './byok';

// Per-user monthly USD budget on the platform-funded OpenRouter key. Users
// who set a BYOK key bypass the entire quota path — they're spending their
// own money. Callers:
//   - assertQuota(userId, taskType): pre-check before an LLM call. Throws
//     QuotaExceededError when the user is hard-blocked. Returns silently
//     for BYOK users.
//   - chargeQuota(userId, costUsd): post-call hook fired from the audit
//     pipeline. No-op for BYOK users.
//
// Period = calendar month (UTC). Rollover is lazy: any read that finds
// `now > period_end` resets used_usd to 0 and advances the window.

export class QuotaExceededError extends Error {
  budgetUsd: number;
  usedUsd: number;
  resetAt: number;
  constructor(budgetUsd: number, usedUsd: number, resetAt: number) {
    super('quota exceeded');
    this.name = 'QuotaExceededError';
    this.budgetUsd = budgetUsd;
    this.usedUsd = usedUsd;
    this.resetAt = resetAt;
  }
}

const DEFAULT_MONTHLY_BUDGET_USD = (() => {
  const raw = process.env.DEFAULT_MONTHLY_BUDGET_USD;
  const v = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : 0.30;
})();

function monthBoundsForNow(now: number = Math.floor(Date.now() / 1000)): {
  start: number; end: number;
} {
  const d = new Date(now * 1000);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  return { start, end };
}

function ensureFresh(userId: string): UserQuotaRow {
  let q = getUserQuota(userId);
  const now = Math.floor(Date.now() / 1000);
  const { start, end } = monthBoundsForNow(now);
  if (!q) {
    upsertUserQuota(userId, start, end, DEFAULT_MONTHLY_BUDGET_USD);
    q = getUserQuota(userId)!;
  } else if (now >= q.period_end) {
    rolloverQuotaPeriod(userId, start, end);
    q = getUserQuota(userId)!;
  }
  return q;
}

// Pre-check a user's budget. Throws QuotaExceededError when over. BYOK users
// short-circuit — their money, their problem.
export function assertQuota(userId: string): void {
  if (readOpenrouterByok(userId)) return;
  const q = ensureFresh(userId);
  if (q.hard_blocked || q.used_usd >= q.monthly_budget_usd) {
    throw new QuotaExceededError(q.monthly_budget_usd, q.used_usd, q.period_end);
  }
}

// Post-call hook. Called from the audit-write path with the OpenRouter
// generation cost. BYOK users skip — their cost was already paid upstream.
export function chargeQuota(userId: string, costUsd: number | undefined): void {
  if (!costUsd || costUsd <= 0) return;
  if (readOpenrouterByok(userId)) return;
  ensureFresh(userId); // make sure row exists + period is current
  chargeUserQuota(userId, costUsd);
}

export function getQuotaSummary(userId: string): {
  byok: boolean;
  monthlyBudgetUsd: number;
  usedUsd: number;
  remainingUsd: number;
  periodStart: number;
  periodEnd: number;
} {
  const byok = !!readOpenrouterByok(userId);
  const q = ensureFresh(userId);
  return {
    byok,
    monthlyBudgetUsd: q.monthly_budget_usd,
    usedUsd: q.used_usd,
    remainingUsd: Math.max(0, q.monthly_budget_usd - q.used_usd),
    periodStart: q.period_start,
    periodEnd: q.period_end,
  };
}
