import { configManager } from '../../config/loader';
import { chatCompletion } from '../../llm/client';
import { logAudit } from '../../llm/audit';
import { getMessages, listConversationsByUser } from '../../db/queries';
import { getUserProfile } from '../../honcho/memory';

export interface KnownProfile {
  topics_covered: string[];
  concepts_known: string[];
  perspectives: string[];
  open_questions: string[];
  interests: string[];
}

export interface PlannerOutput {
  known_profile: KnownProfile;
  blind_spots: string;
  needs: string;
  interests: string[];
  rawText: string;
}

export interface PlannerInput {
  conversationId: string;
  botId: string;
  userId: string;
  model: string;
  emitLog: (content: string) => void;
  signal?: AbortSignal;
}

const HISTORY_LIMIT = 200;
const CROSS_CONV_LIMIT = 20;

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const day = 86400_000;
  if (diff < day) return '今天';
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return `${Math.floor(diff / day)}天前`;
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}周前`;
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}月前`;
  return `${Math.floor(diff / (365 * day))}年前`;
}

const EMPTY_PROFILE: KnownProfile = {
  topics_covered: [], concepts_known: [], perspectives: [],
  open_questions: [], interests: [],
};

function parseStringArray(v: any): string[] {
  return Array.isArray(v)
    ? v.filter((x: any) => typeof x === 'string' && x.trim())
    : [];
}

export async function runPlanner(input: PlannerInput): Promise<PlannerOutput> {
  const { conversationId, botId, userId, model, emitLog, signal } = input;

  // (a) Extended current-conversation history
  const history = getMessages(conversationId, HISTORY_LIMIT);
  emitLog(`加载当前会话历史 ${history.length} 条（上限 ${HISTORY_LIMIT}）`);

  // (b) Long-term profile (Honcho, currently stub)
  let profileText = '';
  try {
    const profile = await getUserProfile(userId);
    if (profile.card.length > 0 || profile.representation) {
      profileText = `长期画像：\n${profile.card.join('\n')}${profile.representation ? '\n' + profile.representation : ''}`;
    }
  } catch (e: any) {
    console.warn('[surf] profile load failed:', e?.message ?? e);
  }

  // (c) Cross-conversation snapshot of same user with same bot
  let crossText = '';
  try {
    const allConvs = listConversationsByUser(userId, 'message');
    const others = allConvs
      .filter((c: any) => c.bot_id === botId && c.id !== conversationId)
      .slice(0, CROSS_CONV_LIMIT);
    if (others.length > 0) {
      const lines = others.map((c: any) => {
        const title = c.title?.trim() || '(无标题)';
        const when = c.last_activity_at ? formatRelative(c.last_activity_at) : '—';
        const rounds = c.round_count ?? 0;
        return `- [${when}] ${title}（${rounds} 轮）`;
      });
      crossText = `该用户在本 bot 下的其它会话（近期到远期）：\n${lines.join('\n')}`;
      emitLog(`加载跨会话主题 ${others.length} 条`);
    } else {
      emitLog('无其它会话可参考');
    }
  } catch (e: any) {
    console.warn('[surf] cross-conv load failed:', e?.message ?? e);
  }

  checkAborted(signal);

  const plannerPrompt = await configManager.readPrompt('surfing.md');

  const historyMessages = history.map((m: any) => ({
    role: (m.sender_type === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: m.content as string,
  }));

  const contextParts: string[] = [];
  if (profileText) contextParts.push(profileText);
  if (crossText) contextParts.push(crossText);
  contextParts.push('（以下是当前会话较长时段的对话历史）');
  const leadIn = contextParts.join('\n\n');

  const messages = [
    { role: 'system' as const, content: plannerPrompt },
    { role: 'user' as const, content: leadIn },
    ...historyMessages,
    {
      role: 'user' as const,
      content: '基于以上长程信息，抽取 known_profile / blind_spots / needs / interests，JSON 返回。',
    },
  ];

  emitLog(`调用 planner (${model})...`);
  const { result, latencyMs, costUsd } = await chatCompletion({ model, messages });

  logAudit({
    userId, conversationId, taskType: 'surfing', model,
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
    totalTokens: result.usage?.total_tokens ?? 0,
    costUsd,
    generationId: result.id,
    latencyMs,
  });

  const rawText = result.choices[0]?.message?.content?.trim() ?? '';
  emitLog(`planner 返回 (${latencyMs}ms, ${result.usage?.total_tokens ?? 0} tokens)`);

  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  const empty: PlannerOutput = {
    known_profile: EMPTY_PROFILE,
    blind_spots: '',
    needs: '',
    interests: [],
    rawText,
  };
  if (!jsonMatch) {
    emitLog('⚠️ planner 响应未包含 JSON');
    return empty;
  }

  try {
    const obj = JSON.parse(jsonMatch[0]);
    const kp = obj.known_profile ?? {};
    return {
      known_profile: {
        topics_covered: parseStringArray(kp.topics_covered),
        concepts_known: parseStringArray(kp.concepts_known),
        perspectives: parseStringArray(kp.perspectives),
        open_questions: parseStringArray(kp.open_questions),
        interests: parseStringArray(kp.interests),
      },
      blind_spots: typeof obj.blind_spots === 'string' ? obj.blind_spots : '',
      needs: typeof obj.needs === 'string' ? obj.needs : '',
      interests: parseStringArray(obj.interests),
      rawText,
    };
  } catch {
    emitLog('⚠️ planner JSON 解析失败');
    return empty;
  }
}
