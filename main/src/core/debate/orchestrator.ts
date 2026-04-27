import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { chatCompletion } from '../../llm/client';
import { logAudit } from '../../llm/audit';
import { configManager } from '../../config/loader';
import {
  findConversationById, getMessages, insertMessage, updateConversationActivity,
  getDebateSettings, bumpDebateRound, findConversation,
} from '../../db/queries';
import type { OutboundMessage } from '../../bus/types';

export const debateEvents = new EventEmitter();

// Conversations whose currently-running round should stop after the in-flight
// message lands. The orchestrator clears the flag at the top of every round
// and consults it between iterations.
const cancelRequests = new Set<string>();

export function requestPause(conversationId: string): boolean {
  cancelRequests.add(conversationId);
  return true;
}

const ROUND_HISTORY_LIMIT = 80;
const DEFAULT_MAX_MESSAGES_PER_ROUND = 30;
const MAX_MESSAGES_PER_ROUND_HARD_CAP = 200;

function emit(conversationId: string, content: string, kind: string = 'log') {
  debateEvents.emit('log', {
    conversationId, kind, content, timestamp: Date.now(),
  });
}

interface DebaterOutput {
  botId: string;
  displayName: string;
  text: string;
  passed: boolean;
}

async function loadPrompt(): Promise<string> {
  return configManager.readPrompt('debate.md');
}

function fillPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

// Render a single debater's transcript. Each prior debater message appears as
// `<{botId}> ...`. User clarifications (sender_type='user', kind='clarify')
// are tagged `<用户辟谣>` so the bot treats them as authoritative updates.
function renderTranscript(
  rows: Array<{
    sender_type: string; sender_id: string; content: string; created_at: number;
  }>,
  selfBotId: string,
): string {
  if (rows.length === 0) return '（这是第一轮，还没有发言）';
  return rows.map(r => {
    if (r.sender_type === 'user') {
      return `<用户辟谣>\n${r.content}\n</用户辟谣>`;
    }
    if (r.sender_type === 'debater') {
      const tag = r.sender_id === selfBotId ? `<${r.sender_id} (你自己)>` : `<${r.sender_id}>`;
      return `${tag}\n${r.content}\n`;
    }
    return r.content;
  }).join('\n');
}

async function runOneDebater(params: {
  userId: string;
  conversationId: string;
  botId: string;
  topic: string | null;
  ownContext: string;
  transcript: string;
  systemPrompt: string;
}): Promise<DebaterOutput> {
  const { userId, conversationId, botId, topic, ownContext, transcript, systemPrompt } = params;

  // Resolve bot → model + display name. If the bot vanished from config
  // mid-debate, fall back to using the id as the name and bail; the caller
  // catches the throw and counts it as a failure.
  const botCfg = configManager.getBotConfig(botId);
  const displayName = botCfg.displayName || botId;
  const model = botCfg.model;

  const filledSystem = fillPrompt(systemPrompt, { bot_display_name: displayName });

  const userBlock = [
    topic ? `议题：${topic}` : '议题：对该用户最近的对话与立场的整体观感。',
    '',
    '─── 你和对方最近的对话 ───',
    ownContext || '（你和该用户还没有过对话）',
    '',
    '─── 已有议论记录 ───',
    transcript,
    '',
    `请你以 ${displayName} 的身份发表这一轮。`,
  ].join('\n');

  const messages = [
    { role: 'system' as const, content: filledSystem },
    { role: 'user' as const, content: userBlock },
  ];

  const { result, latencyMs, costUsd } = await chatCompletion({
    model, messages,
  });

  logAudit({
    userId,
    conversationId, taskType: 'debate', model,
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
    totalTokens: result.usage?.total_tokens ?? 0,
    costUsd,
    generationId: result.id,
    latencyMs,
  });

  const raw = result.choices[0]?.message?.content?.trim() ?? '';
  const passed = /^\s*\[PASS\]\s*$/i.test(raw);
  return { botId, displayName, text: passed ? '' : raw, passed };
}

// Pull this bot's own recent conversation with the user. Each debater uses
// its own message-conv as personal context — no shared "source" snippet.
function loadOwnContext(botId: string, userId: string): string {
  const msgConv = findConversation(botId, userId, 'message');
  if (!msgConv) return '';
  const msgs = getMessages(msgConv.id, 30);
  return msgs.map((m: any) =>
    `${m.sender_type === 'user' ? '用户' : '机器人'}：${m.content}`
  ).join('\n');
}

function pickNextBotId(botIds: string[], lastBotId: string | null): string {
  if (botIds.length === 1) return botIds[0];
  const pool = lastBotId ? botIds.filter(s => s !== lastBotId) : botIds;
  const choices = pool.length > 0 ? pool : botIds;
  return choices[Math.floor(Math.random() * choices.length)];
}

export async function runDebateRound(
  conversationId: string,
  replyFn: (msg: OutboundMessage) => void,
  opts: { maxMessages?: number } = {},
): Promise<{ delivered: number; round: number }> {
  const conv = findConversationById(conversationId);
  if (!conv) throw new Error('conversation not found');
  if (conv.feature_type !== 'debate') throw new Error('not a debate conversation');

  const settings = getDebateSettings(conversationId);
  if (!settings) throw new Error('debate settings missing');

  const botIds: string[] = JSON.parse(settings.bot_ids);
  if (!Array.isArray(botIds) || botIds.length < 2) {
    throw new Error('debate needs at least 2 bots');
  }

  const requested = Number.isFinite(opts.maxMessages) ? Number(opts.maxMessages) : DEFAULT_MAX_MESSAGES_PER_ROUND;
  const maxMessages = Math.max(1, Math.min(requested, MAX_MESSAGES_PER_ROUND_HARD_CAP));

  // Fresh round — clear any stale pause flag before we start.
  cancelRequests.delete(conversationId);

  const round = bumpDebateRound(conversationId);
  emit(conversationId, `Round ${round} 开始 · 群聊上限 ${maxMessages} 条 · 参与机器人 ${botIds.length} 个`);

  // Pre-load each participating bot's own recent conv with this user so we
  // don't re-query SQLite every step.
  const ownContextByBot = new Map<string, string>();
  for (const id of botIds) {
    ownContextByBot.set(id, loadOwnContext(id, conv.user_id));
  }
  const systemPrompt = await loadPrompt();

  let delivered = 0;
  let lastBotId: string | null = null;
  let consecutiveFailures = 0;
  let paused = false;
  const failureLimit = botIds.length * 2;

  for (let step = 0; step < maxMessages; step++) {
    if (cancelRequests.has(conversationId)) {
      paused = true;
      break;
    }
    const botId = pickNextBotId(botIds, lastBotId);
    const history = getMessages(conversationId, ROUND_HISTORY_LIMIT);

    let out: DebaterOutput;
    try {
      out = await runOneDebater({
        userId: conv.user_id,
        conversationId,
        botId,
        topic: settings.topic,
        ownContext: ownContextByBot.get(botId) ?? '',
        transcript: renderTranscript(history, botId),
        systemPrompt,
      });
    } catch (e: any) {
      emit(conversationId, `⚠️ ${botId} 出错：${e?.message ?? e}`, 'error');
      consecutiveFailures++;
      if (consecutiveFailures >= failureLimit) {
        emit(conversationId, '连续失败过多，本轮提前结束', 'error');
        break;
      }
      continue;
    }

    if (out.passed || !out.text.trim()) {
      emit(conversationId, `[${out.displayName}] 跳过（[PASS]）`);
      consecutiveFailures++;
      lastBotId = botId;
      if (consecutiveFailures >= failureLimit) {
        emit(conversationId, '没人想接话了，本轮提前结束');
        break;
      }
      continue;
    }

    consecutiveFailures = 0;
    lastBotId = botId;

    const msgId = randomUUID();
    insertMessage(msgId, conversationId, 'debater', out.botId, out.text);
    replyFn({
      type: 'message',
      conversationId,
      messageId: msgId,
      content: out.text,
      metadata: { sender_kind: 'debater', bot_id: out.botId, display_name: out.displayName },
    });
    delivered++;
  }

  cancelRequests.delete(conversationId);
  updateConversationActivity(conversationId);
  const tail = paused ? `Round ${round} 已暂停 · 投递 ${delivered} 条` : `Round ${round} 完成 · 投递 ${delivered} 条`;
  emit(conversationId, tail, 'done');
  debateEvents.emit('done', { conversationId, round, delivered, paused, timestamp: Date.now() });

  return { delivered, round };
}

export function injectClarification(
  conversationId: string, content: string,
): string {
  const id = randomUUID();
  insertMessage(id, conversationId, 'user', 'clarify', content);
  updateConversationActivity(conversationId);
  emit(conversationId, `用户辟谣注入：${content.slice(0, 80)}${content.length > 80 ? '…' : ''}`);
  return id;
}
