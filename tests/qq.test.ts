import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { QQ_PREFIX, WRITE_HEADER, qqRoute } from '../src/ecosystem/qq/route.ts';
import type { QqBridge } from '../src/ecosystem/qq/bridge.ts';

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
    proactive: async () => ({ enabled: false, dryRun: true, running: false }),
    setProactive: async patch => ({ ok: true, config: patch }),
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
test('主动联系的两个开关走 POST，只认布尔，多余字段不给桥', async () => {
  const seen: unknown[] = [];
  const bridge = stub({ setProactive: async patch => { seen.push(patch); return { ok: true, config: patch }; } });
  const headers = { [WRITE_HEADER]: '1' };
  // 一个布尔都没给，就没得改
  assert.equal((await call(route(bridge), request('POST', '/proactive', { headers, body: {} }))).status, 400);
  assert.equal((await call(route(bridge), request('POST', '/proactive', { headers, body: { enabled: 'yes' } }))).status, 400);
  // 只带一个就只改那一个；policy 这种不是开关的东西不转发
  assert.equal((await call(route(bridge), request('POST', '/proactive', { headers, body: { enabled: true } }))).status, 200);
  assert.equal((await call(route(bridge), request('POST', '/proactive', { headers, body: { dryRun: false, policy: { maxPerDay: 99 } } }))).status, 200);
  assert.deepEqual(seen, [{ enabled: true }, { dryRun: false }]);
});
test('开口概率走滑块：0–1 之外当场拒绝，0 和 1 都算给了', async () => {
  const seen: unknown[] = [];
  const bridge = stub({ setProactive: async patch => { seen.push(patch); return { ok: true, config: patch }; } });
  const headers = { [WRITE_HEADER]: '1' };
  const post = (body: Record<string, unknown>) => call(route(bridge), request('POST', '/proactive', { headers, body }));
  assert.equal((await post({ probability: 1.5 })).status, 400);
  assert.equal((await post({ probability: -0.1 })).status, 400);
  assert.equal((await post({ probability: '经常' })).status, 400);
  assert.equal((await post({ probability: 0.35 })).status, 200);
  assert.deepEqual(seen, [{ policy: { sendProbability: 0.35 } }]);
  // 0 和 1 都是合法值，不能当成「没给」而被 400 掉
  assert.equal((await post({ probability: 0 })).status, 200);
  assert.equal((await post({ probability: 1 })).status, 200);
  assert.deepEqual(seen.slice(1), [{ policy: { sendProbability: 0 } }, { policy: { sendProbability: 1 } }]);
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

test('原生通道的两个主动开口开关：认布尔、别的一律拒、只转认识的字段', async () => {
  const headers = { [WRITE_HEADER]: '1' };
  const seen: { autoReply?: boolean; proactive?: { enabled?: boolean; dryRun?: boolean } }[] = [];
  const withNative = qqRoute(stub(), [], undefined, () => ({ autoReply: false, proactive: null }), patch => { seen.push(patch); return { ok: true }; });

  // 什么都没给：拒（不然就是一个静默的空写）
  assert.equal((await call(withNative, request('POST', '/native', { headers, body: {} }))).status, 400);
  // proactive 的形状不对：全拒
  assert.equal((await call(withNative, request('POST', '/native', { headers, body: { proactive: {} } }))).status, 400);
  assert.equal((await call(withNative, request('POST', '/native', { headers, body: { proactive: 'yes' } }))).status, 400);
  assert.equal((await call(withNative, request('POST', '/native', { headers, body: { proactive: [] } }))).status, 400);
  assert.equal((await call(withNative, request('POST', '/native', { headers, body: { proactive: { enabled: 'yes' } } }))).status, 400);
  assert.equal((await call(withNative, request('POST', '/native', { headers, body: { proactive: { dryRun: 1 } } }))).status, 400);
  // 宿主半侧没接上：也说清楚
  const welp = await call(route(stub()), request('POST', '/native', { headers, body: { autoReply: true } }));
  assert.equal(welp.status, 400);
  assert.match(String(welp.body.error), /没有接上/);

  // 好好给：转过去
  assert.equal((await call(withNative, request('POST', '/native', { headers, body: { autoReply: true } }))).status, 200);
  assert.equal((await call(withNative, request('POST', '/native', { headers, body: { proactive: { enabled: true, dryRun: true } } }))).status, 200);
  assert.equal((await call(withNative, request('POST', '/native', { headers, body: { autoReply: false, proactive: { enabled: false }, 多余的: 1 } }))).status, 200);
  assert.deepEqual(seen, [
    { autoReply: true },
    { proactive: { enabled: true, dryRun: true } },
    { autoReply: false, proactive: { enabled: false } },
  ]);
});
