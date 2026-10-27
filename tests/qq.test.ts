import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { QQ_PREFIX, WRITE_HEADER, qqRoute } from '../src/ecosystem/qq/route.ts';
import type { ConsoleDoors } from '../src/ecosystem/qq/panel.ts';

function request(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
  const text = options.body === undefined ? '' : JSON.stringify(options.body);
  const stream = Readable.from(text ? [Buffer.from(text)] : []);
  return Object.assign(stream, { method, url: QQ_PREFIX + path, headers: { host: '127.0.0.1:1707', ...options.headers } }) as never;
}
async function call(route: ReturnType<typeof qqRoute>, req: never) {
  let status = 0;
  let body = '';
  const res = { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; }, setHeader: () => {}, getHeader: () => undefined, headersSent: false } as never;
  await route.handler(req, res);
  return { status, body: body ? JSON.parse(body) : undefined };
}
/** 两扇门只剩 SnowLuma 一扇（外面那个 qq-bridge 的门口在 2026-10-27 拆掉了）。 */
function doors(overrides: Partial<ConsoleDoors> = {}): ConsoleDoors {
  return {
    snowluma: async () => ({ needs: 'password' as const, url: 'http://127.0.0.1:5099' }),
    remember: async () => ({ url: 'http://127.0.0.1:5099/?token=abc' }),
    open: async () => ({ opened: true as const }),
    ...overrides,
  };
}
const native = () => ({ connected: true, url: 'ws://127.0.0.1:3003', autoReply: false, proactive: null });
const WRITE = { [WRITE_HEADER]: '1' };

test('QQ 前缀下：状态是 GET，认不出来的路径是 404', async () => {
  const route = qqRoute([], doors(), native, () => ({ ok: true }));
  assert.deepEqual({ kind: route.kind, path: route.path }, { kind: 'prefix', path: '/dsh-world/qq' });
  const answered = await call(route, request('GET', '/native'));
  assert.equal(answered.status, 200);
  assert.equal(answered.body.connected, true);
  // 不认识的路径不该被当成 console：POST 落到写表里没有 → 404；GET 只有 /native 与 /console 两扇门 → 405。
  assert.equal((await call(route, request('POST', '/nope', { headers: WRITE }))).status, 404);
  assert.equal((await call(route, request('GET', '/nope'))).status, 405);
  // 桥那几扇门（/start /stop /halt /bind /unbind /proactive）连同桥一起没了，别再留后门。
  for (const path of ['/start', '/stop', '/halt', '/bind', '/unbind', '/proactive']) {
    const gone = await call(route, request('POST', path, { headers: WRITE }));
    assert.ok(gone.status === 404 || gone.status === 405, `${path} 应该是 404 或 405，实际 ${gone.status}`);
  }
});

test('写操作必须带 x-dsh-world 头，跨站来的连读都不给', async () => {
  const route = qqRoute([], doors(), native, () => ({ ok: true }));
  assert.equal((await call(route, request('POST', '/native', { body: { autoReply: true } }))).status, 400);
  assert.equal((await call(route, request('POST', '/native', { headers: { ...WRITE, 'sec-fetch-site': 'cross-site' }, body: { autoReply: true } }))).status, 403);
  assert.equal((await call(route, request('POST', '/native', { headers: WRITE, body: { autoReply: true } }))).status, 200);
});

test('原生通道没有接上时，写接口说清楚，而不是静默成功', async () => {
  const route = qqRoute([], doors(), undefined, undefined);
  assert.equal((await call(route, request('GET', '/native'))).status, 200);
  assert.equal((await call(route, request('GET', '/native'))).body, null);
  const welp = await call(route, request('POST', '/native', { headers: WRITE, body: { autoReply: true } }));
  assert.equal(welp.status, 400);
  assert.match(String(welp.body.error), /没有接上/);
});

test('控制台的地址是读接口：SnowLuma 那扇门要用面板密码现换', async () => {
  const route = qqRoute([], doors(), native, () => ({ ok: true }));
  const read = await call(route, request('GET', '/console'));
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.snowluma, { needs: 'password', url: 'http://127.0.0.1:5099' });
  // 桥那扇门不再存在，所以返回体里也没有 qq。
  assert.equal('qq' in read.body, false);
  // 没接门的时候：说没有，不是 500。
  assert.equal((await call(qqRoute([], undefined, native), request('GET', '/console'))).status, 404);
});

test('/open 只认 SnowLuma 那一扇门', async () => {
  const opened: string[] = [];
  const route = qqRoute([], doors({ open: async kind => { opened.push(kind); return { opened: true as const }; } }), native, () => ({ ok: true }));
  const bad = await call(route, request('POST', '/open', { headers: WRITE, body: { kind: 'qq' } }));
  assert.equal(bad.status, 400);
  assert.equal((await call(route, request('POST', '/open', { headers: WRITE, body: { kind: 'snowluma' } }))).status, 200);
  assert.deepEqual(opened, ['snowluma']);
});

test('面板密码只走 POST，还得带 x-dsh-world 头；密码要是空的就别往磁盘上写', async () => {
  const seen: string[] = [];
  const route = qqRoute([], doors({
    remember: async (username: string, password: string) => { seen.push(`${username || 'admin'}:${password}`); return { url: 'http://127.0.0.1:5099/?token=abc' }; },
  }), native, () => ({ ok: true }));
  assert.equal((await call(route, request('POST', '/panel-password', { body: { password: 'x' } }))).status, 400);
  assert.equal((await call(route, request('POST', '/panel-password', { headers: WRITE, body: { password: '' } }))).status, 400);
  const ok = await call(route, request('POST', '/panel-password', { headers: WRITE, body: { username: '', password: 'hunter2' } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.snowluma, { url: 'http://127.0.0.1:5099/?token=abc' });
  assert.deepEqual(seen, ['admin:hunter2']);
});

test('原生通道的两个主动开口开关：认布尔、别的一律拒、只转认识的字段', async () => {
  const seen: { autoReply?: boolean; proactive?: { enabled?: boolean; dryRun?: boolean } }[] = [];
  const route = qqRoute([], doors(), native, patch => { seen.push(patch); return { ok: true }; });

  // 什么都没给：拒（不然就是一个静默的空写）
  assert.equal((await call(route, request('POST', '/native', { headers: WRITE, body: {} }))).status, 400);
  // proactive 的形状不对：全拒
  assert.equal((await call(route, request('POST', '/native', { headers: WRITE, body: { proactive: {} } }))).status, 400);
  assert.equal((await call(route, request('POST', '/native', { headers: WRITE, body: { proactive: 'yes' } }))).status, 400);
  assert.equal((await call(route, request('POST', '/native', { headers: WRITE, body: { proactive: [] } }))).status, 400);
  assert.equal((await call(route, request('POST', '/native', { headers: WRITE, body: { proactive: { enabled: 'yes' } } }))).status, 400);
  assert.equal((await call(route, request('POST', '/native', { headers: WRITE, body: { proactive: { dryRun: 1 } } }))).status, 400);

  // 好好给：转过去，多余的字段不透传
  assert.equal((await call(route, request('POST', '/native', { headers: WRITE, body: { autoReply: true } }))).status, 200);
  assert.equal((await call(route, request('POST', '/native', { headers: WRITE, body: { proactive: { enabled: true, dryRun: true } } }))).status, 200);
  assert.equal((await call(route, request('POST', '/native', { headers: WRITE, body: { autoReply: false, proactive: { enabled: false }, 多余的: 1 } }))).status, 200);
  assert.deepEqual(seen, [
    { autoReply: true },
    { proactive: { enabled: true, dryRun: true } },
    { autoReply: false, proactive: { enabled: false } },
  ]);
});