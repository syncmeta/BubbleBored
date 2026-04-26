import { randomUUID } from 'crypto';
import { configManager } from '../../config/loader';
import { chatCompletion } from '../../llm/client';
import { logAudit } from '../../llm/audit';
import {
  findConversationById, getMessages, listConversationsByUser,
  createPortrait, type PortraitKind,
} from '../../db/queries';
import { getUserProfile } from '../../honcho/memory';
import { modelFor } from '../models';

const PROMPT_FILES: Record<PortraitKind, string> = {
  moments: 'portrait/moments.md',
  memos: 'portrait/memos.md',
  schedule: 'portrait/schedule.md',
  alarms: 'portrait/alarms.md',
  bills: 'portrait/bills.md',
};

const HISTORY_LIMIT = 60;
const CROSS_CONV_LIMIT = 12;

function formatRelative(ts: number): string {
  const diff = Date.now() - ts * 1000;
  const day = 86400_000;
  if (diff < day) return '今天';
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return `${Math.floor(diff / day)}天前`;
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}周前`;
  return `${Math.floor(diff / (30 * day))}月前`;
}

function extractJson(raw: string): any | null {
  // Strip ```json fences if present, then grab the outermost {...}.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? raw;
  const m = body.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

export interface GenerateInput {
  portraitConvId: string;       // the 画像 conv (where this asset is owned)
  sourceConversationId: string; // the message conv we infer from
  kind: PortraitKind;
  withImage: boolean;
  model?: string;
}

export interface GenerateResult {
  portraitId: string;
  content: any;
}

export async function generatePortrait(input: GenerateInput): Promise<GenerateResult> {
  const portraitConv = findConversationById(input.portraitConvId);
  if (!portraitConv) throw new Error('portrait conversation not found');
  if (portraitConv.feature_type !== 'portrait') {
    throw new Error('not a portrait conversation');
  }
  const sourceConv = findConversationById(input.sourceConversationId);
  if (!sourceConv) throw new Error('source conversation not found');

  // Pull source-conv messages — same shape as planner.ts uses
  const sourceMsgs = getMessages(input.sourceConversationId, HISTORY_LIMIT);
  const sourceTranscript = sourceMsgs.map((m: any) =>
    `${m.sender_type === 'user' ? '用户' : 'bot'}：${m.content}`
  ).join('\n');

  // Cross-conv snapshot — what other things this user has been chatting with
  // this bot about — gives the generator broader context.
  const allConvs = listConversationsByUser(sourceConv.user_id, 'message');
  const otherConvs = allConvs
    .filter((c: any) => c.bot_id === sourceConv.bot_id && c.id !== input.sourceConversationId)
    .slice(0, CROSS_CONV_LIMIT);
  const crossText = otherConvs.length > 0
    ? otherConvs.map((c: any) => {
        const title = c.title?.trim() || '(无标题)';
        const when = c.last_activity_at ? formatRelative(c.last_activity_at) : '—';
        const rounds = c.round_count ?? 0;
        return `- [${when}] ${title}（${rounds} 轮）`;
      }).join('\n')
    : '（无其它会话）';

  // Long-term profile via Honcho if configured (otherwise empty)
  let profileText = '';
  try {
    const p = await getUserProfile(sourceConv.user_id);
    if (p.card.length > 0 || p.representation) {
      profileText = `长期画像：\n${p.card.join('\n')}${p.representation ? '\n' + p.representation : ''}`;
    }
  } catch (e: any) {
    console.warn('[portrait] honcho profile load:', e?.message ?? e);
  }

  const systemPrompt = await configManager.readPrompt(PROMPT_FILES[input.kind]);
  const model = input.model ?? modelFor('portrait');

  const userMessage = [
    profileText ? profileText + '\n' : '',
    `with_image = ${input.withImage}`,
    '',
    '─── 跨会话标题（同一 bot） ───',
    crossText,
    '',
    '─── 源会话最近对话 ───',
    sourceTranscript || '（这个会话还没什么内容）',
    '',
    '请按 system 指令输出 JSON。',
  ].join('\n');

  const { result, latencyMs, costUsd } = await chatCompletion({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });

  logAudit({
    userId: portraitConv.user_id,
    conversationId: input.portraitConvId,
    taskType: 'portrait',
    model,
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
    totalTokens: result.usage?.total_tokens ?? 0,
    costUsd,
    generationId: result.id,
    latencyMs,
  });

  const raw = result.choices[0]?.message?.content?.trim() ?? '';
  const json = extractJson(raw);
  if (!json || !Array.isArray(json.items)) {
    throw new Error('生成失败：未能解析出 JSON items');
  }

  const portraitId = randomUUID();
  createPortrait({
    id: portraitId,
    conversationId: input.portraitConvId,
    sourceConversationId: input.sourceConversationId,
    kind: input.kind,
    withImage: input.withImage,
    contentJson: JSON.stringify(json),
    status: 'ready',
  });

  return { portraitId, content: json };
}
