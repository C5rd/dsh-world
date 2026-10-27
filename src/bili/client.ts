/**
 * client.ts —— B 站只读接口
 *
 * 只做一件事：把平台上公开的东西取回来，不做判断，也不生成感想。
 *
 * 三条自我约束写在这里，因为将来读这个文件的人（很可能是我）会想加「顺手点个赞」：
 *   1. **不带 cookie**。她看什么都不会留下账号痕迹。
 *   2. **只读**。不发 POST，不点赞、不投币、不发评论。这个文件里没有写操作的代码路径。
 *   3. **串行 + 抖动**。并发和固定节奏最像机器人，也最容易把 IP 刷红。
 *
 * 风控码（-352 请求被拦截 / -412 被限制 / -509 请求过多）一旦出现就冷却半小时：
 * 少看几条不算故障，被拉黑一阵才是。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const API = 'https://api.bilibili.com';
const RISK_CODES = new Set([-352, -412, -509]);
const COOLDOWN_MS = 30 * 60_000;
const MIN_GAP_MS = 800;
const JITTER_MS = 500;
const TIMEOUT_MS = 12_000;
const CACHE_MS = 10 * 60_000;

export interface Reply {
  ok: boolean;
  code?: number | string;
  message?: string;
  data?: any;
}

export interface Video {
  bvid: string;
  aid: number;
  title: string;
  up: string;
  play: number;
  danmaku: number;
  duration: number;
  pubdate: number;
  desc: string;
  pic: string;
  tid?: number;
  tname?: string;
}

export interface Comment {
  user: string;
  like: number;
  message: string;
}

let lastAt = 0;
let chain: Promise<unknown> = Promise.resolve();
let riskUntil = 0;
const cache = new Map<string, { at: number; value: Reply }>();

/** 测试用：换掉 fetch，走真实的限流与熔断逻辑，只是不发网络请求。 */
let fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init);
export function setFetch(fn?: typeof fetch): void {
  fetchImpl = fn ?? ((input, init) => globalThis.fetch(input, init));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 所有请求排队：串行、最小间隔、加随机抖动。 */
function throttle<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.then(async () => {
    const gap = MIN_GAP_MS + Math.floor(Math.random() * JITTER_MS);
    const wait = gap - (Date.now() - lastAt);
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    return run();
  });
  chain = next.catch(() => undefined);
  return next;
}

export function inCooldown(now = Date.now()): boolean {
  return now < riskUntil;
}

export function cooldownLeft(now = Date.now()): number {
  return Math.max(0, riskUntil - now);
}

export function resetRisk(): void {
  riskUntil = 0;
}

export function clearCache(): void {
  cache.clear();
}

async function request(path: string, params: Record<string, string | number> = {}): Promise<Reply> {
  const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
  const url = `${API}${path}${query ? `?${query}` : ''}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  if (inCooldown()) return { ok: false, code: 'COOLDOWN', message: '平台风控冷却中，先不请求。' };

  let value: Reply;
  try {
    value = await throttle(async () => {
      const control = new AbortController();
      const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          signal: control.signal,
          headers: {
            'user-agent': UA,
            referer: 'https://www.bilibili.com/',
            accept: 'application/json, text/plain, */*',
            'accept-language': 'zh-CN,zh;q=0.9',
          },
        });
        const body = await response.text();
        let parsed: any;
        try {
          parsed = JSON.parse(body);
        } catch {
          return { ok: false, code: 'BAD_JSON', message: `返回的不是 JSON（HTTP ${response.status}）` };
        }
        if (parsed?.code !== 0) {
          if (RISK_CODES.has(parsed?.code)) riskUntil = Date.now() + COOLDOWN_MS;
          return { ok: false, code: parsed?.code, message: String(parsed?.message ?? parsed?.code) };
        }
        return { ok: true, code: 0, data: parsed?.data };
      } finally {
        clearTimeout(timer);
      }
    });
  } catch (error) {
    value = { ok: false, code: 'NETWORK', message: error instanceof Error ? error.message : String(error) };
  }

  if (value.ok || (typeof value.code === 'number' && !RISK_CODES.has(value.code))) {
    cache.set(url, { at: Date.now(), value });
  }
  return value;
}

/** 归一：热门与排行、详情与相关推荐的字段名不完全一样。 */
export function toVideo(raw: any): Video {
  return {
    bvid: String(raw?.bvid ?? ''),
    aid: Number(raw?.aid ?? raw?.id ?? 0),
    title: String(raw?.title ?? ''),
    up: String(raw?.owner?.name ?? raw?.author ?? ''),
    play: Number(raw?.stat?.view ?? raw?.play ?? 0),
    danmaku: Number(raw?.stat?.danmaku ?? raw?.video_review ?? 0),
    duration: Number(raw?.duration ?? 0) || parseDuration(String(raw?.length ?? '')),
    pubdate: Number(raw?.pubdate ?? raw?.created ?? 0),
    desc: String(raw?.desc ?? '').trim(),
    pic: String(raw?.pic ?? ''),
    ...(raw?.tid ? { tid: Number(raw.tid) } : {}),
    ...(raw?.tname ? { tname: String(raw.tname) } : {}),
  };
}

function parseDuration(text: string): number {
  const parts = text.split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export async function popular(limit = 20): Promise<{ ok: boolean; message?: string; list: Video[] }> {
  const reply = await request('/x/web-interface/popular', { ps: Math.min(50, Math.max(1, limit)), pn: 1 });
  if (!reply.ok) return { ok: false, message: describe(reply), list: [] };
  const list = Array.isArray(reply.data?.list) ? reply.data.list.map(toVideo) : [];
  return { ok: true, list };
}

export async function ranking(limit = 20): Promise<{ ok: boolean; message?: string; list: Video[] }> {
  const reply = await request('/x/web-interface/ranking/v2', { rid: 0, type: 'all' });
  if (!reply.ok) return { ok: false, message: describe(reply), list: [] };
  const list = Array.isArray(reply.data?.list) ? reply.data.list.slice(0, limit).map(toVideo) : [];
  return { ok: true, list };
}

export async function precious(limit = 20): Promise<{ ok: boolean; message?: string; list: Video[] }> {
  const reply = await request('/x/web-interface/popular/precious', { ps: Math.min(50, Math.max(1, limit)), pn: 1 });
  if (!reply.ok) return { ok: false, message: describe(reply), list: [] };
  const list = Array.isArray(reply.data?.list) ? reply.data.list.map(toVideo) : [];
  return { ok: true, list };
}

export async function video(bvid: string): Promise<{ ok: boolean; message?: string; video?: Video; tags: string[]; cid: number }> {
  const reply = await request('/x/web-interface/view', { bvid });
  if (!reply.ok) return { ok: false, message: describe(reply), tags: [], cid: 0 };
  const item = toVideo(reply.data);
  const tagReply = await request('/x/tag/archive/tags', { bvid });
  const tags = Array.isArray(tagReply.data) ? tagReply.data.map((tag: any) => String(tag?.tag_name ?? '')).filter(Boolean) : [];
  return { ok: true, video: item, tags, cid: Number(reply.data?.cid ?? 0) };
}

export async function comments(aid: number, limit = 10): Promise<{ ok: boolean; message?: string; list: Comment[] }> {
  const reply = await request('/x/v2/reply', { type: 1, oid: aid, sort: 2, ps: Math.min(20, Math.max(1, limit)), pn: 1 });
  if (!reply.ok) return { ok: false, message: describe(reply), list: [] };
  const list = Array.isArray(reply.data?.replies)
    ? reply.data.replies.slice(0, limit).map((item: any) => ({
        user: String(item?.member?.uname ?? ''),
        like: Number(item?.like ?? 0),
        message: String(item?.content?.message ?? '').replace(/\s+/g, ' ').trim(),
      }))
    : [];
  return { ok: true, list };
}

export async function related(bvid: string, limit = 20): Promise<{ ok: boolean; message?: string; list: Video[] }> {
  const reply = await request('/x/web-interface/archive/related', { bvid });
  if (!reply.ok) return { ok: false, message: describe(reply), list: [] };
  const list = Array.isArray(reply.data) ? reply.data.slice(0, limit).map(toVideo) : [];
  return { ok: true, list };
}

function describe(reply: Reply): string {
  if (reply.code === 'COOLDOWN') return '平台风控冷却中，这一会儿看不见东西。';
  if (reply.code === 'NETWORK') return `没连上：${reply.message ?? '网络'}`;
  return `${reply.message ?? '平台没给'}（code ${reply.code}）`;
}

/** 128.4万 / 3.2亿 —— 只做单位换算，不评价。 */
/** 播放直链。匿名也能拿到，只是清晰度受平台给的档位限制。 */
export async function playurl(bvid: string, cid: number): Promise<{ ok: boolean; message?: string; url: string; quality: number }> {
  const reply = await request('/x/player/playurl', { bvid, cid, qn: 64, fnval: 16, fourk: 0 });
  if (!reply.ok) return { ok: false, message: reply.message, url: '', quality: 0 };
  const tracks = reply.data?.dash?.video ?? [];
  const url = String(tracks[0]?.baseUrl ?? tracks[0]?.base_url ?? reply.data?.durl?.[0]?.url ?? '');
  if (!url) return { ok: false, message: '这条没有可拉取的直链', url: '', quality: 0 };
  return { ok: true, url, quality: Number(reply.data?.quality ?? 0) };
}

export function humanCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return String(Math.round(value));
}

/** 12:34 / 1:02:03 */
export function humanDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds);
  const hour = Math.floor(total / 3600);
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hour ? `${hour}:${pad(minute)}:${pad(second)}` : `${minute}:${pad(second)}`;
}
