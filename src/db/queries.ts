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
// Returns the most recent conversation for (botId, userId) — multi-conversation
// makes (bot_id, user_id) non-unique, so we always pick the latest by activity.
export function findConversation(botId: string, userId: string) {
  return getDb().query<any, [string, string]>(
    'SELECT * FROM conversations WHERE bot_id = ? AND user_id = ? ORDER BY last_activity_at DESC LIMIT 1'
  ).get(botId, userId);
}

export function findConversationById(id: string) {
  return getDb().query<any, [string]>('SELECT * FROM conversations WHERE id = ?').get(id);
}

export function createConversation(id: string, botId: string, userId: string, title?: string | null) {
  getDb().query(
    'INSERT INTO conversations (id, bot_id, user_id, title) VALUES (?, ?, ?, ?)'
  ).run(id, botId, userId, title ?? null);
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
  db.query('DELETE FROM debounce_buffer WHERE conversation_id = ?').run(id);
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

// Debounce buffer
export function addToDebounceBuffer(conversationId: string, content: string) {
  getDb().query(
    'INSERT INTO debounce_buffer (conversation_id, content) VALUES (?, ?)'
  ).run(conversationId, content);
}

export function getDebounceBuffer(conversationId: string) {
  return getDb().query<any, [string]>(
    'SELECT * FROM debounce_buffer WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(conversationId);
}

export function clearDebounceBuffer(conversationId: string) {
  getDb().query('DELETE FROM debounce_buffer WHERE conversation_id = ?').run(conversationId);
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
  db.query('DELETE FROM debounce_buffer WHERE conversation_id = ?').run(conversationId);
  db.query('DELETE FROM audit_log WHERE conversation_id = ?').run(conversationId);
  db.query('UPDATE conversations SET round_count = 0, last_sender = NULL, surf_last_at = NULL WHERE id = ?').run(conversationId);
  return attachmentPaths;
}

export function listConversationsByUser(userId: string) {
  return getDb().query<any, [string]>(
    `SELECT c.*, b.display_name as bot_name FROM conversations c
     JOIN bots b ON c.bot_id = b.id WHERE c.user_id = ? ORDER BY c.last_activity_at DESC`
  ).all(userId);
}

export function findLatestConversationByBot(botId: string) {
  return getDb().query<any, [string]>(
    `SELECT * FROM conversations WHERE bot_id = ?
     ORDER BY last_activity_at DESC LIMIT 1`
  ).get(botId);
}

export function listConversationsByBot(botId: string) {
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

// The next three return the paths of the rows that will be removed so the
// caller can `unlink` the actual files on disk. Row deletion happens inside
// a single transaction; file deletion is best-effort and done by the caller.
export function deleteAttachmentsByMessage(messageId: string): string[] {
  const db = getDb();
  const rows = db.query<{ path: string }, [string]>(
    'SELECT path FROM attachments WHERE message_id = ?'
  ).all(messageId);
  db.query('DELETE FROM attachments WHERE message_id = ?').run(messageId);
  return rows.map(r => r.path);
}

export function deleteAttachmentsByConversation(conversationId: string): string[] {
  const db = getDb();
  const rows = db.query<{ path: string }, [string]>(
    'SELECT path FROM attachments WHERE conversation_id = ?'
  ).all(conversationId);
  db.query('DELETE FROM attachments WHERE conversation_id = ?').run(conversationId);
  return rows.map(r => r.path);
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
