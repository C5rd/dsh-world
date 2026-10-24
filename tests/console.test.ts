import assert from 'node:assert/strict';
import test from 'node:test';
import { consoleSources, estimateTokens } from '../src/console/snapshot.ts';
import { consoleRoute, handleConsole, type ConsoleSources } from '../src/console/routes.ts';

const sources: ConsoleSources = {
  snapshot: async () => ({ worldId: 'jingjing' }),
  activity: (day, outsideOnly) => [{ day, outsideOnly }],
  diary: date => date === '2026-10-23' ? '他去上班了。' : undefined,
};
test('console routes are read-only JSON views', async () => {
  assert.deepEqual(await handleConsole(sources, 'GET', '/dsh-world/console/snapshot'), { status: 200, body: { worldId: 'jingjing' } });
  assert.deepEqual(await handleConsole(sources, 'GET', '/dsh-world/console/activity?day=2026-10-23&outside=1'), { status: 200, body: [{ day: '2026-10-23', outsideOnly: true }] });
  assert.equal((await handleConsole(sources, 'GET', '/dsh-world/console/diary')).status, 404);
  assert.deepEqual(await handleConsole(sources, 'GET', '/dsh-world/console/diary?date=2026-10-23'), { status: 200, body: { date: '2026-10-23', text: '他去上班了。' } });
  assert.equal((await handleConsole(sources, 'GET', '/dsh-world/console/diary?date=2026-01-01')).status, 404);
  assert.equal((await handleConsole(sources, 'GET', '/dsh-world/console/wakes')).status, 404);
  assert.equal((await handleConsole(sources, 'POST', '/dsh-world/console/snapshot')).status, 405);
  assert.equal((await handleConsole(sources, 'GET', '/dsh-world/console/nope')).status, 404);
});
test('token estimate weights CJK characters separately', () => {
  assert.equal(estimateTokens('鲸鲸鲸鲸鲸'), 3);
  assert.equal(estimateTokens('abcdefg'), 2);
});
test('token estimate counts CJK punctuation and fullwidth forms as CJK', () => {
  assert.equal(estimateTokens('，。'), estimateTokens('鲸鲸'));
});
test('handleConsole edge cases', async () => {
  assert.equal((await handleConsole(sources, 'GET', '/dsh-worldX/console/snapshot')).status, 404);
  assert.equal((await handleConsole(sources, 'GET', '/other')).status, 404);
  assert.equal((await handleConsole(sources, 'GET', '/dsh-world/console/diary?date=../x')).status, 404);
  assert.deepEqual((await handleConsole(sources, 'POST', '/dsh-world/console/snapshot')).headers, { allow: 'GET' });
});
function fakeRes() {
  const out: { status?: number; headers?: Record<string, string>; body?: string } = {};
  return { out, res: { writeHead: (status: number, headers: Record<string, string>) => { out.status = status; out.headers = headers; }, end: (body: string) => { out.body = body; } } as never };
}
const run = async (src: ConsoleSources, req: { method?: string; url?: string; headers?: Record<string, string> }) => {
  const { out, res } = fakeRes();
  await consoleRoute(src).handler({ headers: {}, ...req } as never, res);
  return out;
};
test('consoleRoute sets JSON, no-store and no CORS headers', async () => {
  const out = await run(sources, { url: '/dsh-world/console/snapshot' });
  assert.equal(out.status, 200);
  assert.equal(out.headers!['content-type'], 'application/json; charset=utf-8');
  assert.equal(out.headers!['cache-control'], 'no-store');
  assert.ok(!Object.keys(out.headers!).some(k => k.toLowerCase() === 'access-control-allow-origin'));
  assert.deepEqual(JSON.parse(out.body!), { worldId: 'jingjing' });
});
test('consoleRoute rejects cross-site requests', async () => {
  const out = await run(sources, { url: '/dsh-world/console/snapshot', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(out.status, 403);
  assert.deepEqual(JSON.parse(out.body!), { error: 'cross-site requests are not allowed' });
  assert.equal((await run(sources, { url: '/dsh-world/console/snapshot', headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
});
test('consoleRoute hides errors behind a generic 500', async () => {
  const out = await run({ ...sources, snapshot: async () => { throw new Error('secret C:\path'); } }, { url: '/dsh-world/console/snapshot' });
  assert.equal(out.status, 500);
  assert.deepEqual(JSON.parse(out.body!), { error: 'internal error' });
  const sync = await run({ ...sources, diary: () => { throw new Error('boom'); } }, { url: '/dsh-world/console/diary?date=2026-10-23' });
  assert.equal(sync.body, '{"error":"internal error"}');
});
test('consoleRoute 405 carries Allow: GET', async () => {
  const out = await run(sources, { method: 'DELETE', url: '/dsh-world/console/snapshot' });
  assert.equal(out.status, 405);
  assert.equal(out.headers!.allow, 'GET');
});
test('the snapshot is cached and shared between concurrent polls', async () => {
  let computed = 0;
  const ctx = { agents: { get: () => undefined } };
  const life = { snapshot: () => { computed++; return { homeSessionId: undefined, alarm: undefined, faults: [] }; } };
  const store = { wakes: () => [], compactions: () => [], activityDays: () => [], activity: () => [] };
  const archive = { readPage: async () => ({ records: [], nextCursor: undefined }), readTurn: async () => [], stats: () => ({ records: 0, sessions: 0 }) };
  const src = consoleSources(ctx as never, { worldId: 'w', timeZone: 'UTC' } as never, archive as never, store as never, life as never, 'Z:/no/such/dir');
  const [a, b] = await Promise.all([src.snapshot(), src.snapshot()]);
  await src.snapshot();
  assert.equal(computed, 1);
  assert.equal(a, b);
  assert.equal((a as { memory: { windowTurns: number } }).memory.windowTurns, 200);
});
