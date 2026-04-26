import { networkInterfaces } from 'os';
import { configManager } from '../config/loader';

/**
 * "What addresses can this server be reached at, and what should the share
 * link default to?"
 *
 * Sources, in priority order:
 *   1. `server.publicURL` from config.yaml — explicit operator override,
 *      typically the public DNS name once deployed somewhere with a
 *      stable address. Always preferred for share links.
 *   2. Non-loopback LAN IPv4s from `os.networkInterfaces()` — covers
 *      "I'm running this on my desktop, want to send a link to a friend
 *      on the same Wi-Fi" without any config.
 *   3. The host the admin's browser is hitting right now — falls back to
 *      this when nothing else is available, but flagged so the UI can
 *      warn the admin if they're on `localhost` (un-shareable).
 */

export interface ServerUrlSet {
  /// The single URL recommended as the share-link default. Pick #1 from
  /// the priority list above.
  primary: string;
  /// Everything else worth offering as fallback — iOS clients probe these
  /// in order if `primary` is unreachable from where they are.
  alternates: string[];
  /// Annotated full list for the admin-panel dropdown.
  options: ServerUrlOption[];
  /// Free-form note for the UI ("⚠ 当前从 localhost 访问,无法分享给他人").
  warning?: string;
}

export interface ServerUrlOption {
  url: string;
  label: string;
  source: 'configured' | 'lan' | 'request' | 'loopback';
  /// True if this is the same host the admin used to open the panel —
  /// useful for the UI to mark it as "current".
  isCurrent: boolean;
}

/**
 * Build the URL set for one specific request (so we know what host the
 * admin is using and can mark "current").
 */
export function detectServerUrls(c: any): ServerUrlSet {
  const cfg = configManager.get();
  const port = cfg.server.port;

  const proto = c.req.header('x-forwarded-proto')
             ?? new URL(c.req.url).protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host')
            ?? c.req.header('host')
            ?? new URL(c.req.url).host;
  const requestUrl = `${proto}://${host}`;

  const configured = (cfg as any).server?.publicURL as string | undefined;
  const lanIPs = collectLanIPv4Addresses();

  const options: ServerUrlOption[] = [];

  if (configured) {
    options.push({
      url: stripTrailingSlash(configured),
      label: '公网地址 (来自 config.yaml)',
      source: 'configured',
      isCurrent: stripTrailingSlash(configured) === requestUrl,
    });
  }

  for (const ip of lanIPs) {
    const url = `${proto}://${ip}:${port}`;
    options.push({
      url,
      label: `局域网 ${ip}`,
      source: 'lan',
      isCurrent: url === requestUrl,
    });
  }

  // Always include the request URL — even if it's localhost, the admin
  // might be testing from the same machine that runs the server.
  if (!options.some(o => o.url === requestUrl)) {
    const isLoopback = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/.test(host);
    options.push({
      url: requestUrl,
      label: isLoopback ? `当前访问 (仅本机可用)` : `当前访问 ${requestUrl}`,
      source: isLoopback ? 'loopback' : 'request',
      isCurrent: true,
    });
  }

  // Pick the primary: the first non-loopback option.
  const primary = options.find(o => o.source !== 'loopback')?.url
              ?? options[0]?.url
              ?? requestUrl;

  // Alternates = everything else, deduped, in priority order. Loopback is
  // intentionally dropped from alternates — it's never useful to a remote
  // recipient.
  const alternates = options
    .map(o => o.url)
    .filter(u => u !== primary)
    .filter((u, i, arr) => arr.indexOf(u) === i)
    .filter(u => !options.find(o => o.url === u && o.source === 'loopback'));

  let warning: string | undefined;
  if (primary === requestUrl && options.find(o => o.url === requestUrl)?.source === 'loopback') {
    warning = '当前只检测到回环地址。建议在 config.yaml 设置 server.publicURL,或直接用本机的 LAN IP 打开管理面板。';
  }

  return { primary, alternates, options, warning };
}

function collectLanIPv4Addresses(): string[] {
  const result: string[] = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    const list = ifaces[name];
    if (!list) continue;
    for (const entry of list) {
      // Skip IPv6 + loopback + link-local (169.254.x.x) for cleanliness;
      // VPN tunnels and most LAN interfaces are IPv4 + a private range.
      if (entry.family !== 'IPv4') continue;
      if (entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      result.push(entry.address);
    }
  }
  // Dedupe + sort: stable order keeps the dropdown deterministic between
  // refreshes (otherwise interface enumeration order can flip).
  return Array.from(new Set(result)).sort();
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
