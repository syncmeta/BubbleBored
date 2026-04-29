import { mcpManager } from '../../mcp/manager';
import { logAudit } from '../../llm/audit';
import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions';

// `search_web` exposed as a function-style tool to the chat model. Modeled
// on the way ChatGPT / Claude.ai offer search: the model decides when to
// call it and what to query — we don't pre-emptively run a search just
// because 联网 is on. When the model emits tool_calls back, we run them,
// feed results in as `role: tool` turns, and let the model continue.

export const SEARCH_WEB_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'search_web',
    description:
      '搜索互联网获取实时/外部信息。仅在你判断当前问题需要查最新事实、超出你知识截止日期、或需要权威来源时调用；否则直接基于自身知识回答。每次调用一次只查一个查询词，可在多轮中分别发起多次调用。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索查询词。简洁、信息量高的关键词组合效果最好。',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

export interface SearchToolCall {
  id: string;
  query: string;
}

export interface SearchToolResult {
  tool_call_id: string;
  query: string;
  content: string;
  ok: boolean;
}

const SEARCH_RESULT_LIMIT = 4000;

// Run a single tool-call invocation. Errors are surfaced as content so the
// model sees "search failed" and can decide what to do — we don't break the
// turn just because Jina was flaky.
export async function runSearchToolCall(params: {
  userId: string;
  conversationId: string;
  call: SearchToolCall;
}): Promise<SearchToolResult> {
  const { userId, conversationId, call } = params;
  const startedAt = Date.now();
  const query = (call.query ?? '').trim();

  if (!query) {
    return {
      tool_call_id: call.id, query, ok: false,
      content: '搜索失败：查询词为空',
    };
  }

  let raw: string;
  try {
    raw = await mcpManager.searchWeb(query);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    return {
      tool_call_id: call.id, query, ok: false,
      content: `搜索失败：${msg}`,
    };
  }

  // Keep the audit record in line with the surf/review search calls so this
  // shows up in the usage panel under the same "search" rollup.
  logAudit({
    userId, conversationId,
    taskType: 'surfing_eval',
    model: 'jina/search_web',
    inputTokens: 0, outputTokens: 0, totalTokens: 0,
    latencyMs: Date.now() - startedAt,
  });

  const trimmed = raw.length > SEARCH_RESULT_LIMIT
    ? raw.slice(0, SEARCH_RESULT_LIMIT) + '\n…(已截断)'
    : raw;

  return {
    tool_call_id: call.id, query, ok: true,
    content: trimmed || '（无结果）',
  };
}

// Build the assistant + tool message pair that records a completed tool
// round on the conversation. The assistant message keeps the original
// tool_calls envelope; each result becomes a separate `role: tool` turn
// keyed by tool_call_id (OpenAI's required wire shape).
export function buildToolRoundMessages(
  assistantContent: string,
  calls: SearchToolCall[],
  results: SearchToolResult[],
): ChatCompletionMessageParam[] {
  return [
    {
      role: 'assistant',
      // Some models only emit tool_calls (no content); others narrate ("let
      // me check…"). Either way we faithfully record what they emitted.
      content: assistantContent || null,
      tool_calls: calls.map(c => ({
        id: c.id,
        type: 'function' as const,
        function: { name: 'search_web', arguments: JSON.stringify({ query: c.query }) },
      })),
    },
    ...results.map(r => ({
      role: 'tool' as const,
      tool_call_id: r.tool_call_id,
      content: r.content,
    })),
  ];
}
