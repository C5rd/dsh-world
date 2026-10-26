import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { QQ_PREFIX, WRITE_HEADER, qqRoute } from '../src/qq/route.ts';
import type { QqBridge } from '../src/qq/bridge.ts';

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
function stub(overrides: Partial<QqBridge> = {}): QqBridge {
  const base: QqBridge = {
    status: async () => ({ running: true, port: 3100, dir: 'D:/qq-bridge', dsh: true, sessions: [], faults: [], intent: { desired: 'running', at: 0, by: 'test' } }),
    start: async () => ({ started: true }),
    stop: async () => ({ stopped: true }),
    halt: async () => ({ stopped: true }),
    intent: () => ({ desired: 'running', at: 0, by: 'test' }),
    bind: async (key, sessionId) => ({ started: true, key, sessionId }),
    unbind: async key => ({ started: true, key }),
    ensureRunning: async () => ({ started: true }),
    syncEndpoint: async () => ({ changed: false }),
    faults: () => [],
  };
  return { ...base, ...overrides };
}
const route = (bridge: QqBridge) => qqRoute(bridge);

test('QQ 状态是 GET，五扇门都是一个前缀下面', async () => {
  const answered = await call(route(stub()), request('GET', '/'));
  assert.equal(answered.status, 200);
  assert.equal(answered.body.running, true);
  const shaped = qqRoute(stub());
  assert.deepEqual({ kind: shaped.kind, path: shaped.path }, { kind: 'prefix', path: '/dsh-world/qq' });
});

test('写操作必须带 x-dsh-world 头，跨站来的连读都不给', async () => {
  assert.equal((await call(route(stub()), request('POST', '/start'))).status, 400);
  assert.equal((await call(route(stub()), request('POST', '/start', { headers: { [WRITE_HEADER]: '1', 'sec-fetch-site': 'cross-site' } }))).status, 403);
  const ok = await call(route(stub()), request('POST', '/start', { headers: { [WRITE_HEADER]: '1' } }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.started, true);
  // 认不出来的路径是 404，不是把请求交给 console。
  assert.equal((await call(route(stub()), request('POST', '/nope', { headers: { [WRITE_HEADER]: '1' } }))).status, 404);
});

test('停桥和真停是两扇门：/stop 会重启，/halt 不会', async () => {
  const seen: string[] = [];
  const bridge = stub({
    stop: async () => { seen.push('stop'); return { stopped: true }; },
    halt: async () => { seen.push('halt'); return { stopped: true }; },
  });
  const headers = { [WRITE_HEADER]: '1' };
  assert.equal((await call(route(bridge), request('POST', '/halt', { headers }))).status, 200);
  assert.equal((await call(route(bridge), request('POST', '/stop', { headers }))).status, 200);
  assert.deepEqual(seen, ['halt', 'stop']);
});

test('绑定只接受 group:数字 和 private:数字，缺会话 id 直接拒', async () => {
  const seen: string[] = [];
  const bridge = stub({ bind: async (key, sessionId) => { seen.push(`${key}=${sessionId}`); return { started: false, key, sessionId }; } });
  const headers = { [WRITE_HEADER]: '1' };
  assert.equal((await call(route(bridge), request('POST', '/bind', { headers, body: { key: 'group:681528723' } }))).status, 400);
  assert.equal((await call(route(bridge), request('POST', '/bind', { headers, body: { key: 'someone', sessionId: 'session-1' } }))).status, 400);
  const ok = await call(route(bridge), request('POST', '/bind', { headers, body: { key: 'group:681528723', sessionId: 'session-1' } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(seen, ['group:681528723=session-1']);
});
test('两个控制台的地址是读接口：一个来自桥的令牌文件，一个要用面板密码现换', async () => {
  const doors = {
    qq: () => ({ url: 'http://127.0.0.1:3100/?token=tok' }),
    snowluma: async () => ({ needs: 'password' as const, url: 'http://127.0.0.1:5099' }),
    remember: async () => ({ url: 'http://127.0.0.1:5099/?token=abc' }),
    open: async () => ({ opened: true as const }),
  };
  const withDoors = await call(qqRoute(stub(), [], doors), request('GET', '/console'));
  assert.equal(withDoors.status, 200);
  assert.deepEqual(withDoors.body.qq, { url: 'http://127.0.0.1:3100/?token=tok' });
  assert.deepEqual(withDoors.body.snowluma, { needs: 'password', url: 'http://127.0.0.1:5099' });
  // 没接门的时候是老样子：说没有，不是 500。
  assert.equal((await call(route(stub()), request('GET', '/console'))).status, 404);
});

test('面板密码只走 POST，还得带 x-dsh-world 头；密码要是空的就别往磁盘上写', async () => {
  const seen: string[] = [];
  const doors = {
    qq: () => ({ url: 'http://127.0.0.1:3100/?token=tok' }),
    snowluma: async () => ({ needs: 'password' as const }),
    remember: async (username: string, password: string) => { seen.push(`${username || 'admin'}:${password}`); return { url: 'http://127.0.0.1:5099/?token=abc' }; },
    open: async () => ({ opened: true as const }),
  };
  const route_ = qqRoute(stub(), [], doors);
  const headers = { [WRITE_HEADER]: '1' };
  assert.equal((await call(route_, request('POST', '/panel-password', { body: { password: 'x' } }))).status, 400);
  assert.equal((await call(route_, request('POST', '/panel-password', { headers, body: { password: '' } }))).status, 400);
  const ok = await call(route_, request('POST', '/panel-password', { headers, body: { username: '', password: 'hunter2' } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.snowluma, { url: 'http://127.0.0.1:5099/?token=abc' });
  assert.deepEqual(seen, ['admin:hunter2']);
});
