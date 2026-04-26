// Digger — replaces the old wanderer.
//
// Knows the audience and the target vector. Iterates search→read→note,
// inline-filters against known_profile (so the synthesizer can be slim),
// and stops when budget exhausted or it's been told to stop.
//
// Mode-specific strategy is mixed into the system prompt by reading one of
// the surfing-mode-*.md files and substituting placeholders. The tool list
// is shared across modes — only the prompt differs.

import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { configManager } from '../../config/loader';
import { chatCompletion } from '../../llm/client';
import { logAudit } from '../../llm/audit';
import { mcpManager } from '../../mcp/manager';
import type { DiggingVector, PickerKnownProfile } from './vector-picker';

export type DiggerNovelty = 'novel' | 'depth_extension';

export interface DiggerFinding {
  title: string;
  summary: string;
  url?: string;
  serves_vector_how: string;
  novelty: DiggerNovelty;
}

export interface DiggerInput {
  userId: string;
  conversationId: string;          // surf conv id (for audit + log)
  model: string;
  vector: DiggingVector;
  knownProfile: PickerKnownProfile;
  budget: number;                  // search_web + read_url ceiling
  emitLog: (content: string) => void;
  signal?: AbortSignal;
}

export interface DiggerResult {
  vector: DiggingVector;
  findings: DiggerFinding[];
  toolCallsUsed: number;
  turns: number;
}

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

const TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: '搜索互联网。query 必须围绕当前 vector，不要漫游。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索查询' },
          reason: { type: 'string', description: '这次搜的是当前 vector 的哪一面，一句话' },
        },
        required: ['query', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_url',
      description: '抓原文。摘要不够就进去读。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['url', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'note_finding',
      description: '记下一条 finding。redundant_known 的不要 note。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '简短标题' },
          summary: { type: 'string', description: '是什么，2-3 句' },
          url: { type: 'string', description: '可选：来源 URL' },
          serves_vector_how: { type: 'string', description: '它怎么服务于当前 vector，一句话；不准写"和主题相关"' },
          novelty: {
            type: 'string',
            enum: ['novel', 'depth_extension'],
            description: '相对 known_profile 的关系',
          },
        },
        required: ['title', 'summary', 'serves_vector_how', 'novelty'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: '结束挖掘。攒够了或预算快用完时调用。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '一句话说明为什么收尾' },
        },
        required: ['reason'],
      },
    },
  },
];

async function loadModeStrategy(vector: DiggingVector): Promise<string> {
  const file =
    vector.mode === 'depth' ? 'surfing-mode-depth.md' :
    vector.mode === 'granular' ? 'surfing-mode-granular.md' :
    'surfing-mode-fresh.md';
  let body = await configManager.readPrompt(file);
  body = body.replaceAll('{topic}', vector.topic);
  body = body.replaceAll('{freshness_window}', vector.freshness_window || 'past 90 days');
  return body;
}

function formatKnownProfile(kp: PickerKnownProfile): string {
  const parts: string[] = ['## known_profile（用户已知，novelty=redundant_known 的丢掉）'];
  parts.push(`- topics_covered: ${kp.topics_covered.join('、') || '(空)'}`);
  parts.push(`- concepts_known: ${kp.concepts_known.join('、') || '(空)'}`);
  parts.push(`- open_questions: ${kp.open_questions.join('、') || '(空)'}`);
  return parts.join('\n');
}

function formatVector(v: DiggingVector): string {
  const parts: string[] = ['## 本次向量'];
  parts.push(`- topic: ${v.topic}`);
  parts.push(`- mode: ${v.mode}`);
  parts.push(`- why_now: ${v.why_now || '(空)'}`);
  if (v.freshness_window) parts.push(`- freshness_window: ${v.freshness_window}`);
  return parts.join('\n');
}

export async function runDigger(input: DiggerInput): Promise<DiggerResult> {
  const { userId, conversationId, model, vector, knownProfile, budget, emitLog, signal } = input;

  const baseSystem = await configManager.readPrompt('surfing-digger.md');
  const modeStrategy = await loadModeStrategy(vector);
  const systemPrompt = baseSystem.replace('{{MODE_STRATEGY}}', modeStrategy);

  const userKickoff = [
    formatVector(vector),
    '',
    formatKnownProfile(knownProfile),
    '',
    `预算：${budget} 次 search_web + read_url（note_finding / done 不占）。开始挖掘。`,
  ].join('\n');

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userKickoff },
  ];

  const findings: DiggerFinding[] = [];
  let toolCallsUsed = 0;
  let turns = 0;
  const maxTurns = budget + 8;
  const tag = `[digger:${vector.mode}]`;

  while (turns < maxTurns) {
    checkAborted(signal);
    turns++;

    emitLog(`${tag} 第 ${turns} 轮 (用 ${toolCallsUsed}/${budget}, findings=${findings.length})`);

    const { result, latencyMs, costUsd } = await chatCompletion({
      model, messages,
      tools: TOOLS,
      tool_choice: 'auto',
    });

    logAudit({
      userId, conversationId, taskType: 'surfing', model,
      inputTokens: result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.completion_tokens ?? 0,
      totalTokens: result.usage?.total_tokens ?? 0,
      costUsd, generationId: result.id, latencyMs,
    });

    const msg = result.choices[0]?.message;
    if (!msg) {
      emitLog(`${tag} ⚠️ 空 message`);
      break;
    }

    messages.push(msg as ChatCompletionMessageParam);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      emitLog(`${tag} ⚠️ 未调用工具，提示继续`);
      messages.push({
        role: 'user',
        content: toolCallsUsed >= budget
          ? '搜索/阅读预算已用完。如果还有想记的，用 note_finding；否则 done。'
          : '请通过工具调用继续。如果觉得够了就 done。',
      });
      continue;
    }

    let doneSeen = false;

    for (const tc of toolCalls) {
      if (tc.type !== 'function') continue;
      const fnName = tc.function.name;
      const args = safeJsonParse(tc.function.arguments) ?? {};

      if (fnName === 'done') {
        doneSeen = true;
        const reason = typeof args.reason === 'string' ? args.reason : '';
        emitLog(`${tag} ✋ done: ${reason}`);
        messages.push({
          role: 'tool', tool_call_id: tc.id,
          content: 'done acknowledged',
        });
        continue;
      }

      if (fnName === 'note_finding') {
        const title = typeof args.title === 'string' ? args.title.trim() : '';
        const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
        const url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : undefined;
        const serves = typeof args.serves_vector_how === 'string' ? args.serves_vector_how.trim() : '';
        const novelty = args.novelty === 'depth_extension' ? 'depth_extension' as const : 'novel' as const;
        if (!title || !summary || !serves) {
          messages.push({
            role: 'tool', tool_call_id: tc.id,
            content: '参数缺失：title / summary / serves_vector_how 必填',
          });
          continue;
        }
        findings.push({ title, summary, url, serves_vector_how: serves, novelty });
        emitLog(`${tag} 📌 [${novelty}] ${title}${url ? ` (${url})` : ''} — ${serves}`);
        messages.push({
          role: 'tool', tool_call_id: tc.id,
          content: `finding #${findings.length} recorded`,
        });
        continue;
      }

      if (toolCallsUsed >= budget) {
        messages.push({
          role: 'tool', tool_call_id: tc.id,
          content: '搜索/阅读预算已用完。如果还有想记的，用 note_finding；否则 done。',
        });
        continue;
      }

      let toolResult: string;
      try {
        if (fnName === 'search_web') {
          const query = typeof args.query === 'string' ? args.query : '';
          const reason = typeof args.reason === 'string' ? args.reason : '';
          if (!query) {
            toolResult = '参数缺失：query 为空';
          } else {
            emitLog(`${tag} 🔍 ${query}${reason ? ` — ${reason}` : ''}`);
            toolResult = await mcpManager.searchWeb(query);
            emitLog(`${tag}   ↳ ${toolResult.length} 字`);
          }
        } else if (fnName === 'read_url') {
          const url = typeof args.url === 'string' ? args.url : '';
          const reason = typeof args.reason === 'string' ? args.reason : '';
          if (!url) {
            toolResult = '参数缺失：url 为空';
          } else {
            emitLog(`${tag} 📖 ${url}${reason ? ` — ${reason}` : ''}`);
            toolResult = await mcpManager.readUrl(url);
            emitLog(`${tag}   ↳ ${toolResult.length} 字`);
          }
        } else {
          toolResult = `未知工具：${fnName}`;
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        toolResult = `工具执行失败：${e?.message ?? e}`;
        emitLog(`${tag} ⚠️ ${fnName} 失败：${e?.message ?? e}`);
      }

      toolCallsUsed++;
      messages.push({
        role: 'tool', tool_call_id: tc.id,
        content: toolResult,
      });

      checkAborted(signal);
    }

    if (doneSeen) {
      return { vector, findings, toolCallsUsed, turns };
    }
  }

  emitLog(`${tag} ⚠️ 达到最大轮数 ${maxTurns}，自动收尾`);
  return { vector, findings, toolCallsUsed, turns };
}
