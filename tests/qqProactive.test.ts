// 本地单测：主动开口的底子（decide 的优先级、跨天计数、tick 的三条路）。
// 不连网、不问 DSH：generate/deliver 全是桩，只断言它自己的账。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_QQ_PROACTIVE_POLICY,
  createQqProactive,
  createQqProactiveState,
  dayKeyOf,
  decide,
  inQuietHours,
  minuteOfDay,
  quietUntil,
  rollDay,
  type QqProactivePolicy,
  type QqProactiveState,
} from '../src/ecosystem/qq-native/proactive.ts';

const POLICY: QqProactivePolicy = { ...DEFAULT_QQ_PROACTIVE_POLICY };
const HOUR = 3600_000;
const MINUTE = 60_000;

/** 一个空状态；传进来的字段覆盖它。 */
function stateAt(over: Partial<QqProactiveState> = {}): QqProactiveState {
  return {
    dayKey: '', sentToday: 0, callsToday: 0,
    lastActivityAt: 0, lastProactiveAt: 0, selfId: '', events: [],
    ...over,
  };
}

/** 本地时间的那一天那时 — 和机器时区无关。 */
function at(hour: number, minute = 0, day = 1): number {
  return new Date(2026, 5, day, hour, minute, 0, 0).getTime();
}

function tempFile(): { file: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'qq-proactive-'));
  return { file: path.join(dir, 'qq-proactive.json'), dir };
}

// ── 纯函数 ──────────────────────────────────────────────────────────────────

test('minuteOfDay 认 HH:MM，其它一律 -1', () => {
  assert.equal(minuteOfDay('00:00'), 0);
  assert.equal(minuteOfDay('23:59'), 23 * 60 + 59);
  assert.equal(minuteOfDay('8:05'), 8 * 60 + 5);
  assert.equal(minuteOfDay('24:00'), -1);
  assert.equal(minuteOfDay('12:60'), -1);
  assert.equal(minuteOfDay('中午'), -1);
});

test('inQuietHours：跨夜那一段算在里面，白天不算；start 等于 end 视为不静默', () => {
  const quiet = { start: '23:00', end: '08:00' };
  assert.equal(inQuietHours(quiet, at(2)), true, '凌晨两点在静默里');
  assert.equal(inQuietHours(quiet, at(23, 30)), true, '晚上十一点半在静默里');
  assert.equal(inQuietHours(quiet, at(12)), false, '中午不在');
  assert.equal(inQuietHours(quiet, at(8)), false, '八点整是边界，不算');
  assert.equal(inQuietHours({ start: '08:00', end: '08:00' }, at(8)), false);
  assert.equal(inQuietHours({ start: '坏', end: '08:00' }, at(2)), false);
});

test('rollDay 换天清零，同一天里一分不动', () => {
  const state = stateAt({ dayKey: dayKeyOf(at(9)), sentToday: 2, callsToday: 5 });
  rollDay(state, at(10));
  assert.deepEqual([state.sentToday, state.callsToday], [2, 5]);
  rollDay(state, at(10, 0, 2));
  assert.deepEqual([state.sentToday, state.callsToday], [0, 0]);
  assert.equal(state.dayKey, dayKeyOf(at(10, 0, 2)));
});

test('decide：优先级排得对，静默时段压过一切，骰子排最后', () => {
  const rollGo = () => 0;
  const base = { policy: POLICY, roll: rollGo };

  // 没人可发 → 最先，连静默时段都不看
  assert.equal(decide({ ...base, now: at(2), state: stateAt(), target: '' }).kind, 'no-target');
  // 静默时段压过配额
  assert.equal(
    decide({ ...base, now: at(2), target: '1', state: stateAt({ dayKey: dayKeyOf(at(2)), sentToday: 99 }) }).kind,
    'quiet-hour',
  );
  // 配额
  assert.equal(
    decide({ ...base, now: at(12), target: '1', state: stateAt({ dayKey: dayKeyOf(at(12)), sentToday: POLICY.maxPerDay }) }).kind,
    'quota',
  );
  // 刚有人说话
  const talking = decide({ ...base, now: at(12), target: '1', state: stateAt({ lastActivityAt: at(12) - 5 * MINUTE }) });
  assert.equal(talking.kind, 'still-talking');
  assert.equal(talking.kind === 'still-talking' && Math.round(talking.idleMs / MINUTE), 5);
  // 上次主动太近
  assert.equal(
    decide({ ...base, now: at(12), target: '1', state: stateAt({ lastActivityAt: at(12) - 2 * HOUR, lastProactiveAt: at(12) - HOUR }) }).kind,
    'too-soon',
  );
  // 调用预算花光
  assert.equal(
    decide({ ...base, now: at(12), target: '1', state: stateAt({ dayKey: dayKeyOf(at(12)), callsToday: POLICY.maxCallsPerDay, lastActivityAt: at(12) - 2 * HOUR }) }).kind,
    'no-call-budget',
  );
  // 骰子没中
  assert.equal(
    decide({ policy: { ...POLICY, sendProbability: 0.5 }, roll: () => 0.99, now: at(12), target: '1', state: stateAt({ lastActivityAt: at(12) - 2 * HOUR }) }).kind,
    'dice',
  );
  // 全过 → 走，note 里说出闲了多久
  const go = decide({ ...base, now: at(12), target: '1', state: stateAt({ lastActivityAt: at(12) - 45 * MINUTE }) });
  assert.equal(go.kind, 'go');
  assert.equal(go.kind === 'go' && go.note, '闲了 45 分钟');
});

test('decide：换天了就按新的一天算，昨天的配额不算数', () => {
  const state = stateAt({ dayKey: dayKeyOf(at(12, 0, 1)), sentToday: 99, callsToday: 99, lastActivityAt: at(12, 0, 1) - 2 * HOUR });
  const decision = decide({ policy: POLICY, now: at(12, 0, 2), state, target: '1', roll: () => 0 });
  assert.equal(decision.kind, 'go', '昨天的 99 条不该拦住今天');
});

// ── 状态文件 ────────────────────────────────────────────────────────────────

test('状态文件：坏 JSON 当空读，写下去的能原样读回来', () => {
  const { file, dir } = tempFile();
  try {
    const store = createQqProactiveState(file);
    assert.deepEqual(store.read().sentToday, 0, '文件还没有，读出来是空的');
    writeFileSync(file, '{ 这不是 JSON', 'utf8');
    assert.deepEqual(store.read().events, [], '坏了也不抛，当空处理');
    store.write(stateAt({ dayKey: '2026-06-01', sentToday: 1, selfId: '123' }));
    const back = store.read();
    assert.equal(back.sentToday, 1);
    assert.equal(back.selfId, '123');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).dayKey, '2026-06-01');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ticker ──────────────────────────────────────────────────────────────────

test('tick：她要说话 → 发出去、算一条、记下时间', async () => {
  const { file, dir } = tempFile();
  try {
    const sent: string[] = [];
    const engine = createQqProactive({
      policy: { ...POLICY, idleThresholdMs: 30 * MINUTE },
      file,
      log: () => {},
      generate: async (hint) => { assert.equal(hint, '闲了 60 分钟'); return '  在忙吗  '; },
      deliver: async (text) => { sent.push(text); },
      target: () => '3475994805',
      selfId: () => '2039693365',
      now: () => at(12),
      roll: () => 0,
    });
    await engine.noteActivity(at(12) - 60 * MINUTE, '2039693365');
    const decision = await engine.tick();
    assert.equal(decision.kind, 'go');
    assert.deepEqual(sent, ['在忙吗'], '两边空白要去掉');
    const status = engine.status();
    assert.deepEqual([status.today.sent, status.today.calls], [1, 1]);
    assert.equal(status.lastProactiveAt, at(12));
    assert.equal(status.events[0].kind, 'sent');
    assert.equal(engine.knownSelfId(), '2039693365');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tick：她说 [SILENT] → 只花调用、不发、记一笔', async () => {
  const { file, dir } = tempFile();
  try {
    let delivered = 0;
    const engine = createQqProactive({
      policy: POLICY, file, log: () => {},
      generate: async () => '[SILENT]',
      deliver: async () => { delivered += 1; },
      target: () => '3475994805', selfId: () => '', now: () => at(12), roll: () => 0,
    });
    await engine.noteActivity(at(12) - 2 * HOUR);
    await engine.tick();
    const status = engine.status();
    assert.equal(delivered, 0);
    assert.deepEqual([status.today.sent, status.today.calls], [0, 1], '问了就算一次调用');
    assert.equal(status.lastProactiveAt, 0, '没说就不算「上次联系」');
    assert.equal(status.events[0].kind, 'silent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tick：生成炸了 → 不抛出、记 failed、调用照样算花掉', async () => {
  const { file, dir } = tempFile();
  try {
    const logs: string[] = [];
    const engine = createQqProactive({
      policy: POLICY, file, log: (m) => logs.push(m),
      generate: async () => { throw new Error('DSH 没回话'); },
      deliver: async () => { throw new Error('不该走到这'); },
      target: () => '3475994805', selfId: () => '', now: () => at(12), roll: () => 0,
    });
    await engine.noteActivity(at(12) - 2 * HOUR);
    const decision = await engine.tick();
    assert.equal(decision.kind, 'go');
    const status = engine.status();
    assert.deepEqual([status.today.sent, status.today.calls], [0, 1]);
    assert.equal(status.events[0].kind, 'failed');
    assert.match(status.events[0].note, /DSH 没回话/);
    assert.ok(logs.some((line) => line.includes('主动联系失败')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tick：骰子没中就什么都不写 —— 不花调用、不落事件', async () => {
  const { file, dir } = tempFile();
  try {
    let asked = 0;
    const engine = createQqProactive({
      policy: { ...POLICY, sendProbability: 0.5 }, file, log: () => {},
      generate: async () => { asked += 1; return '在'; },
      deliver: async () => {},
      target: () => '3475994805', selfId: () => '', now: () => at(12), roll: () => 0.99,
    });
    await engine.noteActivity(at(12) - 2 * HOUR);
    const decision = await engine.tick();
    assert.equal(decision.kind, 'dice');
    assert.equal(asked, 0, '没中就一个字都不问');
    assert.deepEqual([engine.status().today.calls, engine.status().events.length], [0, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('start：概率或次数是 0 就不定时器，只留一句话', async () => {
  const { file, dir } = tempFile();
  try {
    const logs: string[] = [];
    let timers = 0;
    const engine = createQqProactive({
      policy: { ...POLICY, sendProbability: 0 }, file, log: (m) => logs.push(m),
      generate: async () => '', deliver: async () => {},
      target: () => '1', selfId: () => '',
      timers: { set: () => { timers += 1; return 1; }, clear: () => {} },
    });
    engine.start();
    assert.equal(timers, 0);
    assert.equal(engine.status().enabled, false);
    assert.ok(logs.some((line) => line.includes('不跑')));
    engine.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('start：开着就按 checkIntervalMs 设一个定时器，stop 收掉', async () => {
  const { file, dir } = tempFile();
  try {
    const seen: number[] = [];
    let cleared = 0;
    const engine = createQqProactive({
      policy: { ...POLICY, checkIntervalMs: 5 * MINUTE }, file, log: () => {},
      generate: async () => '', deliver: async () => {},
      target: () => '1', selfId: () => '',
      timers: { set: (_fn, ms) => { seen.push(ms); return 'timer-1'; }, clear: () => { cleared += 1; } },
    });
    engine.start();
    engine.start(); // 第二次不该再设一个
    assert.deepEqual(seen, [5 * MINUTE]);
    engine.stop();
    assert.equal(cleared, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quietUntil 就是静默时段的结束时刻', () => {
  assert.equal(quietUntil({ ...POLICY, quietHours: { start: '23:00', end: '07:30' } }), '07:30');
});