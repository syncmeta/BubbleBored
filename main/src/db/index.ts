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
  // model line-up and topic per debate conversation; provider_models is the
  // user's library of OpenRouter slugs that can participate. Seeded on first
  // run with a default line-up so the feature is usable out of the box.
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

      CREATE TABLE IF NOT EXISTS provider_models (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_models_slug ON provider_models(slug);
    `);

    // Seed defaults — covers four major providers + grok so debate has
    // distinct voices on first launch. User can edit list in 「你」tab.
    const seed = [
      ['anthropic', 'anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5'],
      ['openai',    'openai/gpt-5',                'GPT-5'],
      ['google',    'google/gemini-2.5-pro',       'Gemini 2.5 Pro'],
      ['xai',       'x-ai/grok-4',                 'Grok-4'],
      ['deepseek',  'deepseek/deepseek-chat',      'DeepSeek-V3'],
    ] as const;
    const insert = db.query(
      `INSERT OR IGNORE INTO provider_models (id, provider, slug, display_name) VALUES (?, ?, ?, ?)`
    );
    for (const [provider, slug, name] of seed) {
      insert.run(`pm_${slug.replace(/[^a-z0-9]/gi, '_')}`, provider, slug, name);
    }

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
}
