import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { chatCompletion, chatCompletionStream } from '../../llm/client';
import { logAudit } from '../../llm/audit';
import { configManager } from '../../config/loader';
import {
  findConversationById, getMessages, insertMessage, updateConversationActivity,
  getDebateSettings, bumpDebateRound, findConversation,
} from '../../db/queries';
import type { OutboundMessage } from '../../bus/types';
import { generateTitle } from '../title';

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
  // Optional live-stream callback. When provided, the debater is generated
  // via chatCompletionStream and each non-empty content delta is forwarded
  // here so the caller can fan it out (e.g. as SSE stream_delta frames).
  // The final assembled text + PASS detection still come back via the
  // returned DebaterOutput exactly like the non-streaming path.
  onDelta?: (delta: string) => void;
}): Promise<DebaterOutput> {
  const { userId, conversationId, botId, topic, ownContext, transcript, systemPrompt, onDelta } = params;

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

  let raw = '';
  let generationId: string | undefined;
  let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number } | undefined;
  let latencyMs = 0;

  if (onDelta) {
    // Streaming path — each chunk's content delta is both forwarded to the
    // caller's onDelta and accumulated into `raw` so PASS detection + the
    // returned DebaterOutput stay byte-identical to the non-streaming path.
    const { stream, startTime } = await chatCompletionStream({ model, messages });
    for await (const chunk of stream) {
      if (!generationId && chunk.id) generationId = chunk.id;
      if (chunk.usage) usage = chunk.usage as any;
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        raw += delta;
        onDelta(delta);
      }
    }
    latencyMs = Date.now() - startTime;
    raw = raw.trim();
  } else {
    const res = await chatCompletion({ model, messages });
    latencyMs = res.latencyMs;
    generationId = res.result.id;
    usage = res.result.usage as any;
    raw = res.result.choices[0]?.message?.content?.trim() ?? '';
  }

  logAudit({
    userId,
    conversationId, taskType: 'debate', model,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
    costUsd: usage?.cost,
    generationId,
    latencyMs,
  });
  // Be liberal about how the bot signals "no add" — `[PASS]`, `PASS`, or just
  // `pass` on its own line all count. Also catches outputs that wrap the
  // sentinel in punctuation (e.g. `「PASS」`) or quotes. Without this we'd
  // forward bare `pass` as a real message.
  const stripped = raw.replace(/^[\s\[\]【】「」“”"'.。，,]+|[\s\[\]【】「」“”"'.。，,]+$/g, '');
  const passed = /^pass$/i.test(stripped);
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

    // Pre-mint the message id so stream_start, every stream_delta, and
    // stream_end (and the `message` reply) all share it — that's what lets
    // the client key its growing bubble.
    const msgId = randomUUID();
    const botCfgForMeta = configManager.getBotConfig(botId);
    const senderMeta = {
      sender_kind: 'debater',
      bot_id: botId,
      display_name: botCfgForMeta.displayName || botId,
    };
    let streamOpenedForMsg = false;
    const openStream = () => {
      if (streamOpenedForMsg) return;
      streamOpenedForMsg = true;
      replyFn({
        type: 'stream_start',
        conversationId,
        messageId: msgId,
        metadata: senderMeta,
      });
    };

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
        onDelta: (delta) => {
          // Open the stream on the first real delta so a bot that turns out
          // to be PASS (no real text emitted before the model returns) doesn't
          // leave an orphan placeholder bubble on the client.
          openStream();
          replyFn({
            type: 'stream_delta',
            conversationId,
            messageId: msgId,
            delta,
            metadata: senderMeta,
          });
        },
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
      // PASS is a legitimate choice, not a failure — don't bump
      // consecutiveFailures (which is reserved for hard errors). The pass
      // still counts toward maxMessages because the for-loop step increment
      // consumes a turn slot regardless.
      // If we'd already opened a stream (the model emitted text and then
      // resolved to PASS — rare but possible), close it with empty content
      // so the client collapses the placeholder bubble.
      if (streamOpenedForMsg) {
        replyFn({
          type: 'stream_end',
          conversationId,
          messageId: msgId,
          content: '',
          metadata: senderMeta,
        });
      }
      emit(conversationId, `[${out.displayName}] 跳过（[PASS]）`);
      lastBotId = botId;
      continue;
    }

    consecutiveFailures = 0;
    lastBotId = botId;

    insertMessage(msgId, conversationId, 'debater', out.botId, out.text);
    if (streamOpenedForMsg) {
      // Streamed path — finalize the live bubble. No extra `message` reply
      // is emitted for this id because the client already grew it from
      // deltas; stream_end carries the canonical text for any client that
      // missed deltas (web SSE listeners, reconnects mid-round, etc).
      replyFn({
        type: 'stream_end',
        conversationId,
        messageId: msgId,
        content: out.text,
        metadata: senderMeta,
      });
    } else {
      // Defensive fallback — if onDelta never fired (e.g. provider returned
      // the entire body in one chunk) we still need to deliver the message.
      replyFn({
        type: 'message',
        conversationId,
        messageId: msgId,
        content: out.text,
        metadata: senderMeta,
      });
    }
    delivered++;
  }

  cancelRequests.delete(conversationId);
  updateConversationActivity(conversationId);

  // Retitle from the transcript so the sidebar tracks where the discussion has
  // moved (same prompt as 消息 titles). Awaited before the `done` event so the
  // client can re-fetch and see the new title in one round-trip. Errors are
  // swallowed inside generateTitle.
  if (delivered > 0) {
    await generateTitle(conversationId, replyFn, { force: true });
  }

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
