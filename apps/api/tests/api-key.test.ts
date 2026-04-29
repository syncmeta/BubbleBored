import './setup';
import { describe, expect, test } from 'bun:test';
import { randomUUID, randomBytes } from 'crypto';

import { createUser, createApiKey, revokeApiKey } from '../src/db/queries';
import { hashApiKey, resolveRawKey, base64UrlEncode } from '../src/api/_helpers';

function mintKey(userId: string): { id: string; raw: string } {
  const id = randomUUID();
  const raw = `pbk_live_${base64UrlEncode(randomBytes(32)).slice(0, 32)}`;
  createApiKey({
    id,
    keyPrefix: raw.slice(0, 12),
    keyHash: hashApiKey(raw),
    userId,
    name: 'test',
    shareToken: null,
    shareBaseUrl: null,
    shareAltUrls: null,
    createdBy: null,
  });
  return { id, raw };
}

describe('api key auth', () => {
  test('hashApiKey is deterministic and 64-char hex', () => {
    const a = hashApiKey('hello');
    const b = hashApiKey('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('hashApiKey discriminates between similar keys', () => {
    expect(hashApiKey('hello ')).not.toBe(hashApiKey('hello'));
    expect(hashApiKey('Hello')).not.toBe(hashApiKey('hello'));
  });

  test('resolveRawKey returns null for empty / unknown / malformed input', () => {
    expect(resolveRawKey('')).toBeNull();
    expect(resolveRawKey('not-a-real-key')).toBeNull();
  });

  test('resolveRawKey returns user+apiKey for a valid key', () => {
    const userId = randomUUID();
    createUser(userId, 'web', randomUUID(), 'key-test', false);
    const { id, raw } = mintKey(userId);

    const resolved = resolveRawKey(raw);
    expect(resolved).not.toBeNull();
    expect(resolved!.user.id).toBe(userId);
    expect(resolved!.apiKey.id).toBe(id);
  });

  test('resolveRawKey rejects revoked keys', () => {
    const userId = randomUUID();
    createUser(userId, 'web', randomUUID(), 'revoked-test', false);
    const { id, raw } = mintKey(userId);

    expect(resolveRawKey(raw)).not.toBeNull();
    revokeApiKey(id);
    expect(resolveRawKey(raw)).toBeNull();
  });
});
