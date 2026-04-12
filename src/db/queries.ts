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
export function findConversation(botId: string, userId: string) {
  return getDb().query<any, [string, string]>(
    'SELECT * FROM conversations WHERE bot_id = ? AND user_id = ?'
  ).get(botId, userId);
}

export function findConversationById(id: string) {
  return getDb().query<any, [string]>('SELECT * FROM conversations WHERE id = ?').get(id);
}

export function createConversation(id: string, botId: string, userId: string) {
  getDb().query(
    'INSERT INTO conversations (id, bot_id, user_id) VALUES (?, ?, ?)'
  ).run(id, botId, userId);
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

export function updateAuditCost(generationId: string, costUsd: number, upstreamCostUsd: number, generationTimeMs: number) {
  getDb().query(
    'UPDATE audit_log SET cost_usd = ?, upstream_cost_usd = ?, generation_time_ms = ? WHERE generation_id = ?'
  ).run(costUsd, upstreamCostUsd, generationTimeMs, generationId);
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

export function resetConversation(conversationId: string) {
  const db = getDb();
  db.query('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
  db.query('DELETE FROM debounce_buffer WHERE conversation_id = ?').run(conversationId);
  db.query('DELETE FROM audit_log WHERE conversation_id = ?').run(conversationId);
  db.query('UPDATE conversations SET round_count = 0, last_sender = NULL, surf_last_at = NULL WHERE id = ?').run(conversationId);
}

export function listConversationsByUser(userId: string) {
  return getDb().query<any, [string]>(
    `SELECT c.*, b.display_name as bot_name FROM conversations c
     JOIN bots b ON c.bot_id = b.id WHERE c.user_id = ? ORDER BY c.last_activity_at DESC`
  ).all(userId);
}
