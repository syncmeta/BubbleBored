// Lightweight weather hook. The user (per memory: UI-first config) will set
// city + provider via the 你 tab in a future iteration. For now we read env
// vars and return '' when unconfigured so the perception block degrades
// gracefully.
//
// Supported providers (env-driven, no hard dep):
//   WEATHER_CITY=上海
//   WEATHER_PROVIDER=open-meteo  (default; needs no API key)
//   WEATHER_LAT=31.23  WEATHER_LON=121.47  (optional override of city geocode)

interface CacheEntry { value: string; expiresAt: number; }
let cache: CacheEntry | null = null;
const TTL_MS = 30 * 60_000;

const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
const proxyFetch: any = (url: any, init: any) =>
  fetch(url, { ...(init ?? {}), proxy: PROXY } as any);
const fetchFn: any = PROXY ? proxyFetch : fetch;

async function geocode(city: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const res = await fetchFn(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`,
    );
    const data = await res.json();
    const r = data?.results?.[0];
    if (!r) return null;
    return { lat: r.latitude, lon: r.longitude };
  } catch {
    return null;
  }
}

const WMO_TO_LABEL: Record<number, string> = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '雾', 48: '雾',
  51: '小毛雨', 53: '中毛雨', 55: '大毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪',
  77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨', 99: '强雷雨',
};

export async function getWeather(): Promise<string> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  const city = process.env.WEATHER_CITY;
  let lat = process.env.WEATHER_LAT ? parseFloat(process.env.WEATHER_LAT) : undefined;
  let lon = process.env.WEATHER_LON ? parseFloat(process.env.WEATHER_LON) : undefined;

  if ((!lat || !lon) && city) {
    const coords = await geocode(city);
    if (coords) { lat = coords.lat; lon = coords.lon; }
  }
  if (!lat || !lon) {
    cache = { value: '', expiresAt: Date.now() + TTL_MS };
    return '';
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`;
    const res = await fetchFn(url);
    const data = await res.json();
    const temp = data?.current?.temperature_2m;
    const code = data?.current?.weather_code;
    const label = WMO_TO_LABEL[code] ?? `天气码 ${code}`;
    const value = city
      ? `${city} / ${label} ${typeof temp === 'number' ? temp.toFixed(0) + '°' : ''}`.trim()
      : `${label} ${typeof temp === 'number' ? temp.toFixed(0) + '°' : ''}`.trim();
    cache = { value, expiresAt: Date.now() + TTL_MS };
    return value;
  } catch (e) {
    cache = { value: '', expiresAt: Date.now() + TTL_MS };
    return '';
  }
}
