import assert from 'node:assert/strict';
import test from 'node:test';
import { createQqSupervisor } from '../src/qq/supervisor.ts';
import type { QqBridge } from '../src/qq/bridge.ts';

/** 一个只回答 start/intent 的假桥：这两个就是 supervisor 用到的全部能力。 */
function fakeBridge(options: {
  desired?: 'running' | 'stopped';
  started?: boolean;
  startThrows?: boolean;
} = {}): { bridge: Pick<QqBridge, 'start' | 'halt' | 'intent'>; starts: () => number } {
  let starts = 0;
  return {
    starts: () => starts,
    bridge: {
      intent: () => ({ desired: options.desired ?? 'running', at: 0, by: 'test' }),
      async start() {
        starts += 1;
        if (options.startThrows) throw new Error('spawn 失败了');
        return { started: options.started ?? true };
      },
      async halt() { return { stopped: true }; },
    } as Pick<QqBridge, 'start' | 'halt' | 'intent'>,
  };
}

/** 临时替换全局 fetch：所有用例都不该真的连 3100（那可能是台在跑的桥）。 */
async function withFetch(
  impl: () => Promise<Response> | Response,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => impl()) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
}

const okBody = (extra: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ ok: true, dshReady: true, ...extra }), { status: 200 });
const fail503 = (): Response => new Response('{}', { status: 503 });

function supervisor(bridge: Pick<QqBridge, 'start' | 'halt' | 'intent'>, options: Record<string, unknown> = {}) {
  return createQqSupervisor({
    dir: 'Z:/no/such/bridge', // readConsoleToken 会读不到；mock 的 fetch 不看 token
    bridge,
    intervalMs: 5,
    probeTimeoutMs: 200,
    backoffBaseMs: 1,
    random: () => 0.5, // 固定抖动，退避值可预测
    ...options,
  });
}

test('探到 200 且 dshReady → healthy', async () => {
  const fake = fakeBridge();
  const s = supervisor(fake.bridge);
  await withFetch(okBody, async () => {
    const snap = await s.probeOnce();
    assert.equal(snap.state, 'healthy');
    assert.equal(snap.dshReady, true);
    assert.equal(snap.consecutiveFailures, 0);
    assert.equal(snap.backoffMs, 0, '没在退避就别报时长，界面上「退避 5 秒」会误导人');
    assert.equal(snap.lastError, undefined);
  });
  assert.equal(fake.starts(), 0);
});

test('桥在线但 dshReady=false → degraded，且不重启桥', async () => {
  // 这类故障是 baseUrl 过期（DSH 换了端口），重启桥只会白折腾一趟。
  const fake = fakeBridge();
  const s = supervisor(fake.bridge);
  await withFetch(() => okBody({ dshReady: false }), async () => {
    const snap = await s.probeOnce();
    assert.equal(snap.state, 'degraded');
    assert.equal(snap.dshReady, false);
    assert.match(String(snap.lastError), /syncEndpoint/);
  });
  assert.equal(fake.starts(), 0, 'dshReady=false 不该触发重启');
});

test('失败 1、2 次只报状态，第 3 次才拉起', async () => {
  const fake = fakeBridge();
  const s = supervisor(fake.bridge);
  await withFetch(fail503, async () => {
    assert.equal((await s.probeOnce()).state, 'degraded');
    assert.equal(fake.starts(), 0);
    assert.equal((await s.probeOnce()).consecutiveFailures, 2);
    assert.equal(fake.starts(), 0, '两次还没到阈值');
    const third = await s.probeOnce();
    assert.equal(fake.starts(), 1, '第三次应该尝试拉起');
    assert.equal(third.state, 'healthy');
    assert.equal(third.restartsInWindow, 1);
    assert.equal(third.consecutiveFailures, 0, '拉起成功后计数清零');
  });
});

test('用户主动停止（desired=stopped）时巡检不拉起', async () => {
  const fake = fakeBridge({ desired: 'stopped' });
  const s = supervisor(fake.bridge);
  await withFetch(fail503, async () => {
    const first = await s.probeOnce();
    assert.equal(first.state, 'stopped', '第一次探测就该报 stopped，不该先跳 degraded');
    assert.equal(first.consecutiveFailures, 0, '主动停止不算故障，不累计失败次数');
    for (let i = 0; i < 4; i += 1) await s.probeOnce();
    assert.equal(fake.starts(), 0, '停止是人的决定，巡检不该把手伸回去');
    assert.equal(s.snapshot().state, 'stopped');
  });
});

test('拉起失败会退避，且退避时长随失败次数增长', async () => {
  const fake = fakeBridge({ started: false });
  const s = supervisor(fake.bridge);
  await withFetch(fail503, async () => {
    for (let i = 0; i < 3; i += 1) await s.probeOnce();
    const first = s.snapshot();
    assert.equal(fake.starts(), 1);
    assert.equal(first.state, 'degraded', '退避等待结束后应该回到 degraded，而不是卡在 recovering');
    assert.equal(first.backoffMs, 1, '第 1 次恢复失败：base(1) × 2^0 × 抖动(1.0)');
    // 再累积 3 次失败，退避翻倍。
    for (let i = 0; i < 3; i += 1) await s.probeOnce();
    assert.equal(fake.starts(), 2);
    assert.equal(s.snapshot().backoffMs, 2, '第 2 次恢复失败：base(1) × 2^1 × 抖动(1.0)');
  });
});

test('10 分钟窗口内拉起次数超上限就停在 failed，不再动手', async () => {
  // start 报成功但桥立刻又挂：这是「拉了也没用」的形态，必须停下来。
  const fake = fakeBridge({ started: true });
  const s = supervisor(fake.bridge, { maxRestartsPerWindow: 2 });
  await withFetch(fail503, async () => {
    for (let i = 0; i < 9; i += 1) await s.probeOnce();
    const snap = s.snapshot();
    assert.equal(fake.starts(), 2, '上限 2 次之后不该再拉');
    assert.equal(snap.state, 'failed');
    assert.match(String(snap.lastError), /已自动拉起 2 次/);
    assert.equal(snap.restartsInWindow, 2);
  });
});

test('start 抛异常不会把巡检打死', async () => {
  const fake = fakeBridge({ startThrows: true });
  const s = supervisor(fake.bridge);
  await withFetch(fail503, async () => {
    for (let i = 0; i < 3; i += 1) await s.probeOnce();
    const snap = s.snapshot();
    assert.equal(fake.starts(), 1);
    assert.match(String(snap.lastError), /spawn 失败了/);
    assert.equal(snap.state, 'degraded');
  });
});