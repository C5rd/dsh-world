import type { IncomingMessage, ServerResponse } from 'node:http';
import { HomeUnavailable, type Bridge } from './bridge.ts';

export const BRIDGE_PATH = '/dsh-world/bridge/say';
const MAX_BODY_BYTES = 32 * 1024;
const MAX_TEXT = 2000;
type Result = { status: number; body: unknown; headers?: Record<string, string> };
const bad: Result = { status: 400, body: { error: 'bad request' } };

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    // Keep draining so the client sees the answer, but stop collecting.
    if (size <= MAX_BODY_BYTES) chunks.push(buffer);
  }
  return size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks).toString('utf8');
}
async function handleSay(bridge: Bridge, req: IncomingMessage): Promise<Result> {
  if (req.method !== 'POST') return { status: 405, body: { error: 'method not allowed' }, headers: { allow: 'POST' } };
  const token = req.headers['x-dsh-world-token'];
  if (req.headers['sec-fetch-site'] === 'cross-site' || !bridge.checkToken(Array.isArray(token) ? undefined : token)) return { status: 403, body: { error: 'forbidden' } };
  const raw = await readBody(req);
  if (raw === undefined) return bad;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return bad; }
  const text = parsed && typeof parsed === 'object' && typeof (parsed as { text?: unknown }).text === 'string' ? (parsed as { text: string }).text.trim() : '';
  const length = [...text].length;
  if (length < 1 || length > MAX_TEXT) return bad;
  try { return { status: 202, body: { accepted: true, id: (await bridge.say(text)).id } }; }
  catch (error) { return error instanceof HomeUnavailable ? { status: 503, body: { error: 'home unavailable' } } : { status: 500, body: { error: 'internal error' } }; }
}
/** The one route that changes something: a local app hands her partner's words to her home. */
export function bridgeRoute(bridge: Bridge) {
  return {
    kind: 'exact' as const, path: BRIDGE_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      let result: Result;
      try { result = await handleSay(bridge, req); } catch { result = { status: 500, body: { error: 'internal error' } }; }
      res.writeHead(result.status, { ...result.headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result.body));
    },
  };
}
