import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { configManager } from '../config/loader';
import { chatCompletion } from '../llm/client';
import { logAudit } from '../llm/audit';
import {
  findConversationById, getMessages, insertMessage, createConversation,
  createReviewRun, getReviewRun, setReviewRunStatus,
  insertBotReflection, getRecentBotReflections,
} from '../db/queries';
import { getUserProfile, recordBotMessage } from '../honcho/memory';
import { runSearchLoop } from './search/loop';
import { modelForTask } from './models';
import type { OutboundMessage } from '../bus/types';

export const reviewEvents = new EventEmitter();

const pendingTimers = new Map<string, Timer>();

export const reviewsByMessageConv = new Map<string, string>(); // msgConvId → reviewConvId

interface SearchBlock {
  need: boolean;
  queries: string[];
  reason: string;
}

// ── Emit helpers ─────────────────────────────────────────────────────────────
//
// Two flavors of log events ride the same SSE channel:
//   - **plain status** (legacy text rows): `kind = "status"|"error"|...`
//   - **structured payloads** (cards): `kind = "step"|"card"|"closing"`
//     where the persisted content is JSON. The web/iOS UI tries JSON.parse
//     content first; on success it renders a card, otherwise a plain row.
//
// Persisting the JSON in `messages.content` means a page reload reconstructs
// the same cards without needing extra tables — the conversation IS the card
// list.

function persistAndEmit(
  reviewConvId: string,
  kind: string,
  content: string,
): void {
  try {
    insertMessage(randomUUID(), reviewConvId, 'log', `review:${kind}`, content);
  } catch (e) {
    console.warn('[review] emit log persist failed:', e);
  }
  reviewEvents.emit('log', {
    reviewConvId, conversationId: reviewConvId,
    sourceMessageConvId: getReviewRun(reviewConvId)?.source_message_conv_id ?? null,
    kind, content, timestamp: Date.now(),
  });
}

function emit(reviewConvId: string, content: string, kind: string = 'status') {
  persistAndEmit(reviewConvId, kind, content);
}

// Step card — a process beat. status flows running → done|error.
// label is the short title shown on the collapsed pill.
function emitStep(
  reviewConvId: string,
  step: string,
  label: string,
  status: 'running' | 'done' | 'error',
  detail?: string,
) {
  const payload = JSON.stringify({ type: 'step', step, label, status, detail: detail ?? null });
  persistAndEmit(reviewConvId, `step:${step}:${status}`, payload);
}

// Result card — a body of bullet items under a (side, bucket) heading.
function emitCard(
  reviewConvId: string,
  side: 'you' | 'me',
  bucket: 'limit' | 'grow' | 'keep',
  items: string[],
  label: string,
) {
  const payload = JSON.stringify({ type: 'card', side, bucket, items, label });
  persistAndEmit(reviewConvId, `card:${side}:${bucket}`, payload);
}

// Closing one-liner. mode='pass' = "nothing more to add"; 'note' = real line.
function emitClosing(reviewConvId: string, mode: 'pass' | 'note', content: string) {
  const payload = JSON.stringify({ type: 'closing', mode, content });
  persistAndEmit(reviewConvId, `closing:${mode}`, payload);
}

// ── Tag parsing ──────────────────────────────────────────────────────────────

function extractTag(text: string, tag: string): string {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() ?? '';
}

function parseBulletList(raw: string): string[] {
  if (!raw) return [];
  if (raw.trim() === '无') return [];
  const lines: string[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    // Strip leading -, *, • or numbered prefixes.
    const stripped = t.replace(/^[-*•]\s+/, '').replace(/^\d+[.、)]\s*/, '').trim();
    if (stripped && stripped !== '无') lines.push(stripped);
  }
  return lines;
}

function parseSearchBlock(text: string): SearchBlock {
  const raw = extractTag(text, '搜索');
  if (!raw) return { need: false, queries: [], reason: '' };
  const json = raw.match(/\{[\s\S]*\}/);
  if (!json) return { need: false, queries: [], reason: '' };
  try {
    const obj = JSON.parse(json[0]);
    return {
      need: !!obj.need,
      queries: Array.isArray(obj.queries) ? obj.queries.filter((q: any) => typeof q === 'string' && q.trim().length > 0) : [],
      reason: typeof obj.reason === 'string' ? obj.reason : '',
    };
  } catch {
    return { need: false, queries: [], reason: '' };
  }
}

interface ParsedReview {
  you: { limit: string[]; grow: string[]; keep: string[] };
  me:  { limit: string[]; grow: string[]; keep: string[] };
  search: SearchBlock;
  closing: string; // raw inside <结语> tag
}

function parseReview(text: string): ParsedReview {
  return {
    you: {
      limit: parseBulletList(extractTag(text, '你-局限')),
      grow:  parseBulletList(extractTag(text, '你-发扬')),
      keep:  parseBulletList(extractTag(text, '你-保持')),
    },
    me: {
      limit: parseBulletList(extractTag(text, '我-局限')),
      grow:  parseBulletList(extractTag(text, '我-发扬')),
      keep:  parseBulletList(extractTag(text, '我-保持')),
    },
    search: parseSearchBlock(text),
    closing: extractTag(text, '结语'),
  };
}

const CARD_LABELS = {
  you: { limit: '你的局限', grow: '你可以发扬的', keep: '你已经在保持的' },
  me:  { limit: '我的局限', grow: '我可以发扬的', keep: '我要继续守住的' },
} as const;

// ── Conversation creation ────────────────────────────────────────────────────

export function createReviewConversation(params: {
  botId: string;
  userId: string;
  sourceMessageConvId: string | null;
  title?: string | null;
}): string {
  const id = randomUUID();
  const title = params.title?.trim() || (params.sourceMessageConvId ? '回顾' : '自由回顾');
  createConversation(id, params.botId, params.userId, title, 'review');
  createReviewRun({
    conversationId: id,
    sourceMessageConvId: params.sourceMessageConvId,
  });
  return id;
}

// ── Run ──────────────────────────────────────────────────────────────────────

export interface RunReviewParams {
  reviewConvId: string;
  sourceConvId?: string | null;
  replyFn: (msg: OutboundMessage) => void;
  trigger?: 'auto' | 'user' | 'panel';
}

export async function runReview(params: RunReviewParams): Promise<void> {
  const { reviewConvId, sourceConvId, replyFn, trigger = 'user' } = params;
  setReviewRunStatus(reviewConvId, 'running');

  try {
    const reviewConv = findConversationById(reviewConvId);
    if (!reviewConv) {
      setReviewRunStatus(reviewConvId, 'error');
      return;
    }
    const run = getReviewRun(reviewConvId);
    if (!run) {
      setReviewRunStatus(reviewConvId, 'error');
      return;
    }

    const effectiveSourceId = sourceConvId ?? run.source_message_conv_id;
    const sourceConv = effectiveSourceId ? findConversationById(effectiveSourceId) : null;

    // Step 1 — gather chat history
    emitStep(reviewConvId, 'history', '翻一翻最近的对话', 'running');
    const historyConvId = effectiveSourceId ?? reviewConvId;
    const history = getMessages(historyConvId, 30).filter(m => m.sender_type !== 'log');
    if (history.length < 2) {
      emitStep(reviewConvId, 'history', '翻一翻最近的对话', 'error', '聊得还不够，下次再回头看');
      setReviewRunStatus(reviewConvId, 'done');
      reviewEvents.emit('done', {
        reviewConvId, conversationId: reviewConvId,
        sourceMessageConvId: effectiveSourceId,
        result: 'insufficient', timestamp: Date.now(),
      });
      return;
    }
    emitStep(
      reviewConvId, 'history', '翻一翻最近的对话', 'done',
      `${history.length} 条消息${sourceConv ? `（来自「${sourceConv.title?.trim() || sourceConv.id.slice(0, 8)}」）` : ''}`,
    );

    // Step 2 — load long-term memory (user profile + bot's own past reflections)
    emitStep(reviewConvId, 'memory', '翻一翻你的画像和我以前的心得', 'running');
    let profileText = '';
    try {
      const profile = await getUserProfile(reviewConv.user_id);
      if (profile.card.length > 0 || profile.representation) {
        profileText = `用户画像：\n${profile.card.join('\n')}${profile.representation ? '\n' + profile.representation : ''}`;
      }
    } catch (e: any) {
      console.warn('[review] profile load failed:', e?.message ?? e);
    }
    const priorReflections = getRecentBotReflections(reviewConv.bot_id, reviewConv.user_id, 12);
    let priorText = '';
    if (priorReflections.length > 0) {
      const groupedByKind = {
        limit: priorReflections.filter(r => r.kind === 'limit'),
        grow:  priorReflections.filter(r => r.kind === 'grow'),
        keep:  priorReflections.filter(r => r.kind === 'keep'),
      };
      const lines: string[] = ['我（这个机器人）以前回顾时记下的心得：'];
      if (groupedByKind.limit.length > 0) lines.push('— 我的局限：', ...groupedByKind.limit.map(r => `  · ${r.content}`));
      if (groupedByKind.grow.length > 0)  lines.push('— 我要发扬的：', ...groupedByKind.grow.map(r => `  · ${r.content}`));
      if (groupedByKind.keep.length > 0)  lines.push('— 我要守住的：', ...groupedByKind.keep.map(r => `  · ${r.content}`));
      priorText = lines.join('\n');
    }
    emitStep(
      reviewConvId, 'memory', '翻一翻你的画像和我以前的心得', 'done',
      [
        profileText ? `画像 ✓` : `画像 — 还没攒起来`,
        priorReflections.length > 0 ? `我的旧心得 ${priorReflections.length} 条` : '我的旧心得 — 还没有',
      ].join(' · '),
    );

    // Step 3 — call the LLM
    const reviewPrompt = await configManager.readPrompt('review.md');
    // Review is "人的分析" — pulls models.humanAnalysis at run time so a
    // re-run picks up whichever model is currently configured for the
    // category (no per-run frozen value).
    const model = modelForTask('humanAnalysis');
    emitStep(reviewConvId, 'thinking', '慢慢想一遍', 'running', `用 ${model}`);

    const historyMessages = history.map((m: any) => ({
      role: (m.sender_type === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content as string,
    }));

    const leadInParts: string[] = [];
    if (profileText) leadInParts.push(profileText);
    if (priorText) leadInParts.push(priorText);
    leadInParts.push('（以下是最近的对话历史）');
    const leadIn = leadInParts.join('\n\n');

    const messages = [
      { role: 'system' as const, content: reviewPrompt },
      { role: 'user' as const, content: leadIn },
      ...historyMessages,
      { role: 'user' as const, content: '请按系统指令对你和对方两边都做一遍回顾，按要求的分段输出。' },
    ];

    const { result, latencyMs, costUsd } = await chatCompletion({ model, messages });

    logAudit({
      userId: reviewConv.user_id,
      conversationId: reviewConvId, taskType: 'review', model,
      inputTokens: result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.completion_tokens ?? 0,
      totalTokens: result.usage?.total_tokens ?? 0,
      costUsd, generationId: result.id, latencyMs,
    });

    const rawText = result.choices[0]?.message?.content?.trim() ?? '';
    emitStep(
      reviewConvId, 'thinking', '慢慢想一遍', 'done',
      `${(latencyMs / 1000).toFixed(1)}s · ${result.usage?.total_tokens ?? 0} tokens`,
    );

    let parsed = parseReview(rawText);

    // Optional search round — re-issue the prompt with findings to refine.
    if (parsed.search.need && parsed.search.queries.length > 0) {
      emitStep(
        reviewConvId, 'search', '查证几件事', 'running',
        parsed.search.queries.map((q, i) => `${i + 1}. ${q}`).join(' · '),
      );
      const botConfig = configManager.getBotConfig(reviewConv.bot_id);
      const { findings } = await runSearchLoop({
        userId: reviewConv.user_id,
        conversationId: reviewConvId,
        model,
        queries: parsed.search.queries,
        budget: botConfig.review.maxSearchRequests,
        evalPromptName: 'review-eval.md',
        taskType: 'review_eval',
        emitLog: () => { /* swallowed; the inner search loop is verbose */ },
      });

      const findingsText = findings.length > 0
        ? findings.map(f => `- ${f.content}${f.source ? ` (来源: ${f.source})` : ''}`).join('\n')
        : '（未找到有价值的信息）';

      const finalMessages = [
        { role: 'system' as const, content: reviewPrompt },
        { role: 'user' as const, content: leadIn },
        ...historyMessages,
        { role: 'assistant' as const, content: rawText },
        {
          role: 'user' as const,
          content: [
            '以下是你刚才要求的搜索结果：',
            findingsText,
            '',
            '现在请重新输出完整的 7 段（你-局限/发扬/保持、我-局限/发扬/保持、搜索 need=false、结语），把搜到的内容自然地融到相关段里。',
          ].join('\n'),
        },
      ];

      const { result: finalResult, latencyMs: finalLatency, costUsd: finalCost } = await chatCompletion({
        model, messages: finalMessages,
      });

      logAudit({
        userId: reviewConv.user_id,
        conversationId: reviewConvId, taskType: 'review', model,
        inputTokens: finalResult.usage?.prompt_tokens ?? 0,
        outputTokens: finalResult.usage?.completion_tokens ?? 0,
        totalTokens: finalResult.usage?.total_tokens ?? 0,
        costUsd: finalCost, generationId: finalResult.id, latencyMs: finalLatency,
      });

      const finalText = finalResult.choices[0]?.message?.content?.trim() ?? '';
      emitStep(
        reviewConvId, 'search', '查证几件事', 'done',
        `${findings.length} 条发现`,
      );
      parsed = parseReview(finalText);
    }

    // Cards — emit in fixed order (you side first, then me side).
    const order: Array<{ side: 'you' | 'me'; bucket: 'limit' | 'grow' | 'keep' }> = [
      { side: 'you', bucket: 'limit' },
      { side: 'you', bucket: 'grow' },
      { side: 'you', bucket: 'keep' },
      { side: 'me',  bucket: 'limit' },
      { side: 'me',  bucket: 'grow' },
      { side: 'me',  bucket: 'keep' },
    ];
    for (const o of order) {
      const items = parsed[o.side][o.bucket];
      emitCard(reviewConvId, o.side, o.bucket, items, CARD_LABELS[o.side][o.bucket]);
    }

    // Persist the bot's own self-knowledge so it accumulates across reviews.
    emitStep(reviewConvId, 'save', '把这次的自己记下来', 'running');
    let savedCount = 0;
    for (const bucket of ['limit', 'grow', 'keep'] as const) {
      for (const item of parsed.me[bucket]) {
        try {
          insertBotReflection({
            id: randomUUID(),
            botId: reviewConv.bot_id,
            userId: reviewConv.user_id,
            reviewConvId,
            kind: bucket,
            content: item,
          });
          savedCount++;
        } catch (e) {
          console.warn('[review] save reflection failed:', e);
        }
      }
    }
    emitStep(reviewConvId, 'save', '把这次的自己记下来', 'done', `${savedCount} 条心得已存`);

    // Closing line.
    const closingRaw = parsed.closing.trim();
    const isPass = !closingRaw || closingRaw === '[PASS]' || closingRaw === '[OK]' || closingRaw === '[PENDING]';
    if (isPass) {
      emitClosing(reviewConvId, 'pass', '');
    } else {
      emitClosing(reviewConvId, 'note', closingRaw);

      // Also store the closing as a real bot bubble in the review tab so it's
      // visible alongside the cards (and so a follow-up dialogue has it in
      // history).
      insertMessage(randomUUID(), reviewConvId, 'bot', reviewConv.bot_id, closingRaw);

      // If we're tied to a source message conv, schedule the closing line to
      // be delivered there too — the original "auto-correction" affordance.
      if (sourceConv) {
        const botConfig = configManager.getBotConfig(reviewConv.bot_id);
        const timer = setTimeout(() => {
          pendingTimers.delete(reviewConvId);
          const msgId = randomUUID();
          insertMessage(msgId, sourceConv.id, 'bot', reviewConv.bot_id, closingRaw);
          recordBotMessage({ botId: reviewConv.bot_id, conversationId: sourceConv.id, content: closingRaw });
          replyFn({
            type: 'message',
            conversationId: sourceConv.id,
            messageId: msgId,
            content: closingRaw,
          });
        }, botConfig.review.timerMs);
        pendingTimers.set(reviewConvId, timer);
      }
    }

    setReviewRunStatus(reviewConvId, 'done');
    reviewEvents.emit('done', {
      reviewConvId, conversationId: reviewConvId,
      sourceMessageConvId: effectiveSourceId,
      result: isPass ? 'noted' : 'with_closing',
      timestamp: Date.now(),
      trigger,
    });
  } catch (e: any) {
    emit(reviewConvId, `⚠️ 出错：${e?.message ?? e}`, 'error');
    setReviewRunStatus(reviewConvId, 'error');
    reviewEvents.emit('done', {
      reviewConvId, conversationId: reviewConvId,
      sourceMessageConvId: null,
      result: 'error', timestamp: Date.now(),
    });
    throw e;
  } finally {
    for (const [msgConv, rConv] of reviewsByMessageConv) {
      if (rConv === reviewConvId) reviewsByMessageConv.delete(msgConv);
    }
  }
}

// ── Auto / manual trigger from message conv ──────────────────────────────────

export async function checkAndTriggerReview(
  messageConvId: string,
  botId: string,
  replyFn: (msg: OutboundMessage) => void,
  manual = false,
): Promise<void> {
  const conv = findConversationById(messageConvId);
  if (!conv) return;

  const botConfig = configManager.getBotConfig(botId);
  if (!botConfig.review.enabled) return;

  if (!manual) {
    if (conv.round_count === 0) return;
    if (conv.round_count % botConfig.review.roundInterval !== 0) return;
  }

  if (reviewsByMessageConv.has(messageConvId)) {
    console.log(`[review] already running for message conv ${messageConvId}`);
    return;
  }

  const reviewConvId = createReviewConversation({
    botId,
    userId: conv.user_id,
    sourceMessageConvId: messageConvId,
    title: manual ? '回顾' : '自动回顾',
  });
  reviewsByMessageConv.set(messageConvId, reviewConvId);

  await runReview({
    reviewConvId,
    sourceConvId: messageConvId,
    replyFn,
    trigger: manual ? 'user' : 'auto',
  }).catch(e => console.error('[review] error:', e));
}

export function cancelPendingReview(messageConvId: string): void {
  const reviewConvId = reviewsByMessageConv.get(messageConvId);
  if (!reviewConvId) return;
  const timer = pendingTimers.get(reviewConvId);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(reviewConvId);
    setReviewRunStatus(reviewConvId, 'done');
    reviewsByMessageConv.delete(messageConvId);
  }
}

export function getPendingReviews(): string[] {
  return Array.from(pendingTimers.keys());
}

// ── Follow-up dialogue ──────────────────────────────────────────────────────

export interface ContinueReviewParams {
  reviewConvId: string;
  userText: string;
}

export async function continueReview(params: ContinueReviewParams): Promise<void> {
  const { reviewConvId, userText } = params;
  const reviewConv = findConversationById(reviewConvId);
  if (!reviewConv) return;
  const run = getReviewRun(reviewConvId);
  if (!run) return;

  if (run.source_message_conv_id) {
    cancelPendingReview(run.source_message_conv_id);
  }

  emit(reviewConvId, '用户跟进，准备回应…', 'followup_started');

  try {
    const followupPrompt = await configManager.readPrompt('review-followup.md');
    const model = modelForTask('humanAnalysis');

    let sourceContext = '（无源会话上下文 — 自由回顾）';
    if (run.source_message_conv_id) {
      const srcMsgs = getMessages(run.source_message_conv_id, 30)
        .filter(m => m.sender_type !== 'log');
      if (srcMsgs.length > 0) {
        sourceContext = srcMsgs.map((m: any) =>
          `${m.sender_type === 'user' ? '用户' : 'bot'}：${m.content}`
        ).join('\n');
      }
    }

    let profileText = '';
    try {
      const profile = await getUserProfile(reviewConv.user_id);
      if (profile.card.length > 0 || profile.representation) {
        profileText = `用户画像：\n${profile.card.join('\n')}${profile.representation ? '\n' + profile.representation : ''}`;
      }
    } catch (e: any) {
      console.warn('[review] followup profile load failed:', e?.message ?? e);
    }

    const dialogueRows = getMessages(reviewConvId, 200)
      .filter((m: any) => m.sender_type === 'user' || m.sender_type === 'bot');

    const dialogueMessages = dialogueRows.map((m: any) => ({
      role: (m.sender_type === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content as string,
    }));

    const contextBlock = [
      profileText,
      profileText ? '' : null,
      '─── 被回顾的那段对话 ───',
      sourceContext,
      '',
      '（接下来是你和用户在回顾里的来回。用户最新那条在最后，请回应它。）',
    ].filter(x => x !== null).join('\n');

    const messages = [
      { role: 'system' as const, content: followupPrompt },
      { role: 'user' as const, content: contextBlock },
      ...dialogueMessages,
      { role: 'user' as const, content: userText },
    ];

    const { result, latencyMs, costUsd } = await chatCompletion({ model, messages });

    logAudit({
      userId: reviewConv.user_id,
      conversationId: reviewConvId, taskType: 'review_followup', model,
      inputTokens: result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.completion_tokens ?? 0,
      totalTokens: result.usage?.total_tokens ?? 0,
      costUsd, generationId: result.id, latencyMs,
    });

    const replyText = result.choices[0]?.message?.content?.trim() ?? '';

    if (!replyText) {
      emit(reviewConvId, '⚠️ 模型没给出回应', 'error');
      reviewEvents.emit('done', {
        reviewConvId, conversationId: reviewConvId,
        sourceMessageConvId: run.source_message_conv_id,
        result: 'followup_empty', timestamp: Date.now(),
      });
      return;
    }

    insertMessage(randomUUID(), reviewConvId, 'bot', reviewConv.bot_id, replyText);
    reviewEvents.emit('done', {
      reviewConvId, conversationId: reviewConvId,
      sourceMessageConvId: run.source_message_conv_id,
      result: 'followup', timestamp: Date.now(),
    });
  } catch (e: any) {
    emit(reviewConvId, `⚠️ 跟进出错：${e?.message ?? e}`, 'error');
    reviewEvents.emit('done', {
      reviewConvId, conversationId: reviewConvId,
      sourceMessageConvId: run.source_message_conv_id ?? null,
      result: 'error', timestamp: Date.now(),
    });
  }
}
