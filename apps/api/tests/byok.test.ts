import './setup';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';

import { createUser } from '../src/db/queries';
import {
  saveOpenrouterByok, readOpenrouterByok, summarizeByok,
  verifyKekFingerprint,
} from '../src/core/byok';

describe('BYOK', () => {
  test('verifyKekFingerprint succeeds on first call and is idempotent', () => {
    expect(() => verifyKekFingerprint()).not.toThrow();
    expect(() => verifyKekFingerprint()).not.toThrow();
  });

  test('save → read round-trips the plaintext', () => {
    const userId = randomUUID();
    createUser(userId, 'web', randomUUID(), 'byok-test', false);

    const secret = 'sk-or-v1-aaaaabbbbbccccc';
    saveOpenrouterByok(userId, secret);
    expect(readOpenrouterByok(userId)).toBe(secret);
  });

  test('summarizeByok exposes only last4', () => {
    const userId = randomUUID();
    createUser(userId, 'web', randomUUID(), 'last4-test', false);

    saveOpenrouterByok(userId, 'sk-or-XYZ123-tail9999');
    const s = summarizeByok(userId);
    expect(s.openrouter.configured).toBe(true);
    expect(s.openrouter.last4).toBe('9999');
  });

  test('clearing with null erases the encrypted blob', () => {
    const userId = randomUUID();
    createUser(userId, 'web', randomUUID(), 'clear-test', false);

    saveOpenrouterByok(userId, 'sk-or-xxx');
    expect(readOpenrouterByok(userId)).not.toBeNull();

    saveOpenrouterByok(userId, null);
    expect(readOpenrouterByok(userId)).toBeNull();
  });

  test('saving an empty string is treated as clear', () => {
    const userId = randomUUID();
    createUser(userId, 'web', randomUUID(), 'empty-test', false);

    saveOpenrouterByok(userId, '   ');
    expect(readOpenrouterByok(userId)).toBeNull();
  });
});
