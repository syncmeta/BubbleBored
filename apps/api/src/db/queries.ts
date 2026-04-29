import { getDb } from './index';

// Users
export function findUserByChannel(channel: string, externalId: string) {
  return getDb().query<any, [string, string]>(
    'SELECT * FROM users WHERE channel = ? AND external_id = ?'
  ).get(channel, externalId);
}

export function findUserById(id: string) {
  return getDb().query<any, [string]>('SELECT * FROM users WHERE id = ?').get(id);
}

export function createUser(
  id: string, channel: string, externalId: string, displayName: string,
  isAdmin: boolean = false,
) {
  getDb().query(
    'INSERT INTO users (id, channel, external_id, display_name, is_admin) VALUES (?, ?, ?, ?, ?)'
  ).run(id, channel, externalId, displayName, isAdmin ? 1 : 0);
}

export function listUsers() {
  return getDb().query<any, []>(
    'SELECT id, channel, external_id, display_name, status, is_admin, created_at FROM users ORDER BY created_at ASC'
  ).all();
}

export function countAdmins(): number {
  const row = getDb().query<{ n: number }, []>(
    'SELECT COUNT(*) as n FROM users WHERE is_admin = 1'
  ).get();
  return row?.n ?? 0;
}

export function setUserAdmin(id: string, isAdmin: boolean): void {
  getDb().query(
    'UPDATE users SET is_admin = ?, updated_at = unixepoch() WHERE id = ?'
  ).run(isAdmin ? 1 : 0, id);
}

// Wipe a user and every row that hangs off them. Returns attachment file
// paths so the caller can unlink the blobs from disk. Used by the 钥匙 panel
// revoke flow — each iOS-mint key has its own user, so revoking the key
// purges that holder's chats, portraits, audit log, profile, etc.
//
// Caller MUST guard against passing an admin user — this would happily wipe
// the only-admin row and brick the system.
export function deleteUserCascade(userId: string): string[] {
  const db = getDb();
  const convIds = db.query<{ id: string }, [string]>(
    'SELECT id FROM conversations WHERE user_id = ?'
  ).all(userId).map(r => r.id);
  const attachmentPaths: string[] = [];
  for (const id of convIds) attachmentPaths.push(...deleteConversation(id));
  db.query('DELETE FROM audit_log WHERE user_id = ?').run(userId);
  db.query('DELETE FROM ai_picks WHERE user_id = ?').run(userId);
  db.query('DELETE FROM device_tokens WHERE user_id = ?').run(userId);
  db.query('DELETE FROM user_profile WHERE user_id = ?').run(userId);
  db.query('DELETE FROM skills WHERE user_id = ?').run(userId);
  db.query('DELETE FROM bot_journal_entries WHERE user_id = ?').run(userId);
  db.query('DELETE FROM api_keys WHERE user_id = ?').run(userId);
  // The invite history belongs to the admin who minted invites, not the
  // recipient — null the back-pointer rather than dropping the row.
  db.query('UPDATE invites SET redeemed_by_user_id = NULL WHERE redeemed_by_user_id = ?').run(userId);
  db.query('DELETE FROM users WHERE id = ?').run(userId);
  return attachmentPaths;
}

// Bots
export function upsertBot(id: string, displayName: string, configHash: string) {
  getDb().query(
    `INSERT INTO bots (id, display_name, config_hash) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, config_hash = excluded.config_hash`
  ).run(id, displayName, configHash);
}

export function findBot(id: string) {
  return getDb().query<any, [string]>('SELECT * FROM bots WHERE id = ?').get(id);
}

export function listBots() {
  return getDb().query<any, []>('SELECT * FROM bots').all();
}

// Wipe a bot and every conversation tree that hangs off it. Used when a bot
// disappears from config.yaml (rename/remove) — leaving stale rows behind
// would orphan conversations that no findBot() lookup can satisfy.
export function deleteBotCascade(botId: string): void {
  const db = getDb();
  const convIds = db.query<{ id: string }, [string]>(
    'SELECT id FROM conversations WHERE bot_id = ?'
  ).all(botId).map(r => r.id);
  for (const id of convIds) deleteConversation(id);
  db.query('DELETE FROM bots WHERE id = ?').run(botId);
}

// Conversations
// Returns the most recent conversation for (botId, userId, feature) — used by
// inbound channels where a chat thread maps to one conversation. Defaults to
// 'message' so debate/surf/portrait convs (with the same bot/user) aren't
// accidentally promoted to be the inbound chat target.
export function findConversation(
  botId: string, userId: string, featureType: string = 'message',
) {
  return getDb().query<any, [string, string, string]>(
    `SELECT * FROM conversations
     WHERE bot_id = ? AND user_id = ? AND feature_type = ?
     ORDER BY last_activity_at DESC LIMIT 1`
  ).get(botId, userId, featureType);
}

export function findConversationById(id: string) {
  return getDb().query<any, [string]>('SELECT * FROM conversations WHERE id = ?').get(id);
}

export function createConversation(
  id: string, botId: string, userId: string,
  title?: string | null, featureType: string = 'message',
) {
  getDb().query(
    'INSERT INTO conversations (id, bot_id, user_id, title, feature_type) VALUES (?, ?, ?, ?, ?)'
  ).run(id, botId, userId, title ?? null, featureType);
}

export function updateConversationTitle(id: string, title: string) {
  getDb().query(
    'UPDATE conversations SET title = ? WHERE id = ?'
  ).run(title, id);
}

// Per-conversation model override. Pass null to clear and fall back to the
// bot's default model in config.yaml.
export function setConversationModelOverride(id: string, slug: string | null) {
  getDb().query(
    'UPDATE conversations SET model_override = ? WHERE id = ?'
  ).run(slug, id);
}

// Returns paths of any attachment files the caller should unlink from disk.
export function deleteConversation(id: string): string[] {
  const db = getDb();
  const attachmentPaths = db.query<{ path: string }, [string]>(
    'SELECT path FROM attachments WHERE conversation_id = ?'
  ).all(id).map(r => r.path);
  db.query('DELETE FROM attachments WHERE conversation_id = ?').run(id);
  db.query('DELETE FROM messages WHERE conversation_id = ?').run(id);
  db.query('UPDATE audit_log SET conversation_id = NULL WHERE conversation_id = ?').run(id);
  db.query('DELETE FROM conversations WHERE id = ?').run(id);
  return attachmentPaths;
}

export function updateConversationRound(id: string, roundCount: number, lastSender: string) {
  getDb().query(
    'UPDATE conversations SET round_count = ?, last_sender = ?, last_activity_at = unixepoch() WHERE id = ?'
  ).run(roundCount, lastSender, id);
}

export function updateConversationActivity(id: string) {
  getDb().query(
    'UPDATE conversations SET last_activity_at = unixepoch() WHERE id = ?'
  ).run(id);
}

export function updateSurfState(id: string, interval: number) {
  getDb().query(
    'UPDATE conversations SET surf_last_at = unixepoch(), surf_interval = ? WHERE id = ?'
  ).run(interval, id);
}

export function resetSurfInterval(id: string, initialInterval: number) {
  getDb().query(
    'UPDATE conversations SET surf_interval = ? WHERE id = ?'
  ).run(initialInterval, id);
}

// Messages
export function insertMessage(
  id: string, conversationId: string, senderType: string, senderId: string,
  content: string, segmentIndex: number = 0
) {
  getDb().query(
    'INSERT INTO messages (id, conversation_id, sender_type, sender_id, content, segment_index) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, conversationId, senderType, senderId, content, segmentIndex);
}

export function getMessages(conversationId: string, limit: number = 50) {
  return getDb().query<any, [string, number]>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(conversationId, limit).reverse();
}

// All messages in chronological order, tiebreaking on rowid so multi-segment
// bot replies (same second) stay ordered the way they were inserted. Used by
// regenerate to slice the tail of the conversation after a chosen point.
export function getAllMessagesAsc(conversationId: string) {
  return getDb().query<any, [string]>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC'
  ).all(conversationId);
}

// Audit. user_id is mandatory — every LLM call is attributed to an account
// so admins can see "who is burning the tokens" and users can see their own.
export function insertAudit(entry: {
  userId: string;
  conversationId?: string;
  taskType: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  costUsd?: number;
  generationId?: string;
  latencyMs?: number;
}) {
  return getDb().query(
    `INSERT INTO audit_log (user_id, conversation_id, task_type, model, input_tokens, output_tokens, total_tokens, cached_tokens, cost_usd, generation_id, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.userId,
    entry.conversationId ?? null, entry.taskType, entry.model,
    entry.inputTokens, entry.outputTokens, entry.totalTokens,
    entry.cachedTokens ?? 0, entry.costUsd ?? null,
    entry.generationId ?? null, entry.latencyMs ?? null
  );
}

// Generic audit summary. groupBy ∈ {task_type, model, user}. When userIdFilter
// is set the query is scoped to that user (per-user "我的 token" view); when
// null, returns aggregates across all users (admin global view).
export function getAuditSummary(
  from: number, to: number,
  groupBy: 'task_type' | 'model' | 'user' = 'task_type',
  userIdFilter: string | null = null,
) {
  const params: any[] = userIdFilter ? [from, to, userIdFilter] : [from, to];

  if (groupBy === 'user') {
    const where = userIdFilter
      ? 'WHERE a.created_at BETWEEN ? AND ? AND a.user_id = ?'
      : 'WHERE a.created_at BETWEEN ? AND ?';
    return getDb().query<any, any[]>(
      `SELECT a.user_id as group_key, u.display_name as group_label,
         COUNT(*) as count,
         SUM(a.input_tokens) as total_input, SUM(a.output_tokens) as total_output,
         SUM(a.total_tokens) as total_tokens, SUM(a.cost_usd) as total_cost
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       ${where} GROUP BY a.user_id ORDER BY total_tokens DESC`
    ).all(...params);
  }
  const where = userIdFilter
    ? 'WHERE created_at BETWEEN ? AND ? AND user_id = ?'
    : 'WHERE created_at BETWEEN ? AND ?';
  const col = groupBy === 'model' ? 'model' : 'task_type';
  return getDb().query<any, any[]>(
    `SELECT ${col} as group_key, COUNT(*) as count,
       SUM(input_tokens) as total_input, SUM(output_tokens) as total_output,
       SUM(total_tokens) as total_tokens, SUM(cost_usd) as total_cost
     FROM audit_log ${where} GROUP BY ${col}`
  ).all(...params);
}

export function getAuditDetails(
  limit: number = 100, offset: number = 0,
  userIdFilter: string | null = null,
) {
  if (userIdFilter) {
    return getDb().query<any, [string, number, number]>(
      'SELECT * FROM audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(userIdFilter, limit, offset);
  }
  return getDb().query<any, [number, number]>(
    'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
}

export function findMessageById(id: string) {
  return getDb().query<any, [string]>('SELECT * FROM messages WHERE id = ?').get(id);
}

// Edit the text of an existing message (keeps its attachments intact).
// Used by the edit-and-regenerate flow on user messages.
export function updateMessageContent(messageId: string, content: string): void {
  getDb().query('UPDATE messages SET content = ? WHERE id = ?').run(content, messageId);
}

// Returns paths of any attachment files the caller should unlink from disk.
export function deleteMessage(messageId: string): string[] {
  const db = getDb();
  const attachmentPaths = db.query<{ path: string }, [string]>(
    'SELECT path FROM attachments WHERE message_id = ?'
  ).all(messageId).map(r => r.path);
  db.query('DELETE FROM attachments WHERE message_id = ?').run(messageId);
  db.query('DELETE FROM messages WHERE id = ?').run(messageId);
  return attachmentPaths;
}

// Returns paths of any attachment files the caller should unlink from disk.
export function resetConversation(conversationId: string): string[] {
  const db = getDb();
  const attachmentPaths = db.query<{ path: string }, [string]>(
    'SELECT path FROM attachments WHERE conversation_id = ?'
  ).all(conversationId).map(r => r.path);
  db.query('DELETE FROM attachments WHERE conversation_id = ?').run(conversationId);
  db.query('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
  db.query('DELETE FROM audit_log WHERE conversation_id = ?').run(conversationId);
  db.query('UPDATE conversations SET round_count = 0, last_sender = NULL, surf_last_at = NULL WHERE id = ?').run(conversationId);
  return attachmentPaths;
}

// Two correlated sub-selects pull the most recent message's content + sender
// type for each conversation row. Powers the chat list "preview" line in
// every IM-style frontend (web + iOS) without an N+1 query per row. Costs
// one index seek per conv on (conversation_id, created_at DESC).
export function listConversationsByUser(userId: string, featureType?: string) {
  const cols = `
    c.*,
    b.display_name as bot_name,
    (SELECT content FROM messages
       WHERE conversation_id = c.id
       ORDER BY created_at DESC, rowid DESC LIMIT 1) as last_message_content,
    (SELECT sender_type FROM messages
       WHERE conversation_id = c.id
       ORDER BY created_at DESC, rowid DESC LIMIT 1) as last_message_sender_type
  `;
  if (featureType) {
    return getDb().query<any, [string, string]>(
      `SELECT ${cols} FROM conversations c
       JOIN bots b ON c.bot_id = b.id
       WHERE c.user_id = ? AND c.feature_type = ?
       ORDER BY c.last_activity_at DESC`
    ).all(userId, featureType);
  }
  return getDb().query<any, [string]>(
    `SELECT ${cols} FROM conversations c
     JOIN bots b ON c.bot_id = b.id
     WHERE c.user_id = ? ORDER BY c.last_activity_at DESC`
  ).all(userId);
}

// ---------- Attachments ----------
// Upload flow: client POSTs file → server writes bytes + inserts row with
// message_id=NULL → returns attachment id. Client then includes id in the WS
// chat payload; server binds it to the freshly-inserted user message row.
// Orphans (never bound) are swept periodically.

export interface AttachmentRow {
  id: string;
  message_id: string | null;
  conversation_id: string | null;
  kind: string;
  mime: string;
  path: string;
  size: number;
  width: number | null;
  height: number | null;
  created_at: number;
}

export function createAttachment(
  id: string,
  conversationId: string | null,
  kind: string,
  mime: string,
  path: string,
  size: number,
  width?: number | null,
  height?: number | null,
) {
  getDb().query(
    `INSERT INTO attachments (id, conversation_id, kind, mime, path, size, width, height)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, conversationId, kind, mime, path, size, width ?? null, height ?? null);
}

export function findAttachmentById(id: string): AttachmentRow | null {
  return getDb().query<AttachmentRow, [string]>(
    'SELECT * FROM attachments WHERE id = ?'
  ).get(id) as AttachmentRow | null;
}

// Bind a set of orphaned (message_id IS NULL) attachments to a message.
// Only rows that are still orphaned AND belong to the same conversation
// (or have NULL conversation_id) are updated — defends against a client
// trying to attach someone else's upload id.
export function bindAttachmentsToMessage(
  attachmentIds: string[],
  messageId: string,
  conversationId: string,
): number {
  if (attachmentIds.length === 0) return 0;
  const db = getDb();
  const placeholders = attachmentIds.map(() => '?').join(',');
  const result = db.query(
    `UPDATE attachments
     SET message_id = ?, conversation_id = ?
     WHERE id IN (${placeholders})
       AND message_id IS NULL
       AND (conversation_id IS NULL OR conversation_id = ?)`
  ).run(messageId, conversationId, ...attachmentIds, conversationId);
  return Number((result as any).changes ?? 0);
}

export function getAttachmentsForMessage(messageId: string): AttachmentRow[] {
  return getDb().query<AttachmentRow, [string]>(
    'SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at ASC'
  ).all(messageId);
}

// Batch-fetch attachments for a set of messages. Returns a map
// messageId → AttachmentRow[] so callers can merge in one pass.
export function getAttachmentsForMessages(messageIds: string[]): Record<string, AttachmentRow[]> {
  if (messageIds.length === 0) return {};
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = getDb().query<AttachmentRow, string[]>(
    `SELECT * FROM attachments WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`
  ).all(...messageIds);
  const map: Record<string, AttachmentRow[]> = {};
  for (const r of rows) {
    if (!r.message_id) continue;
    (map[r.message_id] ??= []).push(r);
  }
  return map;
}

// ---------- Surf runs / Review runs (standalone tabs) ----------

export interface SurfRunRow {
  conversation_id: string;
  source_message_conv_id: string | null;
  status: string;
  started_at: number | null;
  ended_at: number | null;
  cost_budget_usd: number;
  cost_used_usd: number;
  created_at: number;
}

export function createSurfRun(params: {
  conversationId: string;
  sourceMessageConvId: string | null;
  costBudgetUsd: number;
}): void {
  getDb().query(
    `INSERT INTO surf_runs (conversation_id, source_message_conv_id, cost_budget_usd)
     VALUES (?, ?, ?)`
  ).run(params.conversationId, params.sourceMessageConvId, params.costBudgetUsd);
}

export function getSurfRun(conversationId: string): SurfRunRow | null {
  return getDb().query<SurfRunRow, [string]>(
    'SELECT * FROM surf_runs WHERE conversation_id = ?'
  ).get(conversationId);
}

export function setSurfRunStatus(
  conversationId: string, status: string,
): void {
  const isFinal = ['done', 'error', 'aborted'].includes(status);
  getDb().query(
    isFinal
      ? `UPDATE surf_runs SET status = ?, ended_at = unixepoch() WHERE conversation_id = ?`
      : `UPDATE surf_runs SET status = ?, started_at = COALESCE(started_at, unixepoch()) WHERE conversation_id = ?`
  ).run(status, conversationId);
}

export function addSurfRunCost(conversationId: string, deltaUsd: number): void {
  if (!Number.isFinite(deltaUsd) || deltaUsd <= 0) return;
  getDb().query(
    `UPDATE surf_runs SET cost_used_usd = cost_used_usd + ? WHERE conversation_id = ?`
  ).run(deltaUsd, conversationId);
}

// ---------- Bot journal (first-person experience log across conversations) ----------
//
// Each surf run produces one entry: a short first-person account of what the
// bot saw and felt. Pulled into the chat system prompt so the bot can
// reference its own real experiences in conversation ("前几天我看了一篇…").
// User-scoped so different people get the bot's experience as it unfolded
// in their own thread of attention; bot-scoped because the persona is the bot.

export interface BotJournalEntryRow {
  id: string;
  bot_id: string;
  user_id: string;
  surf_conv_id: string | null;
  content: string;
  created_at: number;
}

export function createBotJournalEntry(params: {
  id: string;
  botId: string;
  userId: string;
  surfConvId?: string | null;
  content: string;
}): void {
  getDb().query(
    `INSERT INTO bot_journal_entries (id, bot_id, user_id, surf_conv_id, content)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    params.id, params.botId, params.userId,
    params.surfConvId ?? null, params.content,
  );
}

export function recentBotJournalEntries(
  botId: string, userId: string, limit: number,
): BotJournalEntryRow[] {
  return getDb().query<BotJournalEntryRow, [string, string, number]>(
    `SELECT * FROM bot_journal_entries
     WHERE bot_id = ? AND user_id = ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(botId, userId, limit);
}

export interface ReviewRunRow {
  conversation_id: string;
  source_message_conv_id: string | null;
  status: string;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

export function createReviewRun(params: {
  conversationId: string;
  sourceMessageConvId: string | null;
}): void {
  getDb().query(
    `INSERT INTO review_runs (conversation_id, source_message_conv_id)
     VALUES (?, ?)`
  ).run(params.conversationId, params.sourceMessageConvId);
}

export function getReviewRun(conversationId: string): ReviewRunRow | null {
  return getDb().query<ReviewRunRow, [string]>(
    'SELECT * FROM review_runs WHERE conversation_id = ?'
  ).get(conversationId);
}

export function setReviewRunStatus(
  conversationId: string, status: string,
): void {
  const isFinal = ['done', 'error', 'aborted'].includes(status);
  getDb().query(
    isFinal
      ? `UPDATE review_runs SET status = ?, ended_at = unixepoch() WHERE conversation_id = ?`
      : `UPDATE review_runs SET status = ?, started_at = COALESCE(started_at, unixepoch()) WHERE conversation_id = ?`
  ).run(status, conversationId);
}

// ---------- Bot reflections (accumulated 「我-局限/发扬/保持」 from 回顾 runs) ----------

export interface BotReflectionRow {
  id: string;
  bot_id: string;
  user_id: string;
  review_conv_id: string | null;
  kind: string;          // 'limit' | 'grow' | 'keep'
  content: string;
  created_at: number;
}

export function insertBotReflection(params: {
  id: string;
  botId: string;
  userId: string;
  reviewConvId: string | null;
  kind: 'limit' | 'grow' | 'keep';
  content: string;
}): void {
  getDb().query(
    `INSERT INTO bot_reflections (id, bot_id, user_id, review_conv_id, kind, content)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(params.id, params.botId, params.userId, params.reviewConvId, params.kind, params.content);
}

export function getRecentBotReflections(
  botId: string, userId: string, limit = 12,
): BotReflectionRow[] {
  return getDb().query<BotReflectionRow, [string, string, number]>(
    `SELECT * FROM bot_reflections
     WHERE bot_id = ? AND user_id = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT ?`
  ).all(botId, userId, limit);
}

// ---------- Debate ----------

export interface DebateSettingsRow {
  conversation_id: string;
  bot_ids: string;
  topic: string | null;
  round_count: number;
  max_messages: number | null;
  created_at: number;
  updated_at: number;
}

export function createDebateSettings(
  conversationId: string, botIds: string[], topic: string | null,
  maxMessages: number | null = null,
): void {
  getDb().query(
    `INSERT INTO debate_settings (conversation_id, bot_ids, topic, max_messages) VALUES (?, ?, ?, ?)`
  ).run(conversationId, JSON.stringify(botIds), topic, maxMessages);
}

export function getDebateSettings(conversationId: string): DebateSettingsRow | null {
  return getDb().query<DebateSettingsRow, [string]>(
    'SELECT * FROM debate_settings WHERE conversation_id = ?'
  ).get(conversationId);
}

export function bumpDebateRound(conversationId: string): number {
  const row = getDb().query<{ round_count: number }, [string]>(
    `UPDATE debate_settings SET round_count = round_count + 1, updated_at = unixepoch()
     WHERE conversation_id = ? RETURNING round_count`
  ).get(conversationId);
  return row?.round_count ?? 0;
}

// ---------- 「你」 user dashboard ----------

export interface UserProfileRow {
  user_id: string;
  bio: string | null;
  avatar_path: string | null;
  custom_fields_json: string | null;
  updated_at: number;
}

export function getUserDashboardProfile(userId: string): UserProfileRow | null {
  return getDb().query<UserProfileRow, [string]>(
    'SELECT * FROM user_profile WHERE user_id = ?'
  ).get(userId);
}

export function upsertUserDashboardProfile(params: {
  userId: string;
  bio?: string | null;
  avatarPath?: string | null;
  customFieldsJson?: string | null;
}): void {
  getDb().query(
    `INSERT INTO user_profile (user_id, bio, avatar_path, custom_fields_json, updated_at)
     VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(user_id) DO UPDATE SET
       bio = excluded.bio,
       avatar_path = excluded.avatar_path,
       custom_fields_json = excluded.custom_fields_json,
       updated_at = unixepoch()`
  ).run(
    params.userId, params.bio ?? null, params.avatarPath ?? null,
    params.customFieldsJson ?? null,
  );
}

export function setUserDisplayName(userId: string, displayName: string): void {
  getDb().query(`UPDATE users SET display_name = ?, updated_at = unixepoch() WHERE id = ?`)
    .run(displayName, userId);
}

export interface AiPickRow {
  id: string;
  user_id: string;
  title: string;
  url: string | null;
  summary: string | null;
  why_picked: string | null;
  picked_by_bot_id: string | null;
  picked_at: number;
  removed_at: number | null;
}

export function listAiPicks(userId: string, includeRemoved = false): AiPickRow[] {
  const sql = includeRemoved
    ? `SELECT * FROM ai_picks WHERE user_id = ? ORDER BY picked_at DESC`
    : `SELECT * FROM ai_picks WHERE user_id = ? AND removed_at IS NULL ORDER BY picked_at DESC`;
  return getDb().query<AiPickRow, [string]>(sql).all(userId);
}

export function createAiPick(params: {
  id: string; userId: string; title: string; url?: string | null;
  summary?: string | null; whyPicked?: string | null; pickedByBotId?: string | null;
}): void {
  getDb().query(
    `INSERT INTO ai_picks (id, user_id, title, url, summary, why_picked, picked_by_bot_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.id, params.userId, params.title,
    params.url ?? null, params.summary ?? null,
    params.whyPicked ?? null, params.pickedByBotId ?? null,
  );
}

export function softDeleteAiPick(id: string): void {
  getDb().query(`UPDATE ai_picks SET removed_at = unixepoch() WHERE id = ?`).run(id);
}

export function hardDeleteAiPick(id: string): void {
  getDb().query(`DELETE FROM ai_picks WHERE id = ?`).run(id);
}

// ---------- Skills ----------
//
// User-managed prompt fragments (Anthropic-style "Agent Skills"). Each row is
// one skill in the user's catalog; only `enabled = 1` rows participate in the
// system prompt. Bundled presets are seeded with `source = 'anthropic/skills:<name>'`
// and `seeded_hash = sha1(body)` so we can detect upstream drift without
// clobbering local edits — re-seed only refreshes rows whose body hash still
// matches the last seed.

export interface SkillRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  body: string;
  enabled: number;
  source: string | null;
  source_url: string | null;
  license: string | null;
  seeded_hash: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export function listSkillsForUser(userId: string): SkillRow[] {
  return getDb().query<SkillRow, [string]>(
    `SELECT * FROM skills WHERE user_id = ? ORDER BY sort_order, created_at`
  ).all(userId);
}

export function listEnabledSkillsForUser(userId: string): SkillRow[] {
  return getDb().query<SkillRow, [string]>(
    `SELECT * FROM skills WHERE user_id = ? AND enabled = 1 ORDER BY sort_order, created_at`
  ).all(userId);
}

export function findSkill(id: string): SkillRow | null {
  return getDb().query<SkillRow, [string]>(
    `SELECT * FROM skills WHERE id = ?`
  ).get(id) ?? null;
}

export function findSkillByName(userId: string, name: string): SkillRow | null {
  return getDb().query<SkillRow, [string, string]>(
    `SELECT * FROM skills WHERE user_id = ? AND name = ?`
  ).get(userId, name) ?? null;
}

export function createSkill(params: {
  id: string; userId: string; name: string;
  description?: string; body?: string; enabled?: boolean;
  source?: string | null; sourceUrl?: string | null;
  license?: string | null; seededHash?: string | null;
  sortOrder?: number;
}): void {
  getDb().query(
    `INSERT INTO skills
     (id, user_id, name, description, body, enabled, source, source_url, license, seeded_hash, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.id, params.userId, params.name,
    params.description ?? '', params.body ?? '',
    params.enabled ? 1 : 0,
    params.source ?? null, params.sourceUrl ?? null,
    params.license ?? null, params.seededHash ?? null,
    params.sortOrder ?? 0,
  );
}

export function updateSkill(id: string, patch: {
  name?: string; description?: string; body?: string;
  enabled?: boolean; sortOrder?: number;
  // seeded_hash is bumped here too so a user edit detaches the row
  // from the upstream seed (re-seed will skip it).
  seededHash?: string | null;
}): void {
  const fields: string[] = [];
  const args: any[] = [];
  if (patch.name !== undefined) { fields.push('name = ?'); args.push(patch.name); }
  if (patch.description !== undefined) { fields.push('description = ?'); args.push(patch.description); }
  if (patch.body !== undefined) { fields.push('body = ?'); args.push(patch.body); }
  if (patch.enabled !== undefined) { fields.push('enabled = ?'); args.push(patch.enabled ? 1 : 0); }
  if (patch.sortOrder !== undefined) { fields.push('sort_order = ?'); args.push(patch.sortOrder); }
  if (patch.seededHash !== undefined) { fields.push('seeded_hash = ?'); args.push(patch.seededHash); }
  if (fields.length === 0) return;
  fields.push('updated_at = unixepoch()');
  args.push(id);
  getDb().query(`UPDATE skills SET ${fields.join(', ')} WHERE id = ?`).run(...args);
}

export function deleteSkill(id: string): void {
  getDb().query(`DELETE FROM skills WHERE id = ?`).run(id);
}

// ---------- Per-user per-bot model override ----------
//
// One row per (user, bot) the user has explicitly pinned a model on. Absence
// = "follow the bot's default." Set/cleared from 我 → 机器人管理 → bot.

export function getUserBotModel(userId: string, botId: string): string | null {
  const row = getDb().query<{ model: string }, [string, string]>(
    `SELECT model FROM user_bot_model_overrides WHERE user_id = ? AND bot_id = ?`
  ).get(userId, botId);
  return row?.model ?? null;
}

export function setUserBotModel(userId: string, botId: string, model: string | null): void {
  if (model === null || model.trim() === '') {
    getDb().query(
      `DELETE FROM user_bot_model_overrides WHERE user_id = ? AND bot_id = ?`
    ).run(userId, botId);
    return;
  }
  getDb().query(
    `INSERT INTO user_bot_model_overrides (user_id, bot_id, model)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, bot_id) DO UPDATE SET
       model = excluded.model,
       updated_at = unixepoch()`
  ).run(userId, botId, model.trim());
}

// ---------- Portraits ----------

export type PortraitKind = 'moments' | 'memos' | 'schedule' | 'alarms' | 'bills';

export interface PortraitRow {
  id: string;
  conversation_id: string;
  source_conversation_id: string | null;
  kind: PortraitKind;
  with_image: number;
  status: string;
  content_json: string;
  created_at: number;
  updated_at: number;
}

export function createPortrait(params: {
  id: string;
  conversationId: string;
  sourceConversationId: string | null;
  kind: PortraitKind;
  withImage: boolean;
  contentJson: string;
  status?: string;
}): void {
  getDb().query(
    `INSERT INTO portraits (id, conversation_id, source_conversation_id, kind, with_image, status, content_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.id, params.conversationId, params.sourceConversationId,
    params.kind, params.withImage ? 1 : 0,
    params.status ?? 'ready', params.contentJson,
  );
}

export function listPortraitsByConversation(conversationId: string): PortraitRow[] {
  return getDb().query<PortraitRow, [string]>(
    `SELECT * FROM portraits WHERE conversation_id = ? ORDER BY created_at DESC`
  ).all(conversationId);
}

export function deletePortrait(id: string): void {
  getDb().query(`DELETE FROM portraits WHERE id = ?`).run(id);
}

// API keys (iOS thin client). Raw key is never persisted — only SHA-256 hash.
// `share_token` is a separate handle used by /i/<token> so the raw key stays
// out of share URLs; rotating it invalidates outstanding share links without
// touching the key itself.

export interface ApiKeyRow {
  id: string;
  key_prefix: string;
  key_hash: string;
  user_id: string;
  name: string;
  share_token: string | null;
  share_base_url: string | null;
  share_alt_urls_json: string | null;
  created_by: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export function createApiKey(params: {
  id: string;
  keyPrefix: string;
  keyHash: string;
  userId: string;
  name: string;
  shareToken: string | null;
  shareBaseUrl: string | null;
  shareAltUrls: string[] | null;
  createdBy: string | null;
}): void {
  getDb().query(
    `INSERT INTO api_keys
       (id, key_prefix, key_hash, user_id, name, share_token,
        share_base_url, share_alt_urls_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.id, params.keyPrefix, params.keyHash, params.userId,
    params.name, params.shareToken,
    params.shareBaseUrl,
    params.shareAltUrls && params.shareAltUrls.length > 0
      ? JSON.stringify(params.shareAltUrls)
      : null,
    params.createdBy,
  );
}

export function updateApiKeyShareUrls(
  id: string,
  shareBaseUrl: string | null,
  shareAltUrls: string[] | null,
): void {
  getDb().query(
    `UPDATE api_keys SET share_base_url = ?, share_alt_urls_json = ? WHERE id = ?`
  ).run(
    shareBaseUrl,
    shareAltUrls && shareAltUrls.length > 0 ? JSON.stringify(shareAltUrls) : null,
    id,
  );
}

export function findApiKeyByHash(keyHash: string): ApiKeyRow | null {
  return getDb().query<ApiKeyRow, [string]>(
    'SELECT * FROM api_keys WHERE key_hash = ?'
  ).get(keyHash) ?? null;
}

export function findApiKeyById(id: string): ApiKeyRow | null {
  return getDb().query<ApiKeyRow, [string]>(
    'SELECT * FROM api_keys WHERE id = ?'
  ).get(id) ?? null;
}

export function findApiKeyByShareToken(shareToken: string): ApiKeyRow | null {
  return getDb().query<ApiKeyRow, [string]>(
    'SELECT * FROM api_keys WHERE share_token = ?'
  ).get(shareToken) ?? null;
}

export function listApiKeys(): ApiKeyRow[] {
  return getDb().query<ApiKeyRow, []>(
    'SELECT * FROM api_keys ORDER BY created_at DESC'
  ).all();
}

export function revokeApiKey(id: string): void {
  getDb().query(
    'UPDATE api_keys SET revoked_at = unixepoch(), share_token = NULL WHERE id = ? AND revoked_at IS NULL'
  ).run(id);
}

export function rotateApiKeyShareToken(id: string, newShareToken: string): void {
  getDb().query(
    'UPDATE api_keys SET share_token = ? WHERE id = ?'
  ).run(newShareToken, id);
}

export function clearApiKeyShareToken(id: string): void {
  getDb().query(
    'UPDATE api_keys SET share_token = NULL WHERE id = ?'
  ).run(id);
}

export function touchApiKey(id: string): void {
  getDb().query(
    'UPDATE api_keys SET last_used_at = unixepoch() WHERE id = ?'
  ).run(id);
}

// ---------- Invites (account onboarding) ----------
//
// One row per outstanding/redeemed invite. Token is the random handle that
// goes into the share URL `/i/<token>`; the recipient hits redeem with a
// chosen display_name and the server creates a fresh users row + api_keys
// row + sets the session cookie. Single-use (clearing happens via the
// redeemed_* columns rather than deletion so the admin dashboard can
// audit "who joined when via which invite").

export interface InviteRow {
  id: string;
  token: string;
  created_by: string;
  note: string | null;
  expires_at: number | null;
  redeemed_at: number | null;
  redeemed_by_user_id: string | null;
  created_at: number;
}

export function createInvite(params: {
  id: string;
  token: string;
  createdBy: string;
  note?: string | null;
  expiresAt?: number | null;
}): void {
  getDb().query(
    `INSERT INTO invites (id, token, created_by, note, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    params.id, params.token, params.createdBy,
    params.note ?? null, params.expiresAt ?? null,
  );
}

export function findInviteByToken(token: string): InviteRow | null {
  return getDb().query<InviteRow, [string]>(
    'SELECT * FROM invites WHERE token = ?'
  ).get(token);
}

export function findInviteById(id: string): InviteRow | null {
  return getDb().query<InviteRow, [string]>(
    'SELECT * FROM invites WHERE id = ?'
  ).get(id);
}

export function findLatestBootstrapInvite(): InviteRow | null {
  return getDb().query<InviteRow, []>(
    `SELECT * FROM invites WHERE id LIKE 'bootstrap\\_%' ESCAPE '\\'
     ORDER BY created_at DESC LIMIT 1`
  ).get();
}

export function listInvites(): InviteRow[] {
  return getDb().query<InviteRow, []>(
    'SELECT * FROM invites ORDER BY created_at DESC'
  ).all();
}

export function markInviteRedeemed(id: string, redeemedByUserId: string): void {
  getDb().query(
    `UPDATE invites SET redeemed_at = unixepoch(), redeemed_by_user_id = ?
     WHERE id = ? AND redeemed_at IS NULL`
  ).run(redeemedByUserId, id);
}

export function deleteInvite(id: string): void {
  getDb().query('DELETE FROM invites WHERE id = ? AND redeemed_at IS NULL').run(id);
}

// ── Clerk identity ─────────────────────────────────────────────────────────

export function findUserByClerkId(clerkUserId: string) {
  return getDb().query<any, [string]>(
    'SELECT * FROM users WHERE clerk_user_id = ?'
  ).get(clerkUserId);
}

export function setUserClerkIdentity(
  userId: string, clerkUserId: string, email: string | null,
) {
  getDb().query(
    `UPDATE users SET clerk_user_id = ?, email = ?, updated_at = unixepoch() WHERE id = ?`
  ).run(clerkUserId, email, userId);
}

// ── Quota ──────────────────────────────────────────────────────────────────

export interface UserQuotaRow {
  user_id: string;
  monthly_budget_usd: number;
  used_usd: number;
  period_start: number;
  period_end: number;
  hard_blocked: number;
  updated_at: number;
}

export function getUserQuota(userId: string): UserQuotaRow | null {
  return (getDb().query<any, [string]>(
    'SELECT * FROM user_quota WHERE user_id = ?'
  ).get(userId) as UserQuotaRow | null);
}

export function upsertUserQuota(
  userId: string, periodStart: number, periodEnd: number,
  monthlyBudgetUsd: number,
) {
  getDb().query(
    `INSERT INTO user_quota
      (user_id, monthly_budget_usd, used_usd, period_start, period_end)
     VALUES (?, ?, 0, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
        monthly_budget_usd = excluded.monthly_budget_usd,
        updated_at = unixepoch()`
  ).run(userId, monthlyBudgetUsd, periodStart, periodEnd);
}

export function rolloverQuotaPeriod(
  userId: string, periodStart: number, periodEnd: number,
) {
  getDb().query(
    `UPDATE user_quota
        SET used_usd = 0, period_start = ?, period_end = ?,
            hard_blocked = 0, updated_at = unixepoch()
      WHERE user_id = ?`
  ).run(periodStart, periodEnd, userId);
}

export function chargeUserQuota(userId: string, costUsd: number) {
  getDb().query(
    `UPDATE user_quota
        SET used_usd = used_usd + ?, updated_at = unixepoch()
      WHERE user_id = ?`
  ).run(costUsd, userId);
}

export function setUserQuotaBudget(userId: string, monthlyBudgetUsd: number) {
  getDb().query(
    `UPDATE user_quota SET monthly_budget_usd = ?, updated_at = unixepoch()
      WHERE user_id = ?`
  ).run(monthlyBudgetUsd, userId);
}

// ── User settings (BYOK) ───────────────────────────────────────────────────

export interface UserSettingsRow {
  user_id: string;
  openrouter_key_enc: Uint8Array | null;
  openrouter_key_last4: string | null;
  jina_key_enc: Uint8Array | null;
  jina_key_last4: string | null;
  updated_at: number;
}

export function getUserSettings(userId: string): UserSettingsRow | null {
  return (getDb().query<any, [string]>(
    'SELECT * FROM user_settings WHERE user_id = ?'
  ).get(userId) as UserSettingsRow | null);
}

export function setOpenrouterByok(
  userId: string, enc: Uint8Array | null, last4: string | null,
) {
  getDb().query(
    `INSERT INTO user_settings (user_id, openrouter_key_enc, openrouter_key_last4, updated_at)
     VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(user_id) DO UPDATE SET
       openrouter_key_enc = excluded.openrouter_key_enc,
       openrouter_key_last4 = excluded.openrouter_key_last4,
       updated_at = unixepoch()`
  ).run(userId, enc, last4);
}

export function setJinaByok(
  userId: string, enc: Uint8Array | null, last4: string | null,
) {
  getDb().query(
    `INSERT INTO user_settings (user_id, jina_key_enc, jina_key_last4, updated_at)
     VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(user_id) DO UPDATE SET
       jina_key_enc = excluded.jina_key_enc,
       jina_key_last4 = excluded.jina_key_last4,
       updated_at = unixepoch()`
  ).run(userId, enc, last4);
}

// ── meta (v30) — boot-time invariants ────────────────────────────────────

export function getMeta(k: string): string | null {
  const row = getDb().query<{ v: string }, [string]>(
    'SELECT v FROM meta WHERE k = ?'
  ).get(k);
  return row?.v ?? null;
}

export function setMeta(k: string, v: string): void {
  getDb().query(
    `INSERT INTO meta (k, v, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = unixepoch()`
  ).run(k, v);
}

// Sweep orphans older than N seconds — called periodically by a background
// timer. 15 minutes is the default so a slow client still has time to bind.
export function deleteOrphanAttachments(olderThanSec: number = 900): string[] {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSec;
  const rows = db.query<{ path: string }, [number]>(
    'SELECT path FROM attachments WHERE message_id IS NULL AND created_at < ?'
  ).all(cutoff);
  db.query('DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?').run(cutoff);
  return rows.map(r => r.path);
}
