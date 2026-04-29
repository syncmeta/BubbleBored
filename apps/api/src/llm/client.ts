import OpenAI from 'openai';
import type { ChatCompletionCreateParamsStreaming, ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { currentUserId } from '../core/request-context';
import { readOpenrouterByok, readOpenrouterBaseUrl } from '../core/byok';
import { assertQuota } from '../core/quota';

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;

// Typed as `any` because Bun's global fetch has an extra `preconnect` property
// that TS's stock `typeof fetch` doesn't know about — and the OpenAI SDK just
// needs something callable.
const proxyFetch: any = (url: any, init: any) => fetch(url, { ...init, proxy: proxyUrl } as any);

const SHARED_HEADERS = {
  'X-Title': 'PendingBot',
  'HTTP-Referer': 'https://pendingbot.app',
};

let platformClient: OpenAI;

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

function buildClient(apiKey: string | undefined, baseURL: string = OPENROUTER_BASE): OpenAI {
  return new OpenAI({
    baseURL,
    apiKey,
    defaultHeaders: SHARED_HEADERS,
    fetch: proxyUrl ? proxyFetch : undefined,
  });
}

// Resolve which OpenAI-compatible client this call should use. BYOK takes
// priority when the request has a user in context and that user has stored
// a key; users may also have stored a custom base URL (OpenAI directly,
// self-hosted gateway, etc.) — null means "fall back to OpenRouter".
// Otherwise fall through to the platform-funded singleton. When BYOK is
// active we DO NOT cache the per-user client — it's cheap to build and
// per-user instances would balloon memory linearly with active users.
export function getLlm(): OpenAI {
  const userId = currentUserId();
  if (userId) {
    const byok = readOpenrouterByok(userId);
    if (byok) {
      const customBase = readOpenrouterBaseUrl(userId) ?? OPENROUTER_BASE;
      return buildClient(byok, customBase);
    }
  }
  if (!platformClient) platformClient = buildClient(process.env.OPENROUTER_API_KEY);
  return platformClient;
}

// Gate every LLM call on the caller's quota. BYOK users skip the check.
// Calls outside any user context (background sweepers, etc.) skip too —
// those should not exist on the LLM path, but if they ever do we'd rather
// see the audit row than a phantom 402.
function preflight(): void {
  const userId = currentUserId();
  if (!userId) return;
  assertQuota(userId);
}

export async function chatCompletion(
  params: Omit<ChatCompletionCreateParamsNonStreaming, 'stream'>
) {
  preflight();
  const start = Date.now();
  const res = await getLlm().chat.completions.create({ ...params, stream: false });
  const latencyMs = Date.now() - start;
  return {
    result: res,
    latencyMs,
    generationId: res.id,
    costUsd: (res.usage as any)?.cost as number | undefined,
  };
}

export async function chatCompletionStream(
  params: Omit<ChatCompletionCreateParamsStreaming, 'stream'>
) {
  preflight();
  const start = Date.now();
  const stream = await getLlm().chat.completions.create({
    ...params,
    stream: true,
    stream_options: { include_usage: true },
  });
  return { stream, startTime: start };
}
