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

export function createUser(id: string, channel: string, externalId: string, displayName: string) {
  getDb().query(
    'INSERT INTO users (id, channel, external_id, display_name) VALUES (?, ?, ?, ?)'
  ).run(id, channel, externalId, displayName);
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

export function countMessages(conversationId: string): number {
  const row = getDb().query<{ n: number }, [string]>(
    'SELECT COUNT(*) as n FROM messages WHERE conversation_id = ?'
  ).get(conversationId);
  return row?.n ?? 0;
}

// All messages in chronological order, tiebreaking on rowid so multi-segment
// bot replies (same second) stay ordered the way they were inserted. Used by
// regenerate to slice the tail of the conversation after a chosen point.
export function getAllMessagesAsc(conversationId: string) {
  return getDb().query<any, [string]>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC'
  ).all(conversationId);
}

// Audit
export function insertAudit(entry: {
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
    `INSERT INTO audit_log (conversation_id, task_type, model, input_tokens, output_tokens, total_tokens, cached_tokens, cost_usd, generation_id, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.conversationId ?? null, entry.taskType, entry.model,
    entry.inputTokens, entry.outputTokens, entry.totalTokens,
    entry.cachedTokens ?? 0, entry.costUsd ?? null,
    entry.generationId ?? null, entry.latencyMs ?? null
  );
}

export function getAuditSummary(from: number, to: number, groupBy: string = 'task_type') {
  const col = groupBy === 'model' ? 'model' : 'task_type';
  return getDb().query<any, [number, number]>(
    `SELECT ${col} as group_key, COUNT(*) as count,
     SUM(input_tokens) as total_input, SUM(output_tokens) as total_output,
     SUM(total_tokens) as total_tokens, SUM(cost_usd) as total_cost
     FROM audit_log WHERE created_at BETWEEN ? AND ? GROUP BY ${col}`
  ).all(from, to);
}

export function getAuditDetails(limit: number = 100, offset: number = 0) {
  return getDb().query<any, [number, number]>(
    'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
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

export function listConversationsByUser(userId: string, featureType?: string) {
  if (featureType) {
    return getDb().query<any, [string, string]>(
      `SELECT c.*, b.display_name as bot_name FROM conversations c
       JOIN bots b ON c.bot_id = b.id WHERE c.user_id = ? AND c.feature_type = ?
       ORDER BY c.last_activity_at DESC`
    ).all(userId, featureType);
  }
  return getDb().query<any, [string]>(
    `SELECT c.*, b.display_name as bot_name FROM conversations c
     JOIN bots b ON c.bot_id = b.id WHERE c.user_id = ? ORDER BY c.last_activity_at DESC`
  ).all(userId);
}

export function listConversationsByBot(botId: string, featureType?: string) {
  if (featureType) {
    return getDb().query<any, [string, string]>(
      `SELECT c.*, u.display_name as user_name FROM conversations c
       JOIN users u ON c.user_id = u.id WHERE c.bot_id = ? AND c.feature_type = ?
       ORDER BY c.last_activity_at DESC`
    ).all(botId, featureType);
  }
  return getDb().query<any, [string]>(
    `SELECT c.*, u.display_name as user_name FROM conversations c
     JOIN users u ON c.user_id = u.id WHERE c.bot_id = ?
     ORDER BY c.last_activity_at DESC`
  ).all(botId);
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

// ---------- Debate / Provider models ----------

export interface ProviderModelRow {
  id: string;
  provider: string;
  slug: string;
  display_name: string;
  enabled: number;
  created_at: number;
}

export function listProviderModels(enabledOnly = false): ProviderModelRow[] {
  const sql = enabledOnly
    ? 'SELECT * FROM provider_models WHERE enabled = 1 ORDER BY provider, display_name'
    : 'SELECT * FROM provider_models ORDER BY provider, display_name';
  return getDb().query<ProviderModelRow, []>(sql).all();
}

export function findProviderModelBySlug(slug: string): ProviderModelRow | null {
  return getDb().query<ProviderModelRow, [string]>(
    'SELECT * FROM provider_models WHERE slug = ?'
  ).get(slug);
}

export function createProviderModel(
  id: string, provider: string, slug: string, displayName: string,
): void {
  getDb().query(
    `INSERT INTO provider_models (id, provider, slug, display_name) VALUES (?, ?, ?, ?)`
  ).run(id, provider, slug, displayName);
}

export function updateProviderModelEnabled(id: string, enabled: boolean): void {
  getDb().query('UPDATE provider_models SET enabled = ? WHERE id = ?')
    .run(enabled ? 1 : 0, id);
}

export function deleteProviderModel(id: string): void {
  getDb().query('DELETE FROM provider_models WHERE id = ?').run(id);
}

export interface DebateSettingsRow {
  conversation_id: string;
  model_slugs: string;
  topic: string | null;
  round_count: number;
  created_at: number;
  updated_at: number;
}

export function createDebateSettings(
  conversationId: string, modelSlugs: string[], topic: string | null,
): void {
  getDb().query(
    `INSERT INTO debate_settings (conversation_id, model_slugs, topic) VALUES (?, ?, ?)`
  ).run(conversationId, JSON.stringify(modelSlugs), topic);
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

export function findPortrait(id: string): PortraitRow | null {
  return getDb().query<PortraitRow, [string]>(
    `SELECT * FROM portraits WHERE id = ?`
  ).get(id);
}

export function deletePortrait(id: string): void {
  getDb().query(`DELETE FROM portraits WHERE id = ?`).run(id);
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
