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
  slug: string;
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
// `<{slug}> ...`. User clarifications (sender_type='user', kind='clarify')
// are tagged `<用户辟谣>` so the model treats them as authoritative updates.
function renderTranscript(
  rows: Array<{
    sender_type: string; sender_id: string; content: string; created_at: number;
  }>,
  selfSlug: string,
): string {
  if (rows.length === 0) return '（这是第一轮，还没有发言）';
  return rows.map(r => {
    if (r.sender_type === 'user') {
      return `<用户辟谣>\n${r.content}\n</用户辟谣>`;
    }
    if (r.sender_type === 'debater') {
      const tag = r.sender_id === selfSlug ? `<${r.sender_id} (你自己)>` : `<${r.sender_id}>`;
      return `${tag}\n${r.content}\n`;
    }
    return r.content;
  }).join('\n');
}

async function runOneDebater(params: {
  userId: string;
  conversationId: string;
  slug: string;
  displayName: string;
  topic: string | null;
  sourceContext: string;
  transcript: string;
  systemPrompt: string;
}): Promise<DebaterOutput> {
  const { userId, conversationId, slug, displayName, topic, sourceContext, transcript, systemPrompt } = params;

  const filledSystem = fillPrompt(systemPrompt, { model_display_name: displayName });

  const userBlock = [
    topic ? `议题：${topic}` : '议题：对该用户最近的对话与立场的整体观感。',
    '',
    '─── 对方最近的对话（与某 bot 的会话片段） ───',
    sourceContext || '（无相关源会话上下文）',
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
    model: slug, messages,
  });

  logAudit({
    userId,
    conversationId, taskType: 'debate', model: slug,
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
    totalTokens: result.usage?.total_tokens ?? 0,
    costUsd,
    generationId: result.id,
    latencyMs,
  });

  const raw = result.choices[0]?.message?.content?.trim() ?? '';
  const passed = /^\s*\[PASS\]\s*$/i.test(raw);
  return { slug, displayName, text: passed ? '' : raw, passed };
}

// Pull a snippet of a "source" message conversation if the debate has one
// linked. For now we use the most recent message conv of the same (bot,
// user) pair — caller can override later. Returns a flat string ready to
// embed.
function loadSourceContext(debateConv: {
  bot_id: string; user_id: string;
}): string {
  const msgConv = findConversation(debateConv.bot_id, debateConv.user_id, 'message');
  if (!msgConv) return '';
  const msgs = getMessages(msgConv.id, 30);
  return msgs.map((m: any) =>
    `${m.sender_type === 'user' ? '用户' : 'bot'}：${m.content}`
  ).join('\n');
}

function pickNextSlug(slugs: string[], lastSlug: string | null): string {
  if (slugs.length === 1) return slugs[0];
  const pool = lastSlug ? slugs.filter(s => s !== lastSlug) : slugs;
  const choices = pool.length > 0 ? pool : slugs;
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

  const slugs: string[] = JSON.parse(settings.model_slugs);
  if (!Array.isArray(slugs) || slugs.length < 2) {
    throw new Error('debate needs at least 2 models');
  }

  const requested = Number.isFinite(opts.maxMessages) ? Number(opts.maxMessages) : DEFAULT_MAX_MESSAGES_PER_ROUND;
  const maxMessages = Math.max(1, Math.min(requested, MAX_MESSAGES_PER_ROUND_HARD_CAP));

  // Fresh round — clear any stale pause flag before we start.
  cancelRequests.delete(conversationId);

  const round = bumpDebateRound(conversationId);
  emit(conversationId, `Round ${round} 开始 · 群聊上限 ${maxMessages} 条 · 参与模型 ${slugs.length} 个`);

  const sourceContext = loadSourceContext(conv);
  const systemPrompt = await loadPrompt();

  let delivered = 0;
  let lastSlug: string | null = null;
  let consecutiveFailures = 0;
  let paused = false;
  const failureLimit = slugs.length * 2;

  for (let step = 0; step < maxMessages; step++) {
    if (cancelRequests.has(conversationId)) {
      paused = true;
      break;
    }
    const slug = pickNextSlug(slugs, lastSlug);
    const history = getMessages(conversationId, ROUND_HISTORY_LIMIT);

    let out: DebaterOutput;
    try {
      out = await runOneDebater({
        userId: conv.user_id,
        conversationId,
        slug,
        displayName: slug,
        topic: settings.topic,
        sourceContext,
        transcript: renderTranscript(history, slug),
        systemPrompt,
      });
    } catch (e: any) {
      emit(conversationId, `⚠️ ${slug} 出错：${e?.message ?? e}`, 'error');
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
      lastSlug = slug;
      if (consecutiveFailures >= failureLimit) {
        emit(conversationId, '没人想接话了，本轮提前结束');
        break;
      }
      continue;
    }

    consecutiveFailures = 0;
    lastSlug = slug;

    const msgId = randomUUID();
    insertMessage(msgId, conversationId, 'debater', out.slug, out.text);
    replyFn({
      type: 'message',
      conversationId,
      messageId: msgId,
      content: out.text,
      metadata: { sender_kind: 'debater', slug: out.slug, display_name: out.displayName },
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
