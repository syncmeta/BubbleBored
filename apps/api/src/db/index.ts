import { Database } from 'bun:sqlite';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

const ROOT = join(import.meta.dir, '../..');
// DATA_DIR overrides where persistent state lives. Required for hosted deploys
// (Fly volume mounted at /data); falls back to repo-local `main/data` for dev.
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const DB_PATH = join(DATA_DIR, 'bubblebored.sqlite');

let db: Database;

export function getDb(): Database {
  if (!db) {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db);
  }
  return db;
}

export function getDataDir(): string {
  return DATA_DIR;
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

  // v10: model_assignments — UI-managed per-task model picks. (Dropped in
  // v19 once model selection moved to per-bot. The table is created here so
  // older installs reach a consistent shape before v19 tears it down.)
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
  // dead weight.
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
    // Wipe in FK-safe order. bots stay intact (no user data there);
    // everything below either FKs to users directly or to conversations, so
    // the cascade through these tables covers it.
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

  // v18: 议论 switches from "models debate" to "bots debate". Each row in
  // debate_settings now points to a list of bot IDs (instead of raw model
  // slugs); the orchestrator looks up each bot's model + display name from
  // config at run time. Old debate convs are unrecoverable (the slug list is
  // useless without the bot context) so we wipe them. We also cull orphan bot
  // rows + their conversations after the bot key rename in config.yaml
  // (001/002/… → glm-5.1/glm-4.5-air/…) so registry.syncBots() won't leave
  // dead rows behind.
  if (userVersion < 18) {
    db.exec(`DELETE FROM debate_settings;`);
    db.exec(`
      DELETE FROM messages WHERE conversation_id IN (
        SELECT id FROM conversations WHERE feature_type = 'debate'
      );
      DELETE FROM conversations WHERE feature_type = 'debate';
    `);
    db.exec(`DROP TABLE IF EXISTS debate_settings;`);
    db.exec(`
      CREATE TABLE debate_settings (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
        bot_ids TEXT NOT NULL,
        topic TEXT,
        round_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    db.exec('PRAGMA user_version = 18');
  }

  // v19: drop model_assignments. Per-task model picks are gone — every task
  // now uses the model defined on the bot it runs against.
  if (userVersion < 19) {
    db.exec(`DROP TABLE IF EXISTS model_assignments;`);
    db.exec('PRAGMA user_version = 19');
  }

  // v20: per-conversation model override for the chat path. NULL = use the
  // bot's configured model. Set/cleared from the iOS chat action sheet.
  if (userVersion < 20) {
    const cols = db.query(`PRAGMA table_info(conversations)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'model_override')) {
      db.exec(`ALTER TABLE conversations ADD COLUMN model_override TEXT`);
    }
    db.exec('PRAGMA user_version = 20');
  }

  // v21: bot_reflections — what the bot wrote about itself during 回顾 runs.
  // The "我-局限/发扬/保持" buckets get persisted here so the bot's own
  // self-knowledge accumulates across reviews. The most-recent N rows per
  // (bot, user) are spliced into the system prompt at chat-build time so the
  // bot literally carries its lessons forward.
  if (userVersion < 21) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bot_reflections (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        review_conv_id TEXT REFERENCES conversations(id),
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_bot_refl_bot_user ON bot_reflections(bot_id, user_id, created_at DESC);
    `);
    db.exec('PRAGMA user_version = 21');
  }

  // v22: per-debate cap on messages per round. NULL means "use the orchestrator
  // default". Set at creation time from the modal/sheet so a noisy lineup can
  // be turned down without editing localStorage.
  if (userVersion < 22) {
    const cols = db.query(`PRAGMA table_info(debate_settings)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'max_messages')) {
      db.exec(`ALTER TABLE debate_settings ADD COLUMN max_messages INTEGER`);
    }
    db.exec('PRAGMA user_version = 22');
  }

  // v23: agentic surfing rebuild.
  // The old vector-picker / digger / synthesizer / curator pipeline is gone
  // — surfing now runs as a single agent loop with a cost budget. surf_runs
  // is rebuilt: budget is now USD (REAL), kind/vector_json/model_slug are
  // dropped (multiple models per run, captured per-call in audit_log).
  // surf_vectors is dropped entirely (no more dedup on (topic, mode)).
  // bot_journal_entries is added — first-person diary the bot writes after
  // each surf so it accumulates real "experience" across conversations.
  if (userVersion < 23) {
    db.exec(`
      DELETE FROM messages WHERE conversation_id IN (
        SELECT id FROM conversations WHERE feature_type = 'surf'
      );
      DELETE FROM conversations WHERE feature_type = 'surf';
      DROP TABLE IF EXISTS surf_runs;
      DROP TABLE IF EXISTS surf_vectors;
      CREATE TABLE surf_runs (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
        source_message_conv_id TEXT REFERENCES conversations(id),
        status TEXT NOT NULL DEFAULT 'pending',
        started_at INTEGER,
        ended_at INTEGER,
        cost_budget_usd REAL NOT NULL,
        cost_used_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE bot_journal_entries (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        surf_conv_id TEXT REFERENCES conversations(id),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX idx_journal_bot_time ON bot_journal_entries(bot_id, created_at DESC);
      CREATE INDEX idx_journal_user_time ON bot_journal_entries(user_id, created_at DESC);
    `);
    db.exec('PRAGMA user_version = 23');
  }

  // v24: review_runs drops model_slug. Mirrors the surf rebuild — "回顾"
  // is classified as humanAnalysis and pulls models.humanAnalysis at run
  // time; freezing a model at create time would let the per-run value
  // drift from the actual call.
  if (userVersion < 24) {
    const cols = db.query(`PRAGMA table_info(review_runs)`).all() as Array<{ name: string }>;
    if (cols.some(c => c.name === 'model_slug')) {
      db.exec(`
        CREATE TABLE review_runs_new (
          conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
          source_message_conv_id TEXT REFERENCES conversations(id),
          status TEXT NOT NULL DEFAULT 'pending',
          started_at INTEGER,
          ended_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT INTO review_runs_new
          (conversation_id, source_message_conv_id, status, started_at, ended_at, created_at)
          SELECT conversation_id, source_message_conv_id, status, started_at, ended_at, created_at
          FROM review_runs;
        DROP TABLE review_runs;
        ALTER TABLE review_runs_new RENAME TO review_runs;
      `);
    }
    db.exec('PRAGMA user_version = 24');
  }

  // v25: skills move to Claude's progressive-disclosure model — every
  // installed skill is enabled by default and only its description ships
  // in the system prompt; the body is loaded on demand via the load_skill
  // tool. To get existing users onto the new model, flip enabled=1 on
  // preset rows the user hasn't customised. We detect "uncustomised" by
  // checking that the row originated from an anthropic preset AND the
  // current body still hashes to the seeded_hash (i.e. no edits since the
  // seed). User-authored rows and edited presets are left alone — their
  // enabled state is the user's choice to make.
  // SQLite has no built-in sha1, so we can't recompute the body hash here
  // to prove "uncustomised" the strict way. We approximate: a row is treated
  // as still-seeded when (a) it was sourced from an anthropic preset and
  // (b) seeded_hash is non-null. The seed path is the only writer of
  // seeded_hash, and updateSkill leaves it alone unless the caller passes
  // a new value — so "non-null" here means "we put it there during seeding
  // and nobody has explicitly cleared it". Edited rows are still flipped on,
  // which matches the spirit of "everything installed by default" — users
  // who genuinely don't want a skill can toggle it off in Skills管理.
  if (userVersion < 25) {
    db.exec(`
      UPDATE skills
         SET enabled = 1, updated_at = unixepoch()
       WHERE enabled = 0
         AND source LIKE 'anthropic/skills:%'
         AND seeded_hash IS NOT NULL;
    `);
    db.exec('PRAGMA user_version = 25');
  }

  // v26: per-user, per-bot model override. Lets a user pick a different
  // model for "their" copy of a bot without touching the global bot config
  // or every conversation. Resolution order in modelFor() becomes:
  //   per-conv override > per-user-per-bot override > bot.model > config fallback
  // NULL/missing row = "use the bot's default". (user_id, bot_id) is the PK.
  if (userVersion < 26) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_bot_model_overrides (
        user_id TEXT NOT NULL REFERENCES users(id),
        bot_id TEXT NOT NULL REFERENCES bots(id),
        model TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (user_id, bot_id)
      );
    `);
    db.exec('PRAGMA user_version = 26');
  }

  // v27: third-party identity columns on users. Clerk is the production login
  // path (Sign in with Apple / Google / email code via the Clerk-hosted UI);
  // clerk_user_id is the stable subject of the Clerk JWT and email is the
  // verified address Clerk gives us, surfaced to the admin token-audit view.
  // Both are nullable so the existing invite-redeem path (admin bootstrap +
  // legacy iOS keys) keeps working without a Clerk identity attached.
  if (userVersion < 27) {
    const cols = db.query(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'clerk_user_id')) {
      db.exec(`ALTER TABLE users ADD COLUMN clerk_user_id TEXT`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_clerk ON users(clerk_user_id) WHERE clerk_user_id IS NOT NULL`);
    }
    if (!cols.some(c => c.name === 'email')) {
      db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
    }
    db.exec('PRAGMA user_version = 27');
  }

  // v28: per-user token-cost quota. Plain users get a small monthly USD
  // budget on the platform-funded OpenRouter key; the orchestrator pre-checks
  // before each LLM call and the audit hook deducts after. Period rollover
  // is lazy (computed on read). Users who switch on BYOK skip the quota
  // entirely — they're spending their own money.
  if (userVersion < 28) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_quota (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        monthly_budget_usd REAL NOT NULL DEFAULT 0.30,
        used_usd REAL NOT NULL DEFAULT 0,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        hard_blocked INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    db.exec('PRAGMA user_version = 28');
  }

  // v29: per-user settings, currently just BYOK credentials. Keys are
  // AES-256-GCM encrypted at rest with the env-supplied BYOK_ENC_KEY; the
  // last4 column is what we surface to the UI so users can confirm "yes
  // that's the key I pasted". A row exists only once a user has saved at
  // least one BYOK value.
  if (userVersion < 29) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        openrouter_key_enc BLOB,
        openrouter_key_last4 TEXT,
        jina_key_enc BLOB,
        jina_key_last4 TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    db.exec('PRAGMA user_version = 29');
  }

  // v30: generic key/value store for boot-time invariants. First use is the
  // BYOK_ENC_KEY fingerprint — see core/byok.ts. If we silently re-init with
  // a different KEK, every encrypted column becomes garbage; the fingerprint
  // lets startup refuse to continue instead of corrupting data.
  if (userVersion < 30) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    db.exec('PRAGMA user_version = 30');
  }

  // v31: richer Clerk identity columns on users + retire the share-token /
  // share-base-url machinery on api_keys. Clerk-derived first/last/username/
  // imageUrl populate the dashboard ("我" tab) directly, so iOS no longer
  // shows the literal string "user" when Clerk's session JWT omits an email
  // claim. The share_* columns powered the v1 "scan a QR / tap a link to
  // log iPhones in" flow that the Clerk-hosted login replaced — no in-flight
  // share links exist anymore (no production users on the old flow), so we
  // drop the columns + index outright instead of carrying them as dead
  // weight forever.
  if (userVersion < 31) {
    const userCols = db.query(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
    if (!userCols.some(c => c.name === 'first_name')) {
      db.exec(`ALTER TABLE users ADD COLUMN first_name TEXT`);
    }
    if (!userCols.some(c => c.name === 'last_name')) {
      db.exec(`ALTER TABLE users ADD COLUMN last_name TEXT`);
    }
    if (!userCols.some(c => c.name === 'username')) {
      db.exec(`ALTER TABLE users ADD COLUMN username TEXT`);
    }
    if (!userCols.some(c => c.name === 'image_url')) {
      db.exec(`ALTER TABLE users ADD COLUMN image_url TEXT`);
    }

    // share_token had a UNIQUE constraint, which SQLite can't drop via
    // ALTER TABLE DROP COLUMN. Standard workaround: rebuild the table.
    const apiKeyCols = db.query(`PRAGMA table_info(api_keys)`).all() as Array<{ name: string }>;
    const hasShareCols = apiKeyCols.some(c =>
      c.name === 'share_token' || c.name === 'share_base_url' || c.name === 'share_alt_urls_json'
    );
    if (hasShareCols) {
      db.exec(`DROP INDEX IF EXISTS idx_api_keys_share`);
      db.exec(`DROP INDEX IF EXISTS idx_api_keys_user`);
      db.exec(`DROP INDEX IF EXISTS idx_api_keys_hash`);
      db.exec(`
        CREATE TABLE api_keys_new (
          id TEXT PRIMARY KEY,
          key_prefix TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL REFERENCES users(id),
          name TEXT NOT NULL,
          created_by TEXT REFERENCES users(id),
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          last_used_at INTEGER,
          revoked_at INTEGER
        );
      `);
      db.exec(`
        INSERT INTO api_keys_new
          (id, key_prefix, key_hash, user_id, name, created_by,
           created_at, last_used_at, revoked_at)
        SELECT id, key_prefix, key_hash, user_id, name, created_by,
               created_at, last_used_at, revoked_at
        FROM api_keys;
      `);
      db.exec(`DROP TABLE api_keys;`);
      db.exec(`ALTER TABLE api_keys_new RENAME TO api_keys;`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);`);
    }
    db.exec('PRAGMA user_version = 31');
  }

  // v32: BYOK is no longer OpenRouter-only — users can now point at any
  // OpenAI-compatible endpoint (their own Anthropic proxy, a self-hosted
  // gateway, OpenAI directly, etc.). Stores the base URL alongside the
  // existing key columns; null means "use the OpenRouter default" so
  // pre-v32 rows keep working without re-saving.
  if (userVersion < 32) {
    const cols = db.query(`PRAGMA table_info(user_settings)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'openrouter_base_url')) {
      db.exec(`ALTER TABLE user_settings ADD COLUMN openrouter_base_url TEXT`);
    }
    db.exec('PRAGMA user_version = 32');
  }
}
