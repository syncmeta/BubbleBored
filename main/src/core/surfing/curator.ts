import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { configManager } from '../../config/loader';
import { chatCompletion } from '../../llm/client';
import { logAudit } from '../../llm/audit';
import { mcpManager } from '../../mcp/manager';
import type { PlannerOutput } from './planner';
import type { RawFinding } from './wanderer';

export interface Bridge {
  finding: string;
  user_interest: string;
  connection: string;
}

export interface CuratorInput {
  userId: string;
  conversationId: string;
  model: string;
  plan: PlannerOutput;
  rawFindings: RawFinding[];
  budget: number;                 // max search_web + read_url calls
  emitLog: (content: string) => void;
  signal?: AbortSignal;
}

export interface CuratorResult {
  finalMessage: string;
  bridges: Bridge[];
  novelFindings: string[];
  discardedAsKnown: string[];
  discardedIrrelevant: string[];
  toolCallsUsed: number;
  turns: number;
  didSearchForBlindSpot: boolean;
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
      description: '搜索互联网。主要用于：(a) raw_findings 没覆盖 blind_spots 时补一次；(b) 验证某个 bridge 的真实性。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索查询' },
          reason: { type: 'string', description: '为什么要搜' },
        },
        required: ['query', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_url',
      description: '深入读一个 URL 的原文。',
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
      name: 'finish',
      description: '完成策展，输出最终消息和四类归类。',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: '发给对方的消息，中文口语、自然、无元话语',
          },
          bridges: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                finding: { type: 'string', description: 'raw_finding 的大意或标题' },
                user_interest: { type: 'string', description: '对方哪个兴趣被桥接到' },
                connection: { type: 'string', description: '两者怎么连起来、新视角是什么' },
              },
              required: ['finding', 'user_interest', 'connection'],
            },
            description: '跨域桥接发现——这次任务的核心价值',
          },
          novel_findings: {
            type: 'array',
            items: { type: 'string' },
            description: '直接相关且新的发现',
          },
          discarded_as_known: {
            type: 'array',
            items: { type: 'string' },
            description: '对方画像里已经有的',
          },
          discarded_irrelevant: {
            type: 'array',
            items: { type: 'string' },
            description: '对方不会在意的',
          },
        },
        required: ['message', 'bridges', 'novel_findings'],
      },
    },
  },
];

function formatInput(plan: PlannerOutput, rawFindings: RawFinding[], budget: number): string {
  const kp = plan.known_profile;
  const parts: string[] = [];

  parts.push('## known_profile（对方已接触 / 知道的）');
  parts.push(`- topics_covered: ${kp.topics_covered.join('、') || '(空)'}`);
  parts.push(`- concepts_known: ${kp.concepts_known.join('、') || '(空)'}`);
  parts.push(`- perspectives: ${kp.perspectives.join('、') || '(空)'}`);
  parts.push(`- open_questions: ${kp.open_questions.join('、') || '(空)'}`);
  parts.push(`- interests: ${kp.interests.join('、') || '(空)'}`);
  parts.push('');
  parts.push('## blind_spots（必须覆盖——raw_findings 里没触及的话，search_web 补一次）');
  parts.push(plan.blind_spots || '(空)');
  parts.push('');
  parts.push('## needs');
  parts.push(plan.needs || '(空)');
  parts.push('');
  parts.push(`## raw_findings（wanderer 闲逛带回来的 ${rawFindings.length} 条，完全无受众上下文）`);
  if (rawFindings.length === 0) {
    parts.push('(wanderer 没带回任何东西——完全依赖你对 blind_spots 补搜)');
  } else {
    rawFindings.forEach((f, i) => {
      parts.push(`### ${i + 1}. ${f.title}`);
      if (f.url) parts.push(`- url: ${f.url}`);
      parts.push(`- summary: ${f.summary}`);
      parts.push(`- why_caught_attention: ${f.why_caught_attention}`);
    });
  }
  parts.push('');
  parts.push(`## 你的预算：${budget} 次 search_web / read_url`);
  parts.push('');
  parts.push('开始策展。记住 bridges 是重点——认真想一遍"表面无关但能绕回去"的东西。');

  return parts.join('\n');
}

export async function runCurator(input: CuratorInput): Promise<CuratorResult> {
  const { userId, conversationId, model, plan, rawFindings, budget, emitLog, signal } = input;

  const systemPrompt = await configManager.readPrompt('surfing-curator.md');
  const userInput = formatInput(plan, rawFindings, budget);

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userInput },
  ];

  let toolCallsUsed = 0;
  let turns = 0;
  let didSearchForBlindSpot = false;
  const maxTurns = budget + 4;

  while (turns < maxTurns) {
    checkAborted(signal);
    turns++;

    const budgetExhausted = toolCallsUsed >= budget;
    const toolChoice = budgetExhausted
      ? { type: 'function' as const, function: { name: 'finish' } }
      : 'auto' as const;

    emitLog(`[curator] 第 ${turns} 轮 (已用 ${toolCallsUsed}/${budget})`);

    const { result, latencyMs, costUsd } = await chatCompletion({
      model,
      messages,
      tools: TOOLS,
      tool_choice: toolChoice,
    });

    logAudit({
      userId, conversationId, taskType: 'surfing', model,
      inputTokens: result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.completion_tokens ?? 0,
      totalTokens: result.usage?.total_tokens ?? 0,
      costUsd,
      generationId: result.id,
      latencyMs,
    });

    const msg = result.choices[0]?.message;
    if (!msg) {
      emitLog('[curator] ⚠️ 空 message');
      break;
    }

    messages.push(msg as ChatCompletionMessageParam);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      emitLog('[curator] ⚠️ 未调用工具，提醒 finish');
      messages.push({
        role: 'user',
        content: '请通过工具调用继续。如果准备好了，用 finish 收尾。',
      });
      continue;
    }

    let finishSeen = false;
    let finishResult: CuratorResult | null = null;

    for (const tc of toolCalls) {
      if (tc.type !== 'function') continue;
      const fnName = tc.function.name;
      const args = safeJsonParse(tc.function.arguments) ?? {};

      if (fnName === 'finish') {
        finishSeen = true;
        const finalMessage = typeof args.message === 'string' ? args.message.trim() : '';
        const bridges: Bridge[] = Array.isArray(args.bridges)
          ? args.bridges
              .filter((b: any) => b
                && typeof b.finding === 'string'
                && typeof b.user_interest === 'string'
                && typeof b.connection === 'string')
              .map((b: any) => ({
                finding: b.finding.trim(),
                user_interest: b.user_interest.trim(),
                connection: b.connection.trim(),
              }))
          : [];
        const novelFindings = Array.isArray(args.novel_findings)
          ? args.novel_findings.filter((x: any) => typeof x === 'string' && x.trim())
          : [];
        const discardedAsKnown = Array.isArray(args.discarded_as_known)
          ? args.discarded_as_known.filter((x: any) => typeof x === 'string' && x.trim())
          : [];
        const discardedIrrelevant = Array.isArray(args.discarded_irrelevant)
          ? args.discarded_irrelevant.filter((x: any) => typeof x === 'string' && x.trim())
          : [];
        finishResult = {
          finalMessage,
          bridges,
          novelFindings,
          discardedAsKnown,
          discardedIrrelevant,
          toolCallsUsed,
          turns,
          didSearchForBlindSpot,
        };
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: 'finish acknowledged',
        });
        continue;
      }

      if (toolCallsUsed >= budget) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: '预算已用完，请立刻 finish。',
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
            emitLog(`[curator] 🔍 ${query}${reason ? ` — ${reason}` : ''}`);
            didSearchForBlindSpot = true;
            toolResult = await mcpManager.searchWeb(query);
            emitLog(`[curator]   ↳ ${toolResult.length} 字`);
          }
        } else if (fnName === 'read_url') {
          const url = typeof args.url === 'string' ? args.url : '';
          const reason = typeof args.reason === 'string' ? args.reason : '';
          if (!url) {
            toolResult = '参数缺失：url 为空';
          } else {
            emitLog(`[curator] 📖 ${url}${reason ? ` — ${reason}` : ''}`);
            toolResult = await mcpManager.readUrl(url);
            emitLog(`[curator]   ↳ ${toolResult.length} 字`);
          }
        } else {
          toolResult = `未知工具：${fnName}`;
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        toolResult = `工具执行失败：${e?.message ?? e}`;
        emitLog(`[curator] ⚠️ ${fnName} 失败：${e?.message ?? e}`);
      }

      toolCallsUsed++;
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolResult,
      });

      checkAborted(signal);
    }

    if (finishSeen && finishResult) {
      return finishResult;
    }
  }

  emitLog(`[curator] ⚠️ 达到最大轮数 ${maxTurns}，未 finish`);
  return {
    finalMessage: '',
    bridges: [],
    novelFindings: [],
    discardedAsKnown: [],
    discardedIrrelevant: [],
    toolCallsUsed,
    turns,
    didSearchForBlindSpot,
  };
}
