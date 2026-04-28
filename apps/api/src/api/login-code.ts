import { base64UrlEncode, base64UrlDecode } from './_helpers';

/**
 * 登录码 (login code) — self-contained text string that packages everything
 * an iOS client needs to log in: server origin (proto+host+port), optional
 * fallback servers, the bearer api key, and a friendly account name.
 *
 * Format: `pbk1.<base64url(json)>`
 *   - `pbk1.` prefix makes the code identifiable when pasted (so the iOS
 *     paste sheet can detect it on appear without parsing).
 *   - `1` = format version. Bumped if the JSON shape changes.
 *
 * Payload keys are short on purpose — the code ends up in WeChat / SMS,
 * where shorter is friendlier.
 *   v: format version (always 1 today)
 *   s: server origin, e.g. "http://192.168.1.42:3456" — no trailing slash
 *   a: optional alternate origins for LAN/WAN fallback
 *   k: full bearer api key (`pbk_live_...`)
 *   n: friendly display name
 *
 * "One-time use" is honor-system: the code embeds the key directly, so it
 * stays valid for as long as the key is. The intent is "import once, then
 * discard the text". To revoke compromised codes, revoke the underlying
 * key in the admin panel.
 */

const PREFIX = 'pbk1.';

export interface LoginCodePayload {
  server: string;
  alts?: string[];
  key: string;
  name: string;
}

export function encodeLoginCode(p: LoginCodePayload): string {
  const json: Record<string, unknown> = {
    v: 1,
    s: p.server.replace(/\/+$/, ''),
    k: p.key,
    n: p.name,
  };
  if (p.alts && p.alts.length > 0) {
    json.a = p.alts.map(s => s.replace(/\/+$/, ''));
  }
  return PREFIX + base64UrlEncode(JSON.stringify(json));
}

export function decodeLoginCode(code: string): LoginCodePayload | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PREFIX)) return null;
  try {
    const raw = base64UrlDecode(trimmed.slice(PREFIX.length)).toString('utf8');
    const obj = JSON.parse(raw);
    if (obj.v !== 1) return null;
    if (typeof obj.s !== 'string' || typeof obj.k !== 'string' || typeof obj.n !== 'string') return null;
    const alts = Array.isArray(obj.a) ? obj.a.filter((x: unknown) => typeof x === 'string') : undefined;
    return { server: obj.s, alts, key: obj.k, name: obj.n };
  } catch {
    return null;
  }
}
