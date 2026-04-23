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
}
