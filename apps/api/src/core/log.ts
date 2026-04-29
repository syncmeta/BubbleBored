import { createHash } from 'crypto';

// Logging helpers that strip user content out of stdout in production. The
// stdout stream goes to Fly.io's persistent, searchable log store — having
// user message content there is a privacy/compliance footgun. In dev we keep
// the preview because grepping the live conversation is genuinely useful for
// debugging the orchestrator.
//
// Enable in prod with LOG_VERBOSE_CONTENT=1 (e.g. for a short on-call window).

const VERBOSE = (() => {
  const raw = process.env.LOG_VERBOSE_CONTENT;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  // Default: verbose only in dev. Treat anything that smells like prod
  // (NODE_ENV=production, or running on Fly) as the privacy-default.
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.FLY_APP_NAME) return false;
  return true;
})();

/**
 * Render a user-content snippet for logs. In verbose mode, returns up to
 * `maxChars` of the raw text. Otherwise returns a stable hash + length, e.g.
 * `<len=42 sha=a1b2c3>`. The hash is unsalted but the input is whatever the
 * user typed — fine for dedup/correlation, not for any kind of integrity claim.
 */
export function logContent(content: string, maxChars = 80): string {
  if (VERBOSE) {
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars) + '…';
  }
  const sha = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 6);
  return `<len=${content.length} sha=${sha}>`;
}

/** True if verbose content logging is on — exposed for callers that build
 *  more elaborate previews (e.g. multi-entry joins). */
export function logVerbose(): boolean {
  return VERBOSE;
}
