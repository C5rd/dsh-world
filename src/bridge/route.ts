import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonObject, knownHost, readBody, sendJson, type JsonResult } from '../http.ts';
import { HomeUnavailable, type Bridge } from './bridge.ts';

export const BRIDGE_PATH = '/dsh-world/bridge/say';
const MAX_BODY_BYTES = 32 * 1024;
const MAX_TEXT = 2000;
const bad: JsonResult = { status: 400, body: { error: 'bad request' } };
const unavailable: JsonResult = { status: 503, body: { error: 'home unavailable' } };

async function handleSay(bridge: Bridge | undefined, req: IncomingMessage, allowedHosts: readonly string[]): Promise<JsonResult> {
  if (req.method !== 'POST') return { status: 405, body: { error: 'method not allowed' }, headers: { allow: 'POST' } };
  const token = req.headers['x-dsh-world-token'];
  if (req.headers['sec-fetch-site'] === 'cross-site' || !knownHost(req.headers.host, allowedHosts)) return { status: 403, body: { error: 'forbidden' } };
  // While her world is stopped there is no bridge and no token to check against.
  if (!bridge) return unavailable;
  if (!bridge.checkToken(Array.isArray(token) ? undefined : token)) return { status: 403, body: { error: 'forbidden' } };
  const body = jsonObject(await readBody(req, MAX_BODY_BYTES));
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  const length = [...text].length;
  if (length < 1 || length > MAX_TEXT) return bad;
  try { return { status: 202, body: { accepted: true, id: (await bridge.say(text)).id } }; }
  catch (error) { return error instanceof HomeUnavailable ? unavailable : { status: 500, body: { error: 'internal error' } }; }
}
/** The one outside route that changes something: a local app hands her partner's words to her home. */
export function bridgeRoute(bridge: () => Bridge | undefined, allowedHosts: readonly string[] = []) {
  return {
    kind: 'exact' as const, path: BRIDGE_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      let result: JsonResult;
      try { result = await handleSay(bridge(), req, allowedHosts); } catch { result = { status: 500, body: { error: 'internal error' } }; }
      sendJson(res, result);
    },
  };
}
