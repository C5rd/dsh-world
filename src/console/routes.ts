import type { IncomingMessage, ServerResponse } from 'node:http';

export const CONSOLE_PREFIX = '/dsh-world';
export interface ConsoleSources {
  snapshot(): Promise<unknown>;
  activity(day: string, outsideOnly: boolean): unknown;
  diaryDates(): string[];
  diary(date: string): string | undefined;
  wakes(limit: number): unknown;
  compactions(limit: number): unknown;
}
export interface ConsoleResult { status: number; body: unknown; headers?: Record<string, string> }
const limitOf = (url: URL) => { const raw = url.searchParams.get('limit') ?? ''; const n = /^\d+$/.test(raw) ? Number(raw) : 0; return n < 1 ? 20 : Math.min(200, n); };

/** Every route only reads; nothing here changes her life or memory. */
export async function handleConsole(sources: ConsoleSources, method: string, rawUrl: string): Promise<ConsoleResult> {
  const url = new URL(rawUrl, 'http://localhost');
  if (url.pathname !== CONSOLE_PREFIX && !url.pathname.startsWith(CONSOLE_PREFIX + '/')) return { status: 404, body: { error: 'not found' } };
  if (method !== 'GET') return { status: 405, body: { error: 'the world console is read-only' }, headers: { allow: 'GET' } };
  switch (url.pathname.slice(CONSOLE_PREFIX.length)) {
    case '/console/snapshot': return { status: 200, body: await sources.snapshot() };
    case '/console/activity': return { status: 200, body: sources.activity(url.searchParams.get('day') ?? '', url.searchParams.get('outside') === '1') };
    case '/console/diary': {
      const date = url.searchParams.get('date');
      if (!date) return { status: 200, body: { dates: sources.diaryDates() } };
      const text = sources.diary(date);
      return text === undefined ? { status: 404, body: { error: 'no diary for this date' } } : { status: 200, body: { date, text } };
    }
    case '/console/wakes': return { status: 200, body: sources.wakes(limitOf(url)) };
    case '/console/compactions': return { status: 200, body: sources.compactions(limitOf(url)) };
    default: return { status: 404, body: { error: 'not found' } };
  }
}
export function consoleRoute(sources: ConsoleSources) {
  return {
    kind: 'prefix' as const, path: CONSOLE_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      let status: number, payload: unknown, extra: Record<string, string> = {};
      try {
        if (req.headers['sec-fetch-site'] === 'cross-site') { status = 403; payload = { error: 'cross-site requests are not allowed' }; }
        else { const result = await handleConsole(sources, req.method ?? 'GET', req.url ?? '/'); status = result.status; payload = result.body; extra = result.headers ?? {}; }
      } catch {
        status = 500; payload = { error: 'internal error' }; extra = {};
      }
      res.writeHead(status, { ...extra, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
    },
  };
}
