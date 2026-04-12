import OpenAI from 'openai';
import type { ChatCompletionCreateParamsStreaming, ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;

const proxyFetch: typeof globalThis.fetch = (url, init) => {
  return fetch(url, { ...init, proxy: proxyUrl } as any);
};

let client: OpenAI;

export function getLlm(): OpenAI {
  if (!client) {
    client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
      defaultHeaders: {
        'X-Title': 'BeyondBubble',
        'HTTP-Referer': 'https://beyondbubble.app',
      },
      fetch: proxyUrl ? proxyFetch : undefined,
    });
  }
  return client;
}

export async function chatCompletion(
  params: Omit<ChatCompletionCreateParamsNonStreaming, 'stream'>
) {
  const start = Date.now();
  const res = await getLlm().chat.completions.create({ ...params, stream: false });
  const latencyMs = Date.now() - start;
  return { result: res, latencyMs, generationId: res.id };
}

export async function chatCompletionStream(
  params: Omit<ChatCompletionCreateParamsStreaming, 'stream'>
) {
  const start = Date.now();
  const stream = await getLlm().chat.completions.create({
    ...params,
    stream: true,
    stream_options: { include_usage: true },
  });
  return { stream, startTime: start };
}

export async function fetchGenerationStats(generationId: string): Promise<{
  totalCost?: number;
  upstreamCost?: number;
  generationTimeMs?: number;
} | null> {
  try {
    await Bun.sleep(2000);
    const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${generationId}`, {
      headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
      proxy: proxyUrl,
    } as any);
    if (!res.ok) return null;
    const data = await res.json() as any;
    return {
      totalCost: data.data?.total_cost,
      upstreamCost: data.data?.upstream_inference_cost,
      generationTimeMs: data.data?.generation_time,
    };
  } catch {
    return null;
  }
}
