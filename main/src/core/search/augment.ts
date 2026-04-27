import { mcpManager } from '../../mcp/manager';
import { logAudit } from '../../llm/audit';

// On-demand 联网搜索 for the chat page. Unlike runSearchLoop (which the
// surf/review flows use to reason iteratively about findings via an LLM
// evaluator), this is a single-shot fetch: pass the user's text to Jina
// search_web, hand the result back as a system-prompt augmentation. The
// chat LLM call that follows reads the snippets directly — no extra
// evaluator round-trip, so it's cheap and predictable for "did the user
// just ask something time-sensitive" usage.

export interface AugmentResult {
  context: string | null;
  used: number; // search requests consumed (for audit)
}

export async function augmentWithWebSearch(params: {
  userId: string;
  conversationId: string;
  query: string;
  emitLog: (msg: string) => void;
}): Promise<AugmentResult> {
  const query = params.query.trim();
  if (!query) return { context: null, used: 0 };

  // Cap query length — Jina trims very long queries to noise. The user's
  // bubble can be long; keep the first 400 chars (typical question length).
  const trimmed = query.length > 400 ? query.slice(0, 400) : query;

  params.emitLog(`联网搜索：${trimmed}`);

  let result: string;
  const startedAt = Date.now();
  try {
    result = await mcpManager.searchWeb(trimmed);
  } catch (e: any) {
    params.emitLog(`搜索失败：${e?.message ?? e}`);
    return { context: null, used: 0 };
  }

  // Audit the search call so it shows up in the usage panel alongside chat
  // costs. taskType reuses 'surfing_eval' — same MCP request shape, same
  // category from the user's perspective.
  logAudit({
    userId: params.userId,
    conversationId: params.conversationId,
    taskType: 'surfing_eval',
    model: 'jina/search_web',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    latencyMs: Date.now() - startedAt,
  });

  if (!result || !result.trim()) {
    params.emitLog('未找到相关结果');
    return { context: null, used: 1 };
  }

  params.emitLog('搜索完成，正在思考');

  const context = [
    '## 联网搜索结果（来自实时网络）',
    '',
    `用户问：${trimmed}`,
    '',
    '搜索得到的原始片段（可能含噪声 / 广告 / 来源不一，请筛选可信内容回答）：',
    '',
    result,
    '',
    '基于以上信息回答用户。引用具体来源时附上链接（如果片段里给了）。',
    '回答时如果信息冲突或不足，请如实说明。',
  ].join('\n');

  return { context, used: 1 };
}
