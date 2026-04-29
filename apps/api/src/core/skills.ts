import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import {
  listSkillsForUser, listEnabledSkillsForUser, findSkillByName,
  createSkill, updateSkill, type SkillRow,
} from '../db/queries';

const ROOT = join(import.meta.dir, '../..');
const ANTHROPIC_PRESETS_DIR = join(ROOT, 'prompts/skills/anthropic');

// Preset metadata. Order here is the order shown in the UI for first-time
// users. Skills the user explicitly toggles/edits are kept untouched on
// re-seed (we only refresh rows whose body still matches the previous seed
// hash — see seedDefaultSkillsForUser below).
const ANTHROPIC_PRESET_FILES = [
  'skill-creator',
  'mcp-builder',
  'doc-coauthoring',
  'internal-comms',
  'brand-guidelines',
  'theme-factory',
] as const;

const ANTHROPIC_REPO_BASE = 'https://github.com/anthropics/skills/blob/main/skills';
const ANTHROPIC_LICENSE = 'Apache-2.0 © Anthropic, PBC — see prompts/skills/anthropic/NOTICE.md';

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

// Permissive YAML frontmatter parser — only supports the subset used by
// SKILL.md files (top-level scalar key: value, possibly quoted). Good enough
// for the bundled Anthropic presets without pulling in a YAML dep here.
interface ParsedSkillMd {
  name: string;
  description: string;
  body: string;
}
function parseSkillMd(raw: string, fallbackName: string): ParsedSkillMd {
  if (!raw.startsWith('---')) {
    return { name: fallbackName, description: '', body: raw.trim() };
  }
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { name: fallbackName, description: '', body: raw.trim() };
  const fmRaw = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\n+/, '').trimEnd();
  const meta: Record<string, string> = {};
  for (const line of fmRaw.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    meta[m[1]] = v;
  }
  return {
    name: meta.name || fallbackName,
    description: meta.description || '',
    body,
  };
}

export interface PresetSkill {
  presetId: string;        // e.g. 'skill-creator'
  name: string;            // from frontmatter
  description: string;
  body: string;
  source: string;
  sourceUrl: string;
  license: string;
}

let presetCache: PresetSkill[] | null = null;

export async function loadAnthropicPresets(): Promise<PresetSkill[]> {
  if (presetCache) return presetCache;
  const out: PresetSkill[] = [];
  for (const presetId of ANTHROPIC_PRESET_FILES) {
    const path = join(ANTHROPIC_PRESETS_DIR, `${presetId}.md`);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseSkillMd(raw, presetId);
    out.push({
      presetId,
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      source: `anthropic/skills:${presetId}`,
      sourceUrl: `${ANTHROPIC_REPO_BASE}/${presetId}/SKILL.md`,
      license: ANTHROPIC_LICENSE,
    });
  }
  presetCache = out;
  return out;
}

// Seed the user's catalog with the bundled Anthropic presets on first sight.
// Idempotent:
//   - Missing presets are inserted with `enabled = 1`. Skills now follow
//     Claude's progressive-disclosure model: every preset is "installed" by
//     default, but only the description ships in the system prompt — the body
//     is loaded on demand via the `load_skill` tool. So enabling everything
//     upfront has no per-send cost.
//   - Presets the user hasn't touched (body still matches previous seeded_hash)
//     get refreshed from disk so upstream improvements land on next bundle.
//   - Presets the user has edited are left alone.
export async function seedDefaultSkillsForUser(userId: string): Promise<void> {
  const presets = await loadAnthropicPresets();
  for (const p of presets) {
    const existing = findSkillByName(userId, p.name);
    const newHash = sha1(p.body);
    if (!existing) {
      createSkill({
        id: `sk_${randomUUID().slice(0, 12)}`,
        userId, name: p.name,
        description: p.description, body: p.body,
        enabled: true,
        source: p.source, sourceUrl: p.sourceUrl, license: p.license,
        seededHash: newHash,
      });
      continue;
    }
    // Refresh only if (a) row was originally seeded from this preset and
    // (b) the user hasn't edited the body since seeding.
    if (existing.source === p.source &&
        existing.seeded_hash &&
        existing.seeded_hash === sha1(existing.body) &&
        existing.seeded_hash !== newHash) {
      updateSkill(existing.id, {
        description: p.description,
        body: p.body,
        seededHash: newHash,
      });
    }
  }
}

// Public-facing list shape — body is omitted from the index endpoint to keep
// the payload small; the editor fetches the full row by id.
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  source: string | null;
  source_url: string | null;
  license: string | null;
  is_preset: boolean;
  body_length: number;
  updated_at: number;
}

export function summarizeSkill(row: SkillRow): SkillSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: !!row.enabled,
    source: row.source,
    source_url: row.source_url,
    license: row.license,
    is_preset: !!row.source && row.source.startsWith('anthropic/skills:'),
    body_length: row.body.length,
    updated_at: row.updated_at,
  };
}

// ── Prompt injection ───────────────────────────────────────────────────────

// Build the system-prompt block listing the user's enabled skills. Returns
// null if nothing is enabled — caller should skip the append entirely so we
// don't leave a dangling header in the prompt.
//
// Progressive disclosure: only the name + description ship here. When the
// model judges a skill is relevant it calls the `load_skill` tool to fetch
// the full body. This keeps the per-send prompt small even with a dozen
// skills installed; the cost is one extra tool round on the (rare) sends
// that actually need a skill body.
export function buildSkillsPromptBlock(userId: string): string | null {
  const skills = listEnabledSkillsForUser(userId);
  if (skills.length === 0) return null;

  const parts: string[] = [];
  parts.push('## 可用技能（Available Skills）');
  parts.push('');
  parts.push('下表列出当前启用的技能，仅展示简介。当你判断某条技能与本次请求相关时，调用 `load_skill` 工具按 `name` 加载完整说明再据此执行；不相关就不要加载、也不要硬塞。');
  parts.push('');
  for (const s of skills) {
    parts.push(`- **${s.name}** — ${s.description || '(无简介)'}`);
  }
  return parts.join('\n').trimEnd();
}

// Lookup helper for the load_skill tool — only enabled skills are loadable
// (must mirror what we advertised in the prompt block above). Match is
// case-insensitive so the model's casing doesn't matter.
export function findEnabledSkillBodyByName(userId: string, name: string): {
  name: string; description: string; body: string;
} | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  for (const s of listEnabledSkillsForUser(userId)) {
    if (s.name.toLowerCase() === wanted) {
      return { name: s.name, description: s.description, body: s.body };
    }
  }
  return null;
}

export { listSkillsForUser };
