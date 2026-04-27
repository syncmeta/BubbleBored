import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { findEnabledSkillBodyByName } from './skills';

// `load_skill` exposed as a function-style tool to the chat model. The
// system prompt only carries skill names + descriptions (see
// buildSkillsPromptBlock); when the model decides a skill is relevant it
// calls this tool with the skill's name to pull in the full instructions.
// Mirrors Claude Code's progressive-disclosure pattern.

export const LOAD_SKILL_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'load_skill',
    description:
      '加载某项已启用技能的完整说明。仅在你判断该技能与当前请求相关时调用——加载后请按其指引完成本次回答。`name` 必须严格匹配上文「可用技能」列表里的技能名。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '技能名，需与「可用技能」列表中的项一致（大小写不敏感）。',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
};

export interface LoadSkillToolCall { id: string; name: string; }
export interface LoadSkillToolResult {
  tool_call_id: string;
  name: string;
  content: string;
  ok: boolean;
}

const BODY_LIMIT = 24_000;

// Per-send cache so repeated calls for the same skill in one tool loop
// don't re-hit SQLite (and stay deterministic if the user toggles mid-send).
export function makeSkillBodyCache(): Map<string, LoadSkillToolResult> {
  return new Map();
}

export function runLoadSkillToolCall(params: {
  userId: string;
  call: LoadSkillToolCall;
  cache: Map<string, LoadSkillToolResult>;
}): LoadSkillToolResult {
  const { userId, call, cache } = params;
  const wanted = (call.name ?? '').trim();
  const cacheKey = wanted.toLowerCase();
  if (cacheKey && cache.has(cacheKey)) {
    const hit = cache.get(cacheKey)!;
    return { ...hit, tool_call_id: call.id };
  }

  if (!wanted) {
    return {
      tool_call_id: call.id, name: '', ok: false,
      content: '加载失败：name 为空。请从「可用技能」列表里选一个具体的技能名。',
    };
  }

  const found = findEnabledSkillBodyByName(userId, wanted);
  if (!found) {
    return {
      tool_call_id: call.id, name: wanted, ok: false,
      content: `未找到名为「${wanted}」的已启用技能。请检查名字是否与「可用技能」列表完全一致。`,
    };
  }

  const body = found.body.length > BODY_LIMIT
    ? found.body.slice(0, BODY_LIMIT) + '\n…(已截断)'
    : found.body;

  const result: LoadSkillToolResult = {
    tool_call_id: call.id, name: found.name, ok: true,
    content: `# Skill: ${found.name}\n${found.description ? `_${found.description}_\n\n` : ''}${body}`,
  };
  if (cacheKey) cache.set(cacheKey, result);
  return result;
}

// Build the assistant + tool message pair recording one tool round so the
// next LLM round sees its own tool_calls envelope and the corresponding
// tool results. Mirrors buildToolRoundMessages in search/tool.ts.
export function buildLoadSkillRoundMessages(
  assistantContent: string,
  calls: LoadSkillToolCall[],
  results: LoadSkillToolResult[],
): ChatCompletionMessageParam[] {
  return [
    {
      role: 'assistant',
      content: assistantContent || null,
      tool_calls: calls.map(c => ({
        id: c.id,
        type: 'function' as const,
        function: { name: 'load_skill', arguments: JSON.stringify({ name: c.name }) },
      })),
    },
    ...results.map(r => ({
      role: 'tool' as const,
      tool_call_id: r.tool_call_id,
      content: r.content,
    })),
  ];
}
