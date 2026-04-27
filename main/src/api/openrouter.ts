import { Hono } from 'hono';

// Slim shape sent to the picker — we strip OpenRouter's verbose fields and
// only keep what the UI needs to render and search.
//
// `input_modalities` mirrors OpenRouter's architecture.input_modalities
// (e.g. ["text"], ["text","image"], ["text","image","audio"]). The web UI
// uses this to decide whether image upload is allowed for a given bot.
// `supported_parameters` is a coarse capability list (e.g. "tools",
// "reasoning") used for capability badges in the model picker.
type SlimModel = {
  slug: string;
  display_name: string;
  provider: string;
  context_length: number | null;
  pricing: { prompt: string | null; completion: string | null };
  input_modalities: string[];
  output_modalities: string[];
  supported_parameters: string[];
};

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
const TTL_MS = 10 * 60 * 1000;

let cache: { at: number; data: SlimModel[] } | null = null;
let inflight: Promise<SlimModel[]> | null = null;

async function fetchModels(): Promise<SlimModel[]> {
  const init: any = { headers: { Accept: 'application/json' } };
  if (proxyUrl) init.proxy = proxyUrl;
  const res = await fetch('https://openrouter.ai/api/v1/models', init);
  if (!res.ok) throw new Error(`openrouter /models -> ${res.status}`);
  const body = (await res.json()) as { data?: any[] };
  const list = Array.isArray(body?.data) ? body.data : [];
  const slim = list.map((m: any): SlimModel => {
    const slug: string = String(m?.id ?? '');
    const arch = m?.architecture ?? {};
    const inputs = Array.isArray(arch.input_modalities) ? arch.input_modalities.map(String) : ['text'];
    const outputs = Array.isArray(arch.output_modalities) ? arch.output_modalities.map(String) : ['text'];
    const params = Array.isArray(m?.supported_parameters) ? m.supported_parameters.map(String) : [];
    return {
      slug,
      display_name: String(m?.name ?? slug),
      provider: slug.split('/')[0] ?? 'unknown',
      context_length: typeof m?.context_length === 'number' ? m.context_length : null,
      pricing: {
        prompt: m?.pricing?.prompt ?? null,
        completion: m?.pricing?.completion ?? null,
      },
      input_modalities: inputs,
      output_modalities: outputs,
      supported_parameters: params,
    };
  }).filter(m => m.slug);
  slim.sort((a, b) =>
    a.provider.localeCompare(b.provider) || a.display_name.localeCompare(b.display_name)
  );
  return slim;
}

export const openrouterRoutes = new Hono();

openrouterRoutes.get('/models', async (c) => {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return c.json(cache.data);
  if (!inflight) {
    inflight = fetchModels()
      .then(data => { cache = { at: Date.now(), data }; return data; })
      .finally(() => { inflight = null; });
  }
  try {
    const data = await inflight;
    return c.json(data);
  } catch (e: any) {
    if (cache) return c.json(cache.data);
    return c.json({ error: e?.message ?? 'fetch failed' }, 503);
  }
});
