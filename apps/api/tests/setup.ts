// Test harness: redirect DATA_DIR to a fresh temp dir before any module
// that calls getDb() is imported. The DB module memoizes the connection on
// first use, so this MUST run before importing src/db/index or anything
// that transitively touches it.
//
// Usage at the top of every test file:
//   import './setup';   // side-effect import — must come first
//   import { …whatever } from '../src/…';

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dir = mkdtempSync(join(tmpdir(), 'pb-test-'));
process.env.DATA_DIR = dir;
// Pin a stable BYOK key so byok.ts uses the proper KEK path (and we can
// exercise the fingerprint check) instead of the ephemeral random fallback.
process.env.BYOK_ENC_KEY ??= 'test-kek-do-not-use-in-prod';
// Force log scrubbing OFF so `[chat] ← user(...)` lines are easy to assert
// in tests if we ever need to.
process.env.LOG_VERBOSE_CONTENT = '1';

process.on('exit', () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

export const TEST_DATA_DIR = dir;
