// Mint a fresh API key for the first admin (oldest is_admin=1 user) and
// print it once. Use when you've lost web/iOS access but still have shell
// access to the server. Existing keys are NOT revoked.
//
//   bun run reset-admin-key

import { randomUUID, randomBytes } from 'crypto';
import { getDb } from '../src/db';
import { createApiKey } from '../src/db/queries';
import { hashApiKey, base64UrlEncode } from '../src/api/_helpers';

const KEY_PREFIX_DISPLAY_LEN = 12;

const db = getDb();
const admin = db.query<
  { id: string; display_name: string },
  []
>(`SELECT id, display_name FROM users
   WHERE is_admin = 1
   ORDER BY created_at ASC
   LIMIT 1`).get();

if (!admin) {
  console.error('No admin user exists. Start the server — it will print a bootstrap invite link.');
  process.exit(1);
}

const raw = `pbk_live_${base64UrlEncode(randomBytes(32)).slice(0, 32)}`;
createApiKey({
  id: randomUUID(),
  keyPrefix: raw.slice(0, KEY_PREFIX_DISPLAY_LEN),
  keyHash: hashApiKey(raw),
  userId: admin.id,
  name: 'recovery',
  shareToken: null,
  shareBaseUrl: null,
  shareAltUrls: null,
  createdBy: null,
});

console.log('');
console.log('='.repeat(72));
console.log(`  Fresh API key for admin "${admin.display_name}" (${admin.id}):`);
console.log('');
console.log(`    ${raw}`);
console.log('');
console.log('  Use it as either:');
console.log('    • iOS / curl:  Authorization: Bearer <key>');
console.log('    • Web browser: open DevTools → Application → Cookies →');
console.log('                   set pb_session=<key> for your server origin, then reload');
console.log('='.repeat(72));
console.log('');
