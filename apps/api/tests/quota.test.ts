import './setup';
import { describe, expect, test, beforeAll } from 'bun:test';
import { randomUUID } from 'crypto';

import { createUser } from '../src/db/queries';
import {
  assertQuota, chargeQuota, getQuotaSummary, QuotaExceededError,
} from '../src/core/quota';

describe('quota', () => {
  let userId: string;

  beforeAll(() => {
    userId = randomUUID();
    createUser(userId, 'web', randomUUID(), 'tester', false);
  });

  test('first read seeds row at default budget with zero used', () => {
    const s = getQuotaSummary(userId);
    expect(s.byok).toBe(false);
    expect(s.usedUsd).toBe(0);
    expect(s.monthlyBudgetUsd).toBeGreaterThan(0);
    expect(s.remainingUsd).toBe(s.monthlyBudgetUsd);
  });

  test('chargeQuota adds to used_usd', () => {
    const before = getQuotaSummary(userId);
    chargeQuota(userId, 0.05);
    const after = getQuotaSummary(userId);
    // SQLite stores as REAL; allow a tiny float tolerance.
    expect(after.usedUsd).toBeCloseTo(before.usedUsd + 0.05, 6);
  });

  test('chargeQuota ignores zero / negative / undefined cost', () => {
    const before = getQuotaSummary(userId);
    chargeQuota(userId, 0);
    chargeQuota(userId, -1);
    chargeQuota(userId, undefined);
    const after = getQuotaSummary(userId);
    expect(after.usedUsd).toBeCloseTo(before.usedUsd, 6);
  });

  test('assertQuota throws QuotaExceededError when over budget', () => {
    const u = randomUUID();
    createUser(u, 'web', randomUUID(), 'over-budget', false);
    const summary = getQuotaSummary(u);
    // Charge enough to exceed budget. chargeQuota itself doesn't throw —
    // it's the next assertQuota that should.
    chargeQuota(u, summary.monthlyBudgetUsd + 0.01);
    expect(() => assertQuota(u)).toThrow(QuotaExceededError);
  });
});
