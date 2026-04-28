import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { configManager } from '../../config/loader';
import { chatCompletion } from '../../llm/client';
import { logAudit } from '../../llm/audit';
import { mcpManager } from '../../mcp/manager';
import {
  getMessages, listConversationsByUser, listAiPicks,
  addSurfRunCost,
} from '../../db/queries';
import { getUserProfile } from '../../honcho/memory';
import { modelForTask } from '../models';
import { writeJournalEntry, buildJournalPromptBlock } from './journal';

// --- Tool surface ---
//
// search_web / read_url are real I/O via Jina MCP. note records into an
// in-memory notebook the agent can re-read in its own message history.
// finish ends the loop; satisfied flags whether the run produced anything
// worth surfacing to the user — the caller skips delivery on satisfied=false.

const TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: '互联网搜索，返回结果摘要。中英文均可。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索查询' },
          reason: { type: 'string', description: '一句话：为什么搜这个' },
        },
        required: ['query', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_url',
      description: '抓某个网页正文。返回的是另一个模型按你的 reason 压缩过的摘要，不是原文。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要读的 URL' },
          reason: { type: 'string', description: '一句话：为什么读、想从里面看到什么' },
        },
        required: ['url', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'note',
      description: '把刚发现的有意思的东西立刻记下来。不要攒到最后——会忘。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '简短标题' },
          summary: { type: 'string', description: '这是什么，30-100 字' },
          url: { type: 'string', description: '可选：来源 URL' },
          why: { type: 'string', description: '为什么对这个用户可能眼前一亮' },
        },
        required: ['title', 'summary', 'why'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: '结束本次冲浪。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '一句话：为什么收尾' },
          satisfied: {
            type: 'boolean',
            description: '本次是否攒到了值得分享给用户的东西。false 表示空手而归 / 不该硬推。',
          },
        },
        required: ['reason', 'satisfied'],
      },
    },
  },
];

export interface Note {
  title: string;
  summary: string;
  url?: string;
  why: string;
}

export interface SurfAgentInput {
  surfConvId: string;
  sourceConvId: string | null;
  botId: string;
  userId: string;
  costBudgetUsd: number;
  emit: (content: string, type?: string) => void;
  signal?: AbortSignal;
}

export interface SurfAgentResult {
  // The message we want delivered to the user (already polished). Empty when
  // the agent finished with satisfied=false and we shouldn't push anything.
  finalMessage: string;
  notes: Note[];
  satisfied: boolean;
  finishReason: string;
  costUsedUsd: number;
  turns: number;
}

const HISTORY_LIMIT = 80;
const CROSS_CONV_LIMIT = 12;
const AI_PICKS_LIMIT = 25;
const JOURNAL_PEEK = 8;
const MAX_TURNS = 60;       // hard ceiling regardless of budget — defends against tool-call ping-pong
const STATUS_WARN = 0.7;    // soft "start wrapping up" hint
const STATUS_FORCE = 0.95;  // hard "finish next turn" instruction

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
}

function safeJsonParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

function fmtRelative(tsSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - tsSec;
  if (diff < 86400) return '今天';
  if (diff < 2 * 86400) return '昨天';
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}天前`;
  if (diff < 30 * 86400) return `${Math.floor(diff / (7 * 86400))}周前`;
  return `${Math.floor(diff / (30 * 86400))}月前`;
}

// --- Phase 1: load every piece of context the userlens & agent need ---

async function loadContext(input: {
  botId: string; userId: string; sourceConvId: string | null;
  emit: SurfAgentInput['emit'];
}) {
  const { botId, userId, sourceConvId, emit } = input;

  // Long-term Honcho profile
  let profileBlock = '';
  try {
    const profile = await getUserProfile(userId);
    if (profile.card.length > 0 || profile.representation) {
      profileBlock = ['## 长期画像', profile.card.join('\n'), profile.representation].filter(Boolean).join('\n');
    }
  } catch (e: any) {
    console.warn('[surf-agent] profile load failed:', e?.message ?? e);
  }

  // Recent ai_picks — strongest taste signal
  const picks = listAiPicks(userId).slice(0, AI_PICKS_LIMIT);
  const picksBlock = picks.length === 0 ? '' : [
    '## 用户保存过的文章 (ai_picks)',
    ...picks.map(p => `- "${p.title}"${p.url ? ` (${p.url})` : ''}${p.summary ? ` — ${p.summary.slice(0, 100)}` : ''}`),
  ].join('\n');

  // Source conversation history
  let historyBlock = '';
  if (sourceConvId) {
    const msgs = getMessages(sourceConvId, HISTORY_LIMIT);
    if (msgs.length > 0) {
      const lines = msgs.map(m => {
        const who = m.sender_type === 'user' ? '用户' : 'bot';
        return `${who}: ${m.content.slice(0, 400)}`;
      }).join('\n');
      historyBlock = `## 当前会话最近 ${msgs.length} 条对话\n${lines}`;
    }
  }

  // Cross-conversation snapshot (titles only — gives breadth without bloat)
  const others = listConversationsByUser(userId, 'message')
    .filter((c: any) => c.bot_id === botId && c.id !== sourceConvId)
    .slice(0, CROSS_CONV_LIMIT);
  const crossBlock = others.length === 0 ? '' : [
    '## 该用户在本 bot 下的其它会话',
    ...others.map((c: any) => `- [${fmtRelative(c.last_activity_at)}] ${c.title?.trim() || '(无标题)'}（${c.round_count ?? 0} 轮）`),
  ].join('\n');

  // Bot's own recent journal — so userlens can frame what's already been seen
  const journal = buildJournalPromptBlock(botId, userId, JOURNAL_PEEK);
  const journalBlock = journal.entries.length === 0 ? '' : [
    `## 你（bot）最近 ${journal.entries.length} 篇冲浪日记`,
    ...journal.entries.map(e => `- [${fmtRelative(e.created_at)}] ${e.content}`),
  ].join('\n');

  emit(`上下文：profile=${profileBlock ? '有' : '无'} picks=${picks.length} 历史=${sourceConvId ? '有' : '无'} 跨会话=${others.length} 日记=${journal.entries.length}`);

  return { profileBlock, picksBlock, historyBlock, crossBlock, journalBlock };
}

// --- Phase 2: userlens (Opus reads the user) ---

async function runUserlens(params: {
  ctx: Awaited<ReturnType<typeof loadContext>>;
  userId: string;
  surfConvId: string;
  emit: SurfAgentInput['emit'];
  onCost: (usd: number) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { ctx, userId, surfConvId, emit, onCost, signal } = params;
  const prompt = await configManager.readPrompt('surfing-userlens.md');
  const model = modelForTask('humanAnalysis');

  const userMsg = [
    ctx.profileBlock, ctx.picksBlock, ctx.historyBlock, ctx.crossBlock, ctx.journalBlock,
  ].filter(Boolean).join('\n\n') || '(没有任何资料)';

  emit(`[userlens] ${model}…`);
  checkAborted(signal);

  const { result, latencyMs, costUsd } = await chatCompletion({
    model,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: userMsg },
    ],
  });
  if (costUsd) onCost(costUsd);

  logAudit({
    userId, conversationId: surfConvId, taskType: 'surfing', model,
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
    totalTokens: result.usage?.total_tokens ?? 0,
    costUsd, generationId: result.id, latencyMs,
  });

  const out = result.choices[0]?.message?.content?.trim() ?? '';
  emit(`[userlens] 完成 (${latencyMs}ms, $${(costUsd ?? 0).toFixed(4)})`);
  return out;
}

// --- Phase 3 helper: skim a long page down via the cheap model ---

async function runSkim(params: {
  raw: string;
  reason: string;
  userId: string;
  surfConvId: string;
  onCost: (usd: number) => void;
}): Promise<string> {
  const { raw, reason, userId, surfConvId, onCost } = params;
  if (!raw.trim()) return '(网页内容为空)';
  // Skip skim entirely for short pages — adds cost without value.
  if (raw.length < 800) return raw;

  const prompt = await configManager.readPrompt('surfing-skim.md');
  const model = modelForTask('skim');

  const { result, latencyMs, costUsd } = await chatCompletion({
    model,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: `## 读它的理由\n${reason}\n\n## 网页原文\n${raw}` },
    ],
  });
  if (costUsd) onCost(costUsd);

  logAudit({
    userId, conversationId: surfConvId, taskType: 'surfing', model,
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
    totalTokens: result.usage?.total_tokens ?? 0,
    costUsd, generationId: result.id, latencyMs,
  });

  return result.choices[0]?.message?.content?.trim() ?? '(摘要为空)';
}

// --- Phase 4: post-loop summary writer (Opus) ---

async function runSummary(params: {
  userlens: string;
  notes: Note[];
  finishReason: string;
  satisfied: boolean;
  userId: string;
  surfConvId: string;
  emit: SurfAgentInput['emit'];
  onCost: (usd: number) => void;
}): Promise<string> {
  const { userlens, notes, finishReason, satisfied, userId, surfConvId, emit, onCost } = params;
  const prompt = await configManager.readPrompt('surfing-summary.md');
  const model = modelForTask('humanAnalysis');

  const noteLines = notes.length === 0
    ? '(没有 note —— 空手而归)'
    : notes.map((n, i) =>
        `${i + 1}. **${n.title}**${n.url ? ` (${n.url})` : ''}\n   ${n.summary}\n   钩到他的点：${n.why}`,
      ).join('\n');

  const userMsg = [
    '## 对该用户的观察',
    userlens || '(空)',
    '',
    '## 我的笔记',
    noteLines,
    '',
    '## 我自己的收尾',
    `${satisfied ? '满意（攒到了想分享的东西）' : '不满意（没什么戏）'}：${finishReason || '(没说)'}`,
  ].join('\n');

  emit(`[summary] ${model}…`);
  const { result, latencyMs, costUsd } = await chatCompletion({
    model,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: userMsg },
    ],
  });
  if (costUsd) onCost(costUsd);

  logAudit({
    userId, conversationId: surfConvId, taskType: 'surfing', model,
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
    totalTokens: result.usage?.total_tokens ?? 0,
    costUsd, generationId: result.id, latencyMs,
  });

  emit(`[summary] 完成 (${latencyMs}ms, $${(costUsd ?? 0).toFixed(4)})`);
  return result.choices[0]?.message?.content?.trim() ?? '';
}

// --- Main entry ---

export async function runSurfAgent(input: SurfAgentInput): Promise<SurfAgentResult> {
  const { surfConvId, sourceConvId, botId, userId, costBudgetUsd, emit, signal } = input;

  let costUsedUsd = 0;
  const onCost = (usd: number) => {
    if (!Number.isFinite(usd) || usd <= 0) return;
    costUsedUsd += usd;
    addSurfRunCost(surfConvId, usd);
  };

  // 1. Load all surrounding context
  const ctx = await loadContext({ botId, userId, sourceConvId, emit });
  checkAborted(signal);

  // 2. Userlens — 人的分析
  const userlens = await runUserlens({
    ctx, userId, surfConvId, emit, onCost, signal,
  });

  // 3. Agentic loop — 决策
  const agentPrompt = await configManager.readPrompt('surfing-agent.md');
  const agentModel = modelForTask('agentDecision');

  const initialContext = [
    '## 对这个人的观察（你的搭档刚写的）',
    userlens,
    '',
    ctx.journalBlock,
    ctx.picksBlock,
    ctx.crossBlock,
    ctx.historyBlock,
  ].filter(Boolean).join('\n\n');

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: agentPrompt },
    { role: 'user', content: initialContext },
    { role: 'user', content: `开始冲浪。预算 $${costBudgetUsd.toFixed(2)}。` },
  ];

  const notes: Note[] = [];
  let satisfied = false;
  let finishReason = '';
  let turn = 0;
  let forcedFinish = false;

  emit(`[agent] ${agentModel} 开始 loop（预算 $${costBudgetUsd.toFixed(2)}）`);

  while (turn < MAX_TURNS) {
    turn++;
    checkAborted(signal);

    const fraction = costUsedUsd / costBudgetUsd;
    const status = `[已花 $${costUsedUsd.toFixed(4)} / $${costBudgetUsd.toFixed(2)} (${(fraction * 100).toFixed(0)}%) | 笔记 ${notes.length} 条 | 第 ${turn} 轮]`;

    if (fraction >= STATUS_FORCE && !forcedFinish) {
      messages.push({
        role: 'user',
        content: `${status}\n\n预算几乎用尽。**这一轮必须调用 finish**——把已有笔记收住，不要再开新搜索/阅读。`,
      });
      forcedFinish = true;
    }

    const { result, latencyMs, costUsd } = await chatCompletion({
      model: agentModel,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
    });
    if (costUsd) onCost(costUsd);

    logAudit({
      userId, conversationId: surfConvId, taskType: 'surfing', model: agentModel,
      inputTokens: result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.completion_tokens ?? 0,
      totalTokens: result.usage?.total_tokens ?? 0,
      costUsd, generationId: result.id, latencyMs,
    });

    const msg = result.choices[0]?.message;
    if (!msg) {
      emit('[agent] ⚠️ 空 message，强行收尾');
      break;
    }
    messages.push(msg as ChatCompletionMessageParam);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // Agent monologued without acting — nudge it
      emit('[agent] (空调用，提示继续)');
      messages.push({
        role: 'user',
        content: `${status}\n\n请通过工具继续——挖、记、或 finish。`,
      });
      continue;
    }

    let doneSeen = false;

    for (const tc of toolCalls) {
      if (tc.type !== 'function') continue;
      const fn = tc.function.name;
      const args = safeJsonParse(tc.function.arguments) ?? {};

      let toolResultContent: string;
      try {
        switch (fn) {
          case 'search_web': {
            const q = String(args.query ?? '').trim();
            const reason = String(args.reason ?? '').trim();
            if (!q) { toolResultContent = '参数缺失：query 为空'; break; }
            emit(`🔍 ${q}${reason ? `  — ${reason}` : ''}`);
            const out = await mcpManager.searchWeb(q);
            emit(`   ↳ ${out.length} 字`);
            toolResultContent = `${status}\n\n${out}`;
            break;
          }
          case 'read_url': {
            const url = String(args.url ?? '').trim();
            const reason = String(args.reason ?? '').trim();
            if (!url) { toolResultContent = '参数缺失：url 为空'; break; }
            emit(`📖 ${url}${reason ? `  — ${reason}` : ''}`);
            const raw = await mcpManager.readUrl(url);
            const skimmed = await runSkim({ raw, reason, userId, surfConvId, onCost });
            emit(`   ↳ ${skimmed.length} 字摘要`);
            toolResultContent = `${status}\n\n${skimmed}`;
            break;
          }
          case 'note': {
            const title = String(args.title ?? '').trim();
            const summary = String(args.summary ?? '').trim();
            const why = String(args.why ?? '').trim();
            const url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : undefined;
            if (!title || !summary || !why) {
              toolResultContent = '参数缺失：title / summary / why 必填';
              break;
            }
            notes.push({ title, summary, url, why });
            emit(`📌 ${title}${url ? ` (${url})` : ''}`);
            toolResultContent = `${status}\n\nnote #${notes.length} 已记。`;
            break;
          }
          case 'finish': {
            satisfied = !!args.satisfied;
            finishReason = String(args.reason ?? '').trim();
            doneSeen = true;
            emit(`✋ finish (satisfied=${satisfied}): ${finishReason}`);
            toolResultContent = 'finished.';
            break;
          }
          default:
            toolResultContent = `未知工具：${fn}`;
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        toolResultContent = `工具执行失败：${e?.message ?? e}`;
        emit(`⚠️ ${fn} 失败：${e?.message ?? e}`);
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolResultContent,
      });
      checkAborted(signal);
    }

    if (doneSeen) break;

    // Soft warning when crossing the warn threshold (once)
    if (fraction >= STATUS_WARN && fraction < STATUS_FORCE && !forcedFinish && notes.length > 0) {
      messages.push({
        role: 'user',
        content: `${status}\n\n预算过半，开始往收口走——除非有明确想再追的钩子，否则准备 finish(satisfied=true)。`,
      });
    }
  }

  if (turn >= MAX_TURNS) {
    emit(`[agent] ⚠️ 达到最大轮数 ${MAX_TURNS}，自动收尾`);
    if (!finishReason) finishReason = `达到轮数上限 ${MAX_TURNS}`;
    if (notes.length > 0) satisfied = true;
  }

  emit(`[agent] 完成：${notes.length} 条 note · ${turn} 轮 · 已花 $${costUsedUsd.toFixed(4)}`);

  // 4. Summary + Journal in parallel (both use humanAnalysis model)
  let finalMessage = '';
  try {
    const [summary] = await Promise.all([
      runSummary({
        userlens, notes, finishReason, satisfied,
        userId, surfConvId, emit, onCost,
      }),
      writeJournalEntry({
        botId, userId, surfConvId, userlens, notes, finishReason, satisfied,
      }).then(j => {
        if (j) emit(`[journal] 已记 (${j.length} 字)`);
      }).catch(e => {
        emit(`[journal] ⚠️ 写日记失败：${e?.message ?? e}`);
      }),
    ]);
    finalMessage = summary;
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    emit(`[summary] ⚠️ 失败：${e?.message ?? e}`);
  }

  return {
    finalMessage,
    notes,
    satisfied,
    finishReason,
    costUsedUsd,
    turns: turn,
  };
}
