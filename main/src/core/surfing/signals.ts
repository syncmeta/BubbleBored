// Aggregates every user-interest signal the vector picker has access to:
// Honcho long-term profile, ai_picks (saved articles), portrait imagined
// assets, perception block (rhythm + cross-focus + task phase), and the
// list of recently-dug vectors for dedup. Each section is independently
// fail-safe — if any source is empty/broken, the picker still gets the
// rest. Returned text is plain Markdown-ish, ready to drop into the
// picker prompt as one block.

import {
  listAiPicks, listConversationsByUser, recentSurfVectors,
  type SurfVectorRow,
} from '../../db/queries';
import { getDb } from '../../db/index';
import { getUserProfile } from '../../honcho/memory';
import { buildPerceptionBlock } from '../perception';

export interface ExtendedSignals {
  profileText: string;          // Honcho card + representation
  crossConvText: string;        // titles of other recent message convs
  aiPicksText: string;          // saved articles (active)
  portraitText: string;         // imagined assets
  perceptionText: string;       // rhythm + task phase + cross-focus
  recentVectors: SurfVectorRow[]; // for dedup
  // Aggregate all of the above into one block ready for the picker prompt.
  joined: string;
}

const CROSS_CONV_LIMIT = 20;
const AI_PICKS_LIMIT = 30;
const PORTRAIT_LIMIT = 12;
const DEDUP_DAYS = 14;

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

async function loadProfile(userId: string): Promise<string> {
  try {
    const p = await getUserProfile(userId);
    if (p.card.length === 0 && !p.representation) return '';
    const lines = ['## 长期画像（Honcho）'];
    if (p.card.length > 0) lines.push(...p.card.map(s => `- ${s}`));
    if (p.representation) lines.push(`\n${p.representation}`);
    return lines.join('\n');
  } catch (e: any) {
    console.warn('[surf-signals] profile load failed:', e?.message ?? e);
    return '';
  }
}

function loadCrossConv(userId: string, botId: string, excludeId: string): string {
  try {
    const all = listConversationsByUser(userId, 'message');
    const others = all
      .filter((c: any) => c.bot_id === botId && c.id !== excludeId)
      .slice(0, CROSS_CONV_LIMIT);
    if (others.length === 0) return '';
    const lines = ['## 跨会话主题（同一 bot 下）'];
    for (const c of others as any[]) {
      const title = c.title?.trim() || '(无标题)';
      const when = c.last_activity_at ? formatRelative(c.last_activity_at) : '—';
      const rounds = c.round_count ?? 0;
      lines.push(`- [${when}] ${title}（${rounds} 轮）`);
    }
    return lines.join('\n');
  } catch (e: any) {
    console.warn('[surf-signals] cross-conv failed:', e?.message ?? e);
    return '';
  }
}

function loadAiPicks(userId: string): string {
  try {
    const picks = listAiPicks(userId, false).slice(0, AI_PICKS_LIMIT);
    if (picks.length === 0) return '';
    const lines = ['## 用户保存的文章（明确兴趣信号）'];
    for (const p of picks) {
      const when = formatRelative(p.picked_at * 1000);
      const why = p.why_picked ? ` — ${p.why_picked}` : '';
      const url = p.url ? ` [${p.url}]` : '';
      lines.push(`- [${when}] ${p.title}${url}${why}`);
    }
    return lines.join('\n');
  } catch (e: any) {
    console.warn('[surf-signals] ai_picks failed:', e?.message ?? e);
    return '';
  }
}

// Pulls the most recent N portrait assets across the user's portrait
// conversations. content_json shape varies by kind, so we summarize by
// kind + a snippet of the JSON.
function loadPortrait(userId: string): string {
  try {
    const db = getDb();
    const rows = db.query<any, [string, number]>(
      `SELECT p.* FROM portraits p
         JOIN conversations c ON p.conversation_id = c.id
       WHERE c.user_id = ?
       ORDER BY p.created_at DESC LIMIT ?`
    ).all(userId, PORTRAIT_LIMIT);
    if (rows.length === 0) return '';
    const lines = ['## 画像（bot 想象出来的用户生活片段）'];
    for (const r of rows) {
      const when = formatRelative(r.created_at * 1000);
      let snippet = '';
      try {
        const parsed = JSON.parse(r.content_json);
        // Prefer a `summary` / `title` field if present, else first stringy value
        snippet = parsed?.summary || parsed?.title
          || (typeof parsed === 'object'
              ? Object.values(parsed).find(v => typeof v === 'string') as string
              : '')
          || '';
        if (snippet.length > 80) snippet = snippet.slice(0, 80) + '…';
      } catch {}
      lines.push(`- [${when}] (${r.kind}) ${snippet || '(无摘要)'}`);
    }
    return lines.join('\n');
  } catch (e: any) {
    console.warn('[surf-signals] portrait failed:', e?.message ?? e);
    return '';
  }
}

async function loadPerception(sourceConvId: string | null): Promise<string> {
  if (!sourceConvId) return '';
  try {
    const block = await buildPerceptionBlock({ conversationId: sourceConvId });
    if (!block) return '';
    return ['## 当下感知（节奏 / 任务期 / 近期焦点）', block].join('\n');
  } catch (e: any) {
    console.warn('[surf-signals] perception failed:', e?.message ?? e);
    return '';
  }
}

function formatRecentVectors(rows: SurfVectorRow[]): string {
  if (rows.length === 0) return '';
  const lines = ['## 近期已挖向量（避免重复）'];
  for (const v of rows) {
    const when = formatRelative(v.created_at * 1000);
    const fresh = v.freshness_window ? ` window=${v.freshness_window}` : '';
    lines.push(`- [${when}] [${v.mode}] ${v.topic}${fresh}`);
  }
  return lines.join('\n');
}

export async function gatherExtendedSignals(params: {
  userId: string;
  botId: string;
  sourceConvId: string | null;  // message conv that anchors this surf, if any
  surfConvId: string;           // the surf conv itself (excluded from cross-conv)
  dedupDays?: number;
}): Promise<ExtendedSignals> {
  const dedupDays = params.dedupDays ?? DEDUP_DAYS;

  const [profileText, perceptionText] = await Promise.all([
    loadProfile(params.userId),
    loadPerception(params.sourceConvId),
  ]);

  const crossConvText = loadCrossConv(
    params.userId, params.botId,
    params.sourceConvId ?? params.surfConvId,
  );
  const aiPicksText = loadAiPicks(params.userId);
  const portraitText = loadPortrait(params.userId);
  const recentVectors = recentSurfVectors(params.userId, params.botId, dedupDays);
  const recentVectorsText = formatRecentVectors(recentVectors);

  const sections = [
    profileText, crossConvText, aiPicksText,
    portraitText, perceptionText, recentVectorsText,
  ].filter(s => s.trim());

  return {
    profileText, crossConvText, aiPicksText,
    portraitText, perceptionText, recentVectors,
    joined: sections.join('\n\n'),
  };
}
