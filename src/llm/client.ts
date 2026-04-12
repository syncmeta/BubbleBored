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
        'X-Title': 'BubbleBored',
        'HTTP-Referer': 'https://bubblebored.app',
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
  const start = Date.now();
  const stream = await getLlm().chat.completions.create({
    ...params,
    stream: true,
    stream_options: { include_usage: true },
  });
  return { stream, startTime: start };
}
