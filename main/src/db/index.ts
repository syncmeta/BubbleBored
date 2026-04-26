import { Database } from 'bun:sqlite';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

const ROOT = join(import.meta.dir, '../..');
const DB_PATH = join(ROOT, 'data', 'bubblebored.sqlite');

let db: Database;

export function getDb(): Database {
  if (!db) {
    const dir = join(ROOT, 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db);
  }
  return db;
}

function runMigrations(db: Database): void {
  // Base schema (idempotent — only creates tables/indexes that don't already exist)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL DEFAULT 'web',
      external_id TEXT,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      is_admin INTEGER NOT NULL DEFAULT 0,
      honcho_peer_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external ON users(channel, external_id);

    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      honcho_peer_id TEXT,
      config_hash TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      title TEXT,
      honcho_session_id TEXT,
      round_count INTEGER NOT NULL DEFAULT 0,
      last_sender TEXT,
      last_activity_at INTEGER NOT NULL DEFAULT (unixepoch()),
      surf_last_at INTEGER,
      surf_interval INTEGER DEFAULT 1800,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      sender_type TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      content TEXT NOT NULL,
      segment_index INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id),
      conversation_id TEXT,
      task_type TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER DEFAULT 0,
      cost_usd REAL,
      upstream_cost_usd REAL,
      generation_id TEXT,
      generation_time_ms INTEGER,
      latency_ms INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_log(task_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_model ON audit_log(model, created_at);

  `);
  // NOTE: indexes/tables that depend on the v16 schema (audit_log.user_id +
  // the invites table) are created inside the v16 migration block below so
  // they don't blow up when the base block runs against a pre-v16 database.

  // Versioned migrations (PRAGMA user_version is per-DB)
  const userVersion = (db.query('PRAGMA user_version').get() as any).user_version as number;

  // v1: add title column to existing conversations tables (if pre-existing without it)
  if (userVersion < 1) {
    const cols = db.query(`PRAGMA table_info(conversations)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'title')) {
      db.exec(`ALTER TABLE conversations ADD COLUMN title TEXT`);
    }
    db.exec('PRAGMA user_version = 1');
  }

  // v2: drop UNIQUE constraint on (bot_id, user_id), replace with non-unique index;
  // add index on (user_id, last_activity_at DESC) for sidebar listing
  if (userVersion < 2) {
    db.exec(`DROP INDEX IF EXISTS idx_conv_bot_user`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_bot_user ON conversations(bot_id, user_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_user_activity ON conversations(user_id, last_activity_at DESC)`);
    db.exec('PRAGMA user_version = 2');
  }

  // v3: device_tokens table for APNs (Phase 2 — schema lands now so the iOS
  // client can register tokens and the server can start collecting them even
  // before push sending is wired up).
  if (userVersion < 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS device_tokens (
        device_token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        bundle_id TEXT,
        environment TEXT NOT NULL DEFAULT 'sandbox',
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);
    `);
    db.exec('PRAGMA user_version = 3');
  }

  // v4: attachments table for image messages.
  // message_id is nullable: the client uploads first, then binds the returned
  // attachment ids to the message when sending. Orphans are swept periodically.
  if (userVersion < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT REFERENCES messages(id),
        conversation_id TEXT REFERENCES conversations(id),
        kind TEXT NOT NULL,
        mime TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_attach_msg ON attachments(message_id);
      CREATE INDEX IF NOT EXISTS idx_attach_conv ON attachments(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_attach_orphan ON attachments(message_id, created_at) WHERE message_id IS NULL;
    `);
    // Content can be empty when a message is only an image.
    // SQLite doesn't let us DROP NOT NULL, so the application layer will pass ''
    // (empty string) — which satisfies the existing NOT NULL constraint.
    db.exec('PRAGMA user_version = 4');
  }

  // v5: drop the debounce_buffer table — the in-memory debounce state is the
  // source of truth now and the SQL writes were never read back.
  if (userVersion < 5) {
    db.exec(`DROP INDEX IF EXISTS idx_debounce_conv`);
    db.exec(`DROP TABLE IF EXISTS debounce_buffer`);
    db.exec('PRAGMA user_version = 5');
  }

  // v6: feature_type on conversations — partitions the conv list across the
  // top-level tabs (message / surf / review / debate / portrait). Existing
  // rows default to 'message' so old chats keep showing up in the chat tab.
  if (userVersion < 6) {
    const cols = db.query(`PRAGMA table_info(conversations)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'feature_type')) {
      db.exec(`ALTER TABLE conversations ADD COLUMN feature_type TEXT NOT NULL DEFAULT 'message'`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_feature ON conversations(feature_type, last_activity_at DESC)`);
    db.exec('PRAGMA user_version = 6');
  }

  // v7: debate (multi-agent) tables. debate_settings holds the configured
  // model line-up and topic per debate conversation. (A provider_models
  // library table existed here historically; dropped in v12 — picker now
  // reads OpenRouter's /models list directly.)
  if (userVersion < 7) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS debate_settings (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
        model_slugs TEXT NOT NULL,
        topic TEXT,
        round_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    db.exec('PRAGMA user_version = 7');
  }

  // v8: portrait tables. A 画像 tab conv (feature_type='portrait') is the
  // chat thread with the generator agent; portraits stores each generated
  // asset (kind = moments / memos / schedule / alarms / bills) and its
  // content_json payload. source_conversation_id pins which message conv
  // the AI used to imagine the portrait.
  if (userVersion < 8) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS portraits (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        source_conversation_id TEXT REFERENCES conversations(id),
        kind TEXT NOT NULL,
        with_image INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ready',
        content_json TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_portraits_conv ON portraits(conversation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_portraits_source ON portraits(source_conversation_id);
    `);
    db.exec('PRAGMA user_version = 8');
  }

  // v9: 「你」 tab tables. user_profile is a singleton-per-user dashboard
  // record; ai_picks is the running list of articles/links bots want the user
  // to read (any bot can add/remove via tools — surfaced in 你 tab).
  if (userVersion < 9) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_profile (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        bio TEXT,
        avatar_path TEXT,
        custom_fields_json TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS ai_picks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        title TEXT NOT NULL,
        url TEXT,
        summary TEXT,
        why_picked TEXT,
        picked_by_bot_id TEXT,
        picked_at INTEGER NOT NULL DEFAULT (unixepoch()),
        removed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_ai_picks_user ON ai_picks(user_id, picked_at DESC);
    `);
    db.exec('PRAGMA user_version = 9');
  }

  // v10: model_assignments — UI-managed per-task model picks. Replaces the
  // openrouter.* slugs in config.yaml as the source of truth. Seeded from
  // config.yaml on first run so an existing install upgrades smoothly.
  if (userVersion < 10) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS model_assignments (
        task_type TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    db.exec('PRAGMA user_version = 10');
  }

  // v11: surf_runs + review_runs settings tables. 冲浪/回顾 are now
  // standalone activities — each conversation in those tabs is one run with
  // a recorded model + optional source-message-conv reference. Run logs and
  // results live as messages in the conversation.
  if (userVersion < 11) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS surf_runs (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
        source_message_conv_id TEXT REFERENCES conversations(id),
        model_slug TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at INTEGER,
        ended_at INTEGER,
        budget INTEGER NOT NULL DEFAULT 10,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS review_runs (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
        source_message_conv_id TEXT REFERENCES conversations(id),
        model_slug TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at INTEGER,
        ended_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    db.exec('PRAGMA user_version = 11');
  }

  // v12: vector-driven surfing.
  // surf_vectors records every digging vector used by a surf run (one row per
  // vector — a run with two parallel vectors writes two rows). Used for:
  // (a) dedup — the picker queries recent vectors per user to skip topics
  //     already covered in the last N days
  // (b) serendipity counter — count finished runs per user to decide when to
  //     trigger the periodic blind-wander slot
  // surf_runs gains a `kind` column to distinguish vector runs from
  // serendipity runs and `vector_json` to pin the picked vector(s).
  if (userVersion < 12) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS surf_vectors (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        bot_id TEXT NOT NULL REFERENCES bots(id),
        surf_conv_id TEXT NOT NULL REFERENCES conversations(id),
        vector_hash TEXT NOT NULL,
        topic TEXT NOT NULL,
        mode TEXT NOT NULL,
        why_now TEXT,
        freshness_window TEXT,
        was_override INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_surf_vectors_user ON surf_vectors(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_surf_vectors_hash ON surf_vectors(user_id, vector_hash, created_at DESC);
    `);

    const surfCols = db.query(`PRAGMA table_info(surf_runs)`).all() as Array<{ name: string }>;
    if (!surfCols.some(c => c.name === 'kind')) {
      // 'vector' = guided dig | 'serendipity' = legacy blind wanderer slot
      db.exec(`ALTER TABLE surf_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'vector'`);
    }
    if (!surfCols.some(c => c.name === 'vector_json')) {
      db.exec(`ALTER TABLE surf_runs ADD COLUMN vector_json TEXT`);
    }

    db.exec('PRAGMA user_version = 12');
  }

  // v13: drop provider_models — the picker now pulls the full model list
  // straight from OpenRouter's /api/v1/models, so the local library table is
  // dead weight. model_assignments still holds per-task slug picks.
  if (userVersion < 13) {
    db.exec(`DROP TABLE IF EXISTS provider_models;`);
    db.exec('PRAGMA user_version = 13');
  }

  // v14: api_keys for the iOS thin client. Each row binds a long-lived bearer
  // key to a user; the key itself is only stored as SHA-256(key). share_token
  // is a separate, rotatable random handle used by the /i/<token> share-link
  // landing page so the raw key never appears in a URL.
  if (userVersion < 14) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        share_token TEXT UNIQUE,
        created_by TEXT REFERENCES users(id),
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
      CREATE INDEX IF NOT EXISTS idx_api_keys_share ON api_keys(share_token);
    `);
    db.exec('PRAGMA user_version = 14');
  }

  // v15: each api key remembers which base URLs to embed in its share link.
  // share_base_url is the primary one (what /i/<token> redirects to + what
  // redeem returns). share_alt_urls_json is a JSON array of fallbacks the
  // iOS client probes if the primary is unreachable — lets one share URL
  // work in both LAN and WAN contexts.
  if (userVersion < 15) {
    const cols = db.query(`PRAGMA table_info(api_keys)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'share_base_url')) {
      db.exec(`ALTER TABLE api_keys ADD COLUMN share_base_url TEXT`);
    }
    if (!cols.some(c => c.name === 'share_alt_urls_json')) {
      db.exec(`ALTER TABLE api_keys ADD COLUMN share_alt_urls_json TEXT`);
    }
    db.exec('PRAGMA user_version = 15');
  }

  // v16: account system. Drops anonymous web users + their data so the
  // upgrade lands cleanly with the new invite-based onboarding. Adds
  // `is_admin` flag on users, `user_id` on audit_log (NOT NULL — every LLM
  // call is now attributable to a real account), and the `invites` table
  // backing the admin-issued onboarding flow.
  if (userVersion < 16) {
    console.log('[db] v16: wiping anonymous data and adding account columns');
    // Wipe in FK-safe order. bots + model_assignments stay intact (no user
    // data there); everything below either FKs to users directly or to
    // conversations, so the cascade through these tables covers it.
    db.exec(`
      DELETE FROM attachments;
      DELETE FROM messages;
      DELETE FROM audit_log;
      DELETE FROM ai_picks;
      DELETE FROM device_tokens;
      DELETE FROM portraits;
      DELETE FROM surf_vectors;
      DELETE FROM surf_runs;
      DELETE FROM review_runs;
      DELETE FROM debate_settings;
      DELETE FROM user_profile;
      DELETE FROM api_keys;
      DELETE FROM conversations;
      DELETE FROM users;
    `);

    const userCols = db.query(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
    if (!userCols.some(c => c.name === 'is_admin')) {
      db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
    }

    // SQLite can't ALTER a column to NOT NULL on an existing table — rebuild
    // audit_log. Safe because we just wiped it above.
    db.exec(`
      DROP TABLE IF EXISTS audit_log;
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id),
        conversation_id TEXT,
        task_type TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER DEFAULT 0,
        cost_usd REAL,
        upstream_cost_usd REAL,
        generation_id TEXT,
        generation_time_ms INTEGER,
        latency_ms INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX idx_audit_task ON audit_log(task_type, created_at);
      CREATE INDEX idx_audit_model ON audit_log(model, created_at);
      CREATE INDEX idx_audit_user_time ON audit_log(user_id, created_at DESC);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL REFERENCES users(id),
        note TEXT,
        expires_at INTEGER,
        redeemed_at INTEGER,
        redeemed_by_user_id TEXT REFERENCES users(id),
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token);
    `);

    db.exec('PRAGMA user_version = 16');
  }

  // v17: skills. User-managed prompt fragments injected into the system
  // prompt at chat time. `enabled = 0` means the skill is parked in the
  // catalog but not active. `source` is a free-form provenance tag (e.g.
  // 'anthropic/skills:skill-creator' for bundled presets, 'user' for
  // user-authored entries) so we can re-seed/refresh upstream copies
  // without clobbering local edits. (name, user_id) is unique per user.
  if (userVersion < 17) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0,
        source TEXT,
        source_url TEXT,
        license TEXT,
        seeded_hash TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_user_name ON skills(user_id, name);
      CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(user_id, sort_order, created_at);
    `);
    db.exec('PRAGMA user_version = 17');
  }
}
