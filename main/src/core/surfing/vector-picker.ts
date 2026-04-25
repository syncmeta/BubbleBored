// Vector picker — replaces the old planner.
//
// Asks the LLM to read every user-interest signal we have and produce a
// short list of digging vectors with score hints + a pick. Returns:
//   - the picked vector(s) (1 or 2),
//   - a known_profile shim used by the digger for inline novelty checks,
//   - the raw candidate list (for log display),
//   - the joined signals text (for log display + audit).
//
// If a manual override is provided, the picker is skipped entirely and the
// override is wrapped as the single picked vector.

import { createHash, randomUUID } from 'crypto';
import { configManager } from '../../config/loader';
import { chatCompletion } from '../../llm/client';
import { logAudit } from '../../llm/audit';
import { getMessages } from '../../db/queries';
import type { SurfMode } from '../../db/queries';
import { gatherExtendedSignals } from './signals';

export interface DiggingVector {
  topic: string;
  mode: Exclude<SurfMode, 'serendipity'>;
  why_now: string;
  freshness_window?: string;
  score_hint?: number;
}

export interface PickerKnownProfile {
  topics_covered: string[];
  concepts_known: string[];
  open_questions: string[];
}

export interface VectorPickerOutput {
  candidates: DiggingVector[];
  picked: DiggingVector[];
  knownProfile: PickerKnownProfile;
  blindSpotsNote: string;
  signalsJoined: string;
  rawText: string;
}

export interface VectorPickerInput {
  surfConvId: string;
  sourceConvId: string | null;
  botId: string;
  userId: string;
  model: string;
  budgetHint: number;             // total surf budget — picker may pick 2 if budget high
  emitLog: (content: string) => void;
  signal?: AbortSignal;
  override?: { topic: string; mode: DiggingVector['mode']; freshness_window?: string } | null;
}

const HISTORY_LIMIT = 200;
const TWO_VECTOR_BUDGET_THRESHOLD = 15;

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
}

const EMPTY_KNOWN: PickerKnownProfile = {
  topics_covered: [], concepts_known: [], open_questions: [],
};

function parseStringArray(v: any): string[] {
  return Array.isArray(v)
    ? v.filter((x: any) => typeof x === 'string' && x.trim()).map(s => s.trim())
    : [];
}

function isValidMode(s: any): s is DiggingVector['mode'] {
  return s === 'depth' || s === 'granular' || s === 'fresh';
}

export function vectorHash(topic: string, mode: SurfMode): string {
  return createHash('sha1')
    .update(`${topic.trim().toLowerCase()}|${mode}`)
    .digest('hex')
    .slice(0, 16);
}

export async function runVectorPicker(input: VectorPickerInput): Promise<VectorPickerOutput> {
  const { surfConvId, sourceConvId, botId, userId, model, budgetHint, emitLog, signal, override } = input;

  // Manual override short-circuits the LLM call.
  if (override && override.topic.trim() && isValidMode(override.mode)) {
    emitLog(`[picker] 用户指定向量：[${override.mode}] ${override.topic.trim()}`);
    const v: DiggingVector = {
      topic: override.topic.trim(),
      mode: override.mode,
      why_now: '用户在 modal 里手动指定',
      freshness_window: override.mode === 'fresh' ? (override.freshness_window || 'past 90 days') : undefined,
      score_hint: 1,
    };
    return {
      candidates: [v], picked: [v],
      knownProfile: EMPTY_KNOWN,
      blindSpotsNote: '',
      signalsJoined: '(manual override — signals skipped)',
      rawText: '',
    };
  }

  emitLog('[picker] 收集用户信号 (Honcho / ai_picks / portrait / perception / 跨会话)');
  const signals = await gatherExtendedSignals({
    userId, botId, sourceConvId, surfConvId,
  });

  emitLog(`[picker] 信号汇总：${signals.joined.length} 字${signals.recentVectors.length > 0 ? `（已挖向量 ${signals.recentVectors.length} 条用于去重）` : ''}`);

  // Pull the source conversation history (if any) so the picker can see the
  // raw conversation flow, not just summarized titles.
  let historyMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  if (sourceConvId) {
    const history = getMessages(sourceConvId, HISTORY_LIMIT);
    historyMessages = history.map((m: any) => ({
      role: (m.sender_type === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content as string,
    }));
    emitLog(`[picker] 加载源会话历史 ${history.length} 条`);
  }

  checkAborted(signal);

  const sysPrompt = await configManager.readPrompt('surfing.md');
  const allowTwo = budgetHint >= TWO_VECTOR_BUDGET_THRESHOLD;

  const leadIn = [
    signals.joined || '(没有可用的用户信号——这次冲浪几乎是冷启动)',
    sourceConvId
      ? '\n（以下是源会话的对话历史。digger 会用 known_profile 做内联 novelty 判断，所以请把已知主题/概念列得越具体越好。）'
      : '\n（没有源会话——靠上面的信号工作。）',
  ].join('\n');

  const messages = [
    { role: 'system' as const, content: sysPrompt },
    { role: 'user' as const, content: leadIn },
    ...historyMessages,
    {
      role: 'user' as const,
      content: [
        `预算提示：本次冲浪总预算 ${budgetHint} 次。`,
        allowTwo
          ? '预算较大，picked_indices 可以是 1 或 2 个。'
          : '预算较小，picked_indices **只选 1 个**——挖透比铺开重要。',
        '严格按 system 提示的 JSON 格式输出，不要任何解释文字。',
      ].join('\n'),
    },
  ];

  emitLog(`[picker] 调用 LLM (${model})`);
  const { result, latencyMs, costUsd } = await chatCompletion({ model, messages });

  logAudit({
    conversationId: surfConvId, taskType: 'surfing', model,
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
    totalTokens: result.usage?.total_tokens ?? 0,
    costUsd,
    generationId: result.id,
    latencyMs,
  });

  const rawText = result.choices[0]?.message?.content?.trim() ?? '';
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  const empty: VectorPickerOutput = {
    candidates: [], picked: [],
    knownProfile: EMPTY_KNOWN, blindSpotsNote: '',
    signalsJoined: signals.joined, rawText,
  };
  if (!jsonMatch) {
    emitLog('[picker] ⚠️ 响应未包含 JSON');
    return empty;
  }

  let obj: any;
  try { obj = JSON.parse(jsonMatch[0]); } catch {
    emitLog('[picker] ⚠️ JSON 解析失败');
    return empty;
  }

  const candidates: DiggingVector[] = Array.isArray(obj.candidates)
    ? obj.candidates
        .filter((c: any) => c && typeof c.topic === 'string' && isValidMode(c.mode))
        .map((c: any) => ({
          topic: c.topic.trim(),
          mode: c.mode as DiggingVector['mode'],
          why_now: typeof c.why_now === 'string' ? c.why_now.trim() : '',
          freshness_window: typeof c.freshness_window === 'string' && c.freshness_window.trim()
            ? c.freshness_window.trim() : undefined,
          score_hint: typeof c.score_hint === 'number' ? c.score_hint : undefined,
        }))
    : [];

  if (candidates.length === 0) {
    emitLog('[picker] ⚠️ 没有产出任何候选向量');
    return empty;
  }

  // Apply picked_indices, capped to allowTwo and to 1..min(2, candidates.length)
  const rawIdx: number[] = Array.isArray(obj.picked_indices)
    ? obj.picked_indices.filter((n: any) => typeof n === 'number' && n >= 0 && n < candidates.length)
    : [];
  const maxPick = allowTwo ? Math.min(2, candidates.length) : 1;
  const idx: number[] = rawIdx.length > 0 ? rawIdx.slice(0, maxPick) : [0];
  // Dedup picked indices
  const seen = new Set<number>();
  const finalIdx: number[] = idx.filter((n) => {
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
  const picked: DiggingVector[] = finalIdx.map((i) => candidates[i]);

  // Filter out picks that exactly hash-match a recent dug vector (defense in
  // depth — the prompt also tells the model to avoid this, but we double-check)
  const recentHashes = new Set(signals.recentVectors.map(v => v.vector_hash));
  const dedupedPicked = picked.filter(v => !recentHashes.has(vectorHash(v.topic, v.mode)));
  if (dedupedPicked.length === 0 && picked.length > 0) {
    emitLog(`[picker] ⚠️ 选出的向量与近期已挖重合，从候选中找一个未挖过的`);
    const fallback = candidates.find(c => !recentHashes.has(vectorHash(c.topic, c.mode)));
    if (fallback) dedupedPicked.push(fallback);
  }

  const kp = obj.known_profile ?? {};
  const knownProfile: PickerKnownProfile = {
    topics_covered: parseStringArray(kp.topics_covered),
    concepts_known: parseStringArray(kp.concepts_known),
    open_questions: parseStringArray(kp.open_questions),
  };

  return {
    candidates,
    picked: dedupedPicked,
    knownProfile,
    blindSpotsNote: typeof obj.blind_spots_note === 'string' ? obj.blind_spots_note.trim() : '',
    signalsJoined: signals.joined,
    rawText,
  };
}

// ID generator for surf_vectors row inserts.
export function newVectorRecordId(): string {
  return randomUUID();
}
