// Broad perception block — assembles a small <perception>...</perception>
// briefing the model can optionally lean on. Mostly cheap & local: time of
// day + activity rhythm + cross-conv focus. Task-phase guess goes through a
// cheap LLM with a TTL cache.
//
// Important contract: this is AI-generated speculation, not ground truth.
// system.md tells the model not to repeat or rely heavily on it.

import { configManager } from '../../config/loader';
import { chatCompletion } from '../../llm/client';
import { logAudit } from '../../llm/audit';
import { findConversationById, getMessages, listConversationsByUser } from '../../db/queries';
import { getWeather } from './weather';

interface PerceptionParts {
  now: string;
  rhythm: string;
  taskPhase: string;
  weather: string;
  crossFocus: string;
}

interface CacheEntry { value: string; expiresAt: number; }

const taskPhaseCache = new Map<string, CacheEntry>();
const crossFocusCache = new Map<string, CacheEntry>();

const TASK_PHASE_TTL_MS = 5 * 60_000;
const CROSS_FOCUS_TTL_MS = 60 * 60_000;

function nowChinaPhrase(d: Date): { date: string; phrase: string } {
  const dow = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  const h = d.getHours();
  const m = d.getMinutes();
  const tod =
    h < 5 ? '凌晨' :
    h < 9 ? '清晨' :
    h < 12 ? '上午' :
    h < 14 ? '中午' :
    h < 18 ? '下午' :
    h < 23 ? '晚上' : '深夜';
  const hhmm = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  return {
    date: `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`,
    phrase: `${dow}${tod} ${hhmm}`,
  };
}

function rhythmSignal(messages: Array<{ created_at: number; sender_type: string }>): string {
  const userMsgs = messages.filter(m => m.sender_type === 'user').slice(-12);
  if (userMsgs.length === 0) return '（无消息节奏可参考）';
  const lastTs = userMsgs[userMsgs.length - 1].created_at * 1000;
  const sinceLast = Date.now() - lastTs;
  const minutes = Math.floor(sinceLast / 60_000);
  // Group by 6h windows in last 24h to count active stretches
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const todayMsgs = userMsgs.filter(m => m.created_at * 1000 > dayAgo);
  return `今日活跃 ${todayMsgs.length} 条消息，距上一条 ${minutes < 1 ? '<1' : minutes} 分钟`;
}

async function inferTaskPhase(conversationId: string): Promise<string> {
  const cached = taskPhaseCache.get(conversationId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const messages = getMessages(conversationId, 8);
  if (messages.length < 2) return '（信息不足）';

  const transcript = messages.map((m: any) =>
    `${m.sender_type === 'user' ? '用户' : 'bot'}：${m.content}`
  ).join('\n');

  const debounceModel = configManager.get().openrouter.debounceModel;
  const model = debounceModel ?? configManager.get().openrouter.defaultModel;

  try {
    const { result, latencyMs, costUsd } = await chatCompletion({
      model,
      messages: [
        {
          role: 'system',
          content:
            '你的任务：基于一段对话片段，**一句话**（< 30 字）粗略推测对方目前可能在做什么任务、处于该任务的哪个阶段。' +
            '允许大胆猜测但保持谦逊（"似乎/可能"开头）。如果完全看不出，回复"无明显信号"。' +
            '只回复那一句话，不要解释。',
        },
        { role: 'user', content: transcript },
      ],
    });

    logAudit({
      conversationId, taskType: 'perception', model,
      inputTokens: result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.completion_tokens ?? 0,
      totalTokens: result.usage?.total_tokens ?? 0,
      costUsd,
      generationId: result.id,
      latencyMs,
    });

    const text = result.choices[0]?.message?.content?.trim() || '无明显信号';
    taskPhaseCache.set(conversationId, {
      value: text,
      expiresAt: Date.now() + TASK_PHASE_TTL_MS,
    });
    return text;
  } catch (e: any) {
    console.warn('[perception] task-phase failed:', e?.message ?? e);
    return '（推断失败）';
  }
}

async function inferCrossFocus(userId: string, botId: string): Promise<string> {
  const key = `${userId}:${botId}`;
  const cached = crossFocusCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const sevenDaysAgo = Math.floor((Date.now() - 7 * 24 * 3600 * 1000) / 1000);
  const allConvs = listConversationsByUser(userId, 'message');
  const recent = allConvs.filter(
    (c: any) => c.bot_id === botId && c.last_activity_at >= sevenDaysAgo,
  );
  if (recent.length === 0) {
    return '（近 7 天无其它会话）';
  }

  const titles = recent.map((c: any) => c.title?.trim() || '(无标题)').filter(Boolean);
  if (titles.length === 1) {
    return `近 7 天主要话题：${titles[0]}`;
  }

  // Cheap LLM summary — same model as task-phase
  const debounceModel = configManager.get().openrouter.debounceModel;
  const model = debounceModel ?? configManager.get().openrouter.defaultModel;

  try {
    const { result, latencyMs, costUsd } = await chatCompletion({
      model,
      messages: [
        {
          role: 'system',
          content:
            '你拿到的是同一用户最近 7 天跟这个 bot 聊过的几条会话标题。' +
            '**一句话**（< 30 字）：归纳对方近期的焦点 / 是否有反复纠结的主题 / 是否密度异常。' +
            '允许猜测，但保持谦逊。只回复那一句话。',
        },
        { role: 'user', content: titles.map(t => `- ${t}`).join('\n') },
      ],
    });

    logAudit({
      conversationId: undefined, taskType: 'perception', model,
      inputTokens: result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.completion_tokens ?? 0,
      totalTokens: result.usage?.total_tokens ?? 0,
      costUsd, generationId: result.id, latencyMs,
    });

    const text = result.choices[0]?.message?.content?.trim() || '近期焦点无明显特征';
    crossFocusCache.set(key, {
      value: text,
      expiresAt: Date.now() + CROSS_FOCUS_TTL_MS,
    });
    return text;
  } catch (e: any) {
    console.warn('[perception] cross-focus failed:', e?.message ?? e);
    return '（推断失败）';
  }
}

export async function buildPerceptionBlock(params: {
  conversationId: string;
}): Promise<string> {
  const conv = findConversationById(params.conversationId);
  if (!conv) return '';

  const now = new Date();
  const time = nowChinaPhrase(now);
  const messages = getMessages(params.conversationId, 30);
  const rhythm = rhythmSignal(messages);

  // These two go in parallel — they're independent network calls.
  const [taskPhase, crossFocus, weather] = await Promise.all([
    inferTaskPhase(params.conversationId),
    inferCrossFocus(conv.user_id, conv.bot_id),
    getWeather().catch(() => ''),
  ]);

  const parts: PerceptionParts = {
    now: `现在：${time.phrase}（${time.date}）`,
    rhythm: `节奏：${rhythm}`,
    taskPhase: `任务阶段（推测）：${taskPhase}`,
    weather: weather ? `天气：${weather}` : '',
    crossFocus: `近期：${crossFocus}`,
  };

  const lines = [parts.now, parts.rhythm, parts.taskPhase];
  if (parts.weather) lines.push(parts.weather);
  lines.push(parts.crossFocus);

  return [
    '<perception>',
    '（以下由 AI 自动推测，不是事实，仅在合适时作内部参考；不要主动提及，不要复制以下用词出现在回复里）',
    ...lines.map(l => `- ${l}`),
    '</perception>',
  ].join('\n');
}
