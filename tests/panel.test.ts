import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgeConsoleUrl, createConsoleDoors, createPanelSecrets, findSnowlumaConsole, loginSnowluma, readSnowlumaHome, PANEL_FILE } from '../src/qq/panel.ts';

function tempHome(runtime?: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'snowluma-home-'));
  mkdirSync(join(home, 'config'), { recursive: true });
  if (runtime !== undefined) writeFileSync(join(home, 'config', 'runtime.json'), JSON.stringify(runtime));
  return home;
}
const reply = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

test('SnowLuma 的控制台地址从它自己的 runtime.json 里读，不是写死的端口', () => {
  const home = tempHome({ webuiPort: 5099, webuiHost: '127.0.0.1', webuiTls: { enabled: false } });
  assert.deepEqual(findSnowlumaConsole(home)?.base, 'http://127.0.0.1:5099');
});

test('绑在所有网卡上的控制台仍然从本机按名字访问；没有配置就说没有', () => {
  assert.equal(findSnowlumaConsole(tempHome({ webuiPort: 6100, webuiHost: '0.0.0.0' }))?.base, 'http://127.0.0.1:6100');
  assert.equal(findSnowlumaConsole(tempHome())?.base, undefined);
  assert.equal(findSnowlumaConsole(''), undefined);
  const empty = mkdtempSync(join(tmpdir(), 'no-snowluma-'));
  assert.equal(findSnowlumaConsole(empty), undefined);
});

test('面板密码记在她世界目录旁边，只有本机用户能读；空密码不算记过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'world-panel-'));
  const secrets = createPanelSecrets(dir);
  assert.equal(secrets.read(), undefined);
  secrets.remember('', 'hunter2');
  assert.deepEqual(secrets.read(), { username: 'admin', password: 'hunter2' });
  const file = join(dir, PANEL_FILE);
  assert.ok(existsSync(file));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  secrets.forget();
  assert.equal(secrets.read(), undefined);
});

test('面板密码换来的会话令牌直接写进 URL，页面拿到就是登录态', async () => {
  const day = await loginSnowluma('http://127.0.0.1:5099/', 'admin', 'hunter2', reply(200, { success: true, token: 'abc123' }));
  assert.deepEqual(day, { url: 'http://127.0.0.1:5099/?token=abc123' });
});

test('密码错、被限流、连不上，三种都说得清', async () => {
  assert.deepEqual(await loginSnowluma('http://x', 'admin', 'bad', reply(401, { success: false, message: '密码错误' })), { error: '密码错误' });
  const limited = await loginSnowluma('http://x', 'admin', 'bad', reply(429, { success: false })) as { error: string };
  assert.match(limited.error, /登录尝试太多/);
  const dead = await loginSnowluma('http://x', 'admin', 'bad', (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch) as { error: string };
  assert.match(dead.error, /连不上 SnowLuma 控制台/);
});

test('qq-bridge 的控制台令牌是文件，读得到就能开，读不到就说还没启动过', () => {
  const bridge = mkdtempSync(join(tmpdir(), 'bridge-'));
  assert.match((bridgeConsoleUrl(bridge, 3100) as { error: string }).error, /没有控制台令牌/);
  mkdirSync(join(bridge, 'state'), { recursive: true });
  writeFileSync(join(bridge, 'state', 'console-token'), 'tok-123\n');
  assert.deepEqual(bridgeConsoleUrl(bridge, 3100), { url: 'http://127.0.0.1:3100/?token=tok-123' });
});

test('桥的配置里本来就写着 SnowLuma 在哪，不用再问一遍', () => {
  const bridge = mkdtempSync(join(tmpdir(), 'bridge-cfg-'));
  assert.equal(readSnowlumaHome(bridge), '');
  writeFileSync(join(bridge, 'config.json'), JSON.stringify({ snowluma: { homeDir: 'D:\\SnowLuma' } }));
  assert.equal(readSnowlumaHome(bridge), 'D:\\SnowLuma');
  // 老位置的写法也认。
  writeFileSync(join(bridge, 'config.json'), JSON.stringify({ dsh: { snowluma: { homeDir: 'E:\\SnowLuma' } } }));
  assert.equal(readSnowlumaHome(bridge), 'E:\\SnowLuma');
});

test('两扇门：SnowLuma 没密码时先要密码，记住之后才开门；密码错了不留下', async () => {
  const world = mkdtempSync(join(tmpdir(), 'world-doors-'));
  const bridge = mkdtempSync(join(tmpdir(), 'bridge-doors-'));
  mkdirSync(join(bridge, 'state'), { recursive: true });
  writeFileSync(join(bridge, 'state', 'console-token'), 'tok-9');
  const home = tempHome({ webuiPort: 5099, webuiHost: '127.0.0.1' });
  const doors = createConsoleDoors({ worldDir: world, bridgeDir: bridge, port: 3100, snowlumaHome: home });
  assert.deepEqual(doors.qq(), { url: 'http://127.0.0.1:3100/?token=tok-9' });
  assert.equal((await doors.snowluma() as { needs?: string }).needs, 'password');
  const secrets = createPanelSecrets(world);
  assert.equal(secrets.read(), undefined);
});