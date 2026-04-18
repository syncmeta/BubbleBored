import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { configManager } from '../../config/loader';
import { chatCompletion } from '../../llm/client';
import { logAudit } from '../../llm/audit';
import { mcpManager } from '../../mcp/manager';

export interface RawFinding {
  title: string;
  summary: string;
  url?: string;
  why_caught_attention: string;
}

export interface WandererInput {
  conversationId: string;
  model: string;
  budget: number;                 // max search_web + read_url calls (note_finding/done are free)
  emitLog: (content: string) => void;
  signal?: AbortSignal;
}

export interface WandererResult {
  findings: RawFinding[];
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
      description: '在互联网上搜索，返回结果摘要。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索查询，中英文均可' },
          angle: {
            type: 'string',
            enum: ['tech', 'science', 'culture', 'weird', 'contrarian', 'zeitgeist', 'other'],
            description: '本次搜索偏向哪个领域。避免连续两次用同一个。',
          },
          reason: { type: 'string', description: '为什么好奇这个，一句话' },
        },
        required: ['query', 'angle', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_url',
      description: '抓取并阅读一个网页原文。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要读的 URL' },
          reason: { type: 'string', description: '为什么值得读' },
        },
        required: ['url', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'note_finding',
      description: '立刻把你觉得有意思的东西记下来。不要攒到最后——会忘。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '简短标题' },
          summary: { type: 'string', description: '这是什么，2-3 句' },
          url: { type: 'string', description: '可选：来源 URL' },
          why_caught_attention: { type: 'string', description: '为什么觉得有意思' },
        },
        required: ['title', 'summary', 'why_caught_attention'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: '结束闲逛。攒够了或预算快用完时调用。',
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

export async function runWanderer(input: WandererInput): Promise<WandererResult> {
  const { conversationId, model, budget, emitLog, signal } = input;

  const systemPrompt = await configManager.readPrompt('surfing-wanderer.md');

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `开始闲逛。预算 ${budget} 次（search_web + read_url 合计；note_finding / done 不占预算）。`,
    },
  ];

  const findings: RawFinding[] = [];
  let toolCallsUsed = 0;
  let turns = 0;
  // Wanderer can use more turns than pure search budget since note_finding/done are free
  const maxTurns = budget + 8;

  while (turns < maxTurns) {
    checkAborted(signal);
    turns++;

    emitLog(`[wanderer] 第 ${turns} 轮 (已用 ${toolCallsUsed}/${budget}, findings=${findings.length})`);

    const { result, latencyMs, costUsd } = await chatCompletion({
      model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
    });

    logAudit({
      conversationId, taskType: 'surfing', model,
      inputTokens: result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.completion_tokens ?? 0,
      totalTokens: result.usage?.total_tokens ?? 0,
      costUsd,
      generationId: result.id,
      latencyMs,
    });

    const msg = result.choices[0]?.message;
    if (!msg) {
      emitLog('[wanderer] ⚠️ 空 message');
      break;
    }

    messages.push(msg as ChatCompletionMessageParam);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      emitLog('[wanderer] ⚠️ 未调用工具，提示继续');
      messages.push({
        role: 'user',
        content: toolCallsUsed >= budget
          ? '搜索/阅读预算已用完。如果还有想记的，用 note_finding 提交；否则 done。'
          : '请通过工具调用继续。如果觉得够了，用 done 收尾。',
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
        emitLog(`[wanderer] ✋ done: ${reason}`);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: 'done acknowledged',
        });
        continue;
      }

      if (fnName === 'note_finding') {
        const title = typeof args.title === 'string' ? args.title.trim() : '';
        const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
        const url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : undefined;
        const why = typeof args.why_caught_attention === 'string' ? args.why_caught_attention.trim() : '';
        if (!title || !summary) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: '参数缺失：title 和 summary 必填',
          });
          continue;
        }
        findings.push({ title, summary, url, why_caught_attention: why });
        emitLog(`[wanderer] 📌 ${title}${url ? ` (${url})` : ''}`);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `finding #${findings.length} recorded`,
        });
        continue;
      }

      // search_web / read_url — count against budget
      if (toolCallsUsed >= budget) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: '搜索/阅读预算已用完。如果还有想记的，用 note_finding；否则 done。',
        });
        continue;
      }

      let toolResult: string;
      try {
        if (fnName === 'search_web') {
          const query = typeof args.query === 'string' ? args.query : '';
          const angle = typeof args.angle === 'string' ? args.angle : 'other';
          const reason = typeof args.reason === 'string' ? args.reason : '';
          if (!query) {
            toolResult = '参数缺失：query 为空';
          } else {
            emitLog(`[wanderer] 🔍 [${angle}] ${query}${reason ? ` — ${reason}` : ''}`);
            toolResult = await mcpManager.searchWeb(query);
            emitLog(`[wanderer]   ↳ ${toolResult.length} 字`);
          }
        } else if (fnName === 'read_url') {
          const url = typeof args.url === 'string' ? args.url : '';
          const reason = typeof args.reason === 'string' ? args.reason : '';
          if (!url) {
            toolResult = '参数缺失：url 为空';
          } else {
            emitLog(`[wanderer] 📖 ${url}${reason ? ` — ${reason}` : ''}`);
            toolResult = await mcpManager.readUrl(url);
            emitLog(`[wanderer]   ↳ ${toolResult.length} 字`);
          }
        } else {
          toolResult = `未知工具：${fnName}`;
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        toolResult = `工具执行失败：${e?.message ?? e}`;
        emitLog(`[wanderer] ⚠️ ${fnName} 失败：${e?.message ?? e}`);
      }

      toolCallsUsed++;
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolResult,
      });

      checkAborted(signal);
    }

    if (doneSeen) {
      return { findings, toolCallsUsed, turns };
    }
  }

  emitLog(`[wanderer] ⚠️ 达到最大轮数 ${maxTurns}，自动收尾`);
  return { findings, toolCallsUsed, turns };
}
