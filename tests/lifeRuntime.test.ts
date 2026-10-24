import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { hostFixture, textResponse } from './hostFixture.ts';
import { createLifeRuntime } from '../src/life/runtime.ts';
import { createLifeStore, type LifeStore } from '../src/life/lifeStore.ts';
import { hostLife, type LifeHost } from '../src/life/host.ts';
import type { Notifier } from '../src/life/notify.ts';
import ToolFreeCompaction from '../src/compaction.ts';

const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'Asia/Seoul', companionName: '鲸鲸' };
const textOf = (request: GenerateOptions) => request.messages.map(m => m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')).join('\n');
const toolNames = (request: GenerateOptions) => request.tools?.map(tool => tool.name) ?? [];
const count = (names: string[], name: string) => names.filter(entry => entry === name).length;
const tick = () => new Promise(resolve => setImmediate(resolve));
const userMessage = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const createAgent = async (ctx: Context, id: string, agentPreset = 'companion') => (await ctx.agents.create({ sessionId: SessionId(id), meta: { agentPreset }, agentOptions: { provider: 'test', model: 'test' } })).agent;
const testTool = (name: string, execute: () => Promise<string>) => defineTool({ name, description: 'test', parameters: { command: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute });
async function* toolCall(name: string, args: object, id = `${name}-call`): AsyncIterable<StreamChunk> {
  const block = { type: 'tool-call' as const, id: ToolCallId(id), name, arguments: JSON.stringify(args) };
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments };
  yield { type: 'block-end', index: 0, block };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
function fakeTimers(clock: { now: Date }) {
  let pending: { fn: () => void; at: number }[] = [];
  return {
    set(fn: () => void, ms: number) { const entry = { fn, at: clock.now.getTime() + ms }; pending.push(entry); return entry; },
    clear(handle: unknown) { pending = pending.filter(entry => entry !== handle); },
    /** Move the clock and run every due timer. */
    advance(ms: number) { clock.now = new Date(clock.now.getTime() + ms); const due = pending.filter(entry => entry.at <= clock.now.getTime()); pending = pending.filter(entry => !due.includes(entry)); for (const entry of due) entry.fn(); },
    /** Wall clock jumps (suspend, clock change) while no timer time passes. */
    jump(ms: number) { clock.now = new Date(clock.now.getTime() + ms); for (const entry of pending) entry.at += ms; },
  };
}
interface SetupOptions { before?: (worldDir: string) => Promise<void>; host?: (host: LifeHost) => LifeHost; store?: (store: LifeStore) => LifeStore; notifier?: Notifier }
async function setup(t: test.TestContext, model: (request: GenerateOptions, index: number) => AsyncIterable<StreamChunk>, setupOptions: SetupOptions = {}) {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => { if (request.purpose !== 'compaction') requests.push(request); return model(request, requests.length - 1); });
  const worldDir = join(root, 'world'); await mkdir(worldDir, { recursive: true }); await setupOptions.before?.(worldDir);
  const clock = { now: new Date('2026-10-23T03:00:00.000Z') }; const timers = fakeTimers(clock);
  const archived = new Set<string>(); const renamed = new Map<string, string>(); const fullAccess = new Set<string>(); let created = 0;
  const baseHost: LifeHost = {
    createSession: async (_cwd, agentPreset) => (await ctx.agents.create({ sessionId: SessionId(`home-${++created}`), meta: { agentPreset }, agentOptions: { provider: 'test', model: 'test' } })).agent.id,
    resolveAgent: async id => ctx.agents.get(SessionId(id)),
    isArchived: id => archived.has(id), setFullAccess: session => fullAccess.add(session.id),
    rename: async (id, title) => { renamed.set(id, title); }, origin: () => 'http://127.0.0.1:0',
  };
  const host = setupOptions.host?.(baseHost) ?? baseHost;
  const baseStore = createLifeStore(worldDir, config.timeZone);
  const store = setupOptions.store?.(baseStore) ?? baseStore;
  const options = { roomDir: join(worldDir, 'room'), diaryDir: join(worldDir, 'diary'), fallbackWakeTime: '09:00', petId: 'main', timeZone: config.timeZone, alarmFile: join(worldDir, 'alarm.md') };
  const make = () => createLifeRuntime({ ctx, config, options, store, host, notifier: setupOptions.notifier ?? { toast: async () => {}, outlets: [] }, clock: () => clock.now, timers });
  let life = make();
  cleanup.push(() => life.stop());
  /** Waits out deliveries and the home turns they start, a few rounds deep. */
  const idle = async () => {
    for (let round = 0; round < 3; round++) {
      await life.settled();
      const home = life.snapshot().homeSessionId;
      if (home) await ctx.agents.get(SessionId(home))?.whenIdle();
      await tick();
    }
  };
  /** Start, then fire the zero-delay timer that delivers a due (first or overdue) alarm. */
  const start = async () => { await life.start(); timers.advance(0); await idle(); };
  /** Stop this runtime and make a fresh one over the same ctx and store (a plugin reload). */
  const restart = () => { life.stop(); life = make(); return life; };
  const alarm = () => { const pending = life.snapshot().alarm; return pending && { at: pending.at, source: pending.source }; };
  const faults = () => life.snapshot().faults;
  return { ctx, get life() { return life; }, store, requests, errors, clock, timers, archived, renamed, fullAccess, worldDir, idle, start, restart, alarm, faults, created: () => created };
}
/** life.json for an existing home `home-0` (create it before start), optionally with an alarm of her own due at start. */
const existingHome = (note?: string) => (worldDir: string) => writeFile(join(worldDir, 'life.json'), JSON.stringify({
  version: 1, homeSessionId: 'home-0', ...(note === undefined ? {} : { alarm: { at: '2026-10-23T03:00:00.000Z', note, setAt: '2026-10-23T02:00:00.000Z', source: 'plan' } }),
}));
/** A host whose nth resolveAgent call is held until released (or rejected). */
function holdResolve(nth: number) {
  let calls = 0;
  const held: { release?: () => void; fail?: (error: Error) => void } = {};
  const patch = (host: LifeHost): LifeHost => ({
    ...host,
    resolveAgent: id => ++calls === nth ? new Promise((resolve, reject) => { held.release = () => resolve(host.resolveAgent(id)); held.fail = reject; }) : host.resolveAgent(id),
  });
  return { held, patch };
}

test('first start builds the home with full access, a title and reach_out at home, alarm tools everywhere', async t => {
  const s = await setup(t, () => textResponse('我到家了'));
  await s.start();
  const home = s.life.snapshot().homeSessionId!;
  assert.equal(s.renamed.get(home), '鲸鲸的家'); assert.ok(s.fullAccess.has(home));
  assert.equal(s.requests.length, 1);
  assert.match(textOf(s.requests[0]), /这是你的家/);
  assert.deepEqual(toolNames(s.requests[0]).filter(name => ['plan_next', 'reach_out', 'read_diary'].includes(name)).sort(), ['plan_next', 'reach_out']);
  const chat = await createAgent(s.ctx, 'chat');
  chat.followup(userMessage('hi')); await chat.whenIdle();
  const names = toolNames(s.requests[1]);
  assert.ok(!names.includes('read_diary') && !names.includes('reach_out'), 'reach_out stays home');
  assert.ok(['plan_next', 'check_alarm', 'cancel_alarm'].every(name => count(names, name) === 1), 'the alarm can be set from any of her sessions');
  assert.equal(s.store.wakes().length, 1); assert.equal(s.store.wakes()[0].source, 'first');
});
test('a new home is renamed again after its first turn ends (the host retitles from the first prompt), and not after later turns', async t => {
  const titles: string[] = [];
  const s = await setup(t, () => textResponse('嗯'), { host: host => ({ ...host, rename: async (id, title) => { titles.push(`${id}:${title}`); await host.rename(id, title); } }) });
  await s.life.start();
  const home = s.life.snapshot().homeSessionId!;
  assert.deepEqual(titles, [`${home}:鲸鲸的家`]);
  s.timers.advance(0); await s.idle();
  assert.deepEqual(titles, [`${home}:鲸鲸的家`, `${home}:鲸鲸的家`]);
  s.timers.advance(21 * 3_600_000); await s.idle();
  const agent = s.ctx.agents.get(SessionId(home))!;
  agent.followup(userMessage('在吗')); await s.idle();
  assert.equal(s.requests.length, 3); assert.equal(titles.length, 2);
});
test('an existing home is not renamed after its turns', async t => {
  const titles: string[] = [];
  const s = await setup(t, () => textResponse('嗯'), { host: host => ({ ...host, rename: async (id, title) => { titles.push(id); await host.rename(id, title); } }), before: async worldDir => { await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'home-0' })); } });
  await createAgent(s.ctx, 'home-0');
  await s.start();
  s.timers.advance(21 * 3_600_000); await s.idle();
  assert.equal(s.requests.length, 1); assert.deepEqual(titles, []);
});
test('the host reads archived sessions from an array or a Set', () => {
  const host = (archivedSessionIds: Iterable<string> | undefined) => hostLife({ get: () => archivedSessionIds && { archivedSessionIds } } as unknown as Context);
  assert.equal(host(['a']).isArchived('a'), true);
  assert.equal(host(new Set(['a'])).isArchived('a'), true);
  assert.equal(host(new Set(['a'])).isArchived('b'), false);
  assert.equal(host(undefined).isArchived('a'), false);
});
test('a session of another agent preset gets no life tools', async t => {
  const s = await setup(t, () => textResponse('ok'));
  await s.start();
  const coder = await createAgent(s.ctx, 'coder', 'coder');
  coder.followup(userMessage('hi')); await coder.whenIdle();
  assert.ok(!toolNames(s.requests.at(-1)!).some(name => ['read_diary', 'plan_next', 'reach_out'].includes(name)));
});
test('plan_next sets the alarm and the alarm wakes her with her own note', async t => {
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('plan_next', { after_minutes: 90, note: '去写日记' }) : textResponse('好'));
  await s.start();
  assert.equal(s.life.snapshot().alarm?.at, '2026-10-23T04:30:00.000Z');
  s.timers.advance(90 * 60_000); await s.idle();
  assert.match(textOf(s.requests.at(-1)!), /2026-10-23T13:30:00\+09:00 到了，这是你说好做到的时间：「去写日记」/);
  assert.deepEqual(s.store.wakes().map(wake => wake.source), ['first', 'plan']);
});
test('a home turn that stops well before her own alarm asks once whether she is done; the alarm still rings', async t => {
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('plan_next', { after_minutes: 90, note: '看视频' }) : textResponse('嗯'), { before: existingHome('起来') });
  await createAgent(s.ctx, 'home-0');
  await s.start();
  assert.equal(s.requests.length, 3, 'the first turn (two steps), then one question');
  assert.match(textOf(s.requests[2]!), /【你的时间】你说好做到 2026-10-23T13:30:00\+09:00（「看视频」），现在才 2026-10-23T12:00:00\+09:00，这一轮就停了。/);
  assert.equal(s.store.read().alarm?.nudged, true, 'asked is remembered across restarts');
  s.timers.advance(90 * 60_000); await s.idle();
  assert.equal(s.requests.length, 4);
  assert.match(textOf(s.requests[3]!), /说好做到的时间：「看视频」/);
});
test('the turn the question started never asks again, even with a new alarm, so nothing loops', async t => {
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('plan_next', { after_minutes: 90, note: '看视频' }, 'a')
    : index === 2 ? toolCall('plan_next', { after_minutes: 60, note: '写日记' }, 'b') : textResponse('嗯'), { before: existingHome('起来') });
  await createAgent(s.ctx, 'home-0');
  await s.start();
  assert.equal(s.requests.length, 4);
  assert.deepEqual(s.alarm(), { at: '2026-10-23T04:00:00.000Z', source: 'plan' });
});
test('no question when her alarm is close, after her partner spoke, or when the turn was stopped', async t => {
  const close = await setup(t, (_request, index) => index === 0 ? toolCall('plan_next', { after_minutes: 5, note: '收尾' }) : textResponse('嗯'), { before: existingHome('起来') });
  await createAgent(close.ctx, 'home-0');
  await close.start();
  assert.equal(close.requests.length, 2);

  const chat = await setup(t, () => textResponse('嗯'));
  await chat.start();
  chat.life.planNext({ after_minutes: 60 }, '看书');
  const home = chat.ctx.agents.get(SessionId(chat.life.snapshot().homeSessionId!))!;
  home.followup(userMessage('在吗')); await chat.idle();
  assert.equal(chat.requests.length, 2, 'a pause in talking with her partner is not stopping early');
  assert.equal(chat.store.read().alarm?.nudged, undefined, 'so a later early stop is still asked about');

  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const playing = new Promise<void>(resolve => { entered = resolve; });
  const stopped = await setup(t, (_request, index) => index === 0 ? toolCall('play_game', {}) : textResponse('嗯'));
  stopped.ctx.tools.register(testTool('play_game', async () => { entered(); await gate; return 'played'; }));
  await stopped.life.start(); stopped.timers.advance(0); await playing; await stopped.life.settled();
  stopped.life.planNext({ after_minutes: 60 }, '玩游戏');
  const playingHome = stopped.ctx.agents.get(SessionId(stopped.life.snapshot().homeSessionId!))!;
  playingHome.cancel({ kind: 'user' }); release(); await stopped.idle();
  assert.equal(stopped.requests.length, 1);
});
test('a home turn that ends without an alarm gets the fallback alarm', async t => {
  const s = await setup(t, () => textResponse('发会儿呆'));
  await s.start();
  assert.deepEqual(s.alarm(), { at: '2026-10-24T00:00:00.000Z', source: 'fallback' });
  s.timers.advance(21 * 3_600_000); await s.idle();
  assert.match(textOf(s.requests.at(-1)!), /没说接下来做什么/);
});
test('a partner turn in the home does not consume the pending alarm', async t => {
  const s = await setup(t, () => textResponse('嗯'));
  await s.start();
  const pending = s.life.snapshot().alarm;
  const home = s.ctx.agents.get(SessionId(s.life.snapshot().homeSessionId!))!;
  home.followup(userMessage('在吗')); await s.idle();
  assert.equal(s.requests.length, 2); assert.deepEqual(s.life.snapshot().alarm, pending);
  s.timers.advance(21 * 3_600_000); await s.idle();
  assert.equal(s.requests.length, 3); assert.match(textOf(s.requests[2]), /没说接下来做什么/);
});
test('while she is busy, the alarm and her partner\'s message both enter the running turn', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const playing = new Promise<void>(resolve => { entered = resolve; });
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('play_game', {}) : textResponse('听到了'));
  s.ctx.tools.register(testTool('play_game', async () => { entered(); await gate; return 'played'; }));
  await s.life.start(); s.timers.advance(0); await playing; await s.life.settled();
  const home = s.ctx.agents.get(SessionId(s.life.snapshot().homeSessionId!))!;
  assert.equal(home.status, 'running');
  s.life.planNext({ after_minutes: 5 }, '收工');
  s.timers.advance(5 * 60_000); await s.life.settled();
  home.followup(userMessage('在玩什么'));
  release(); await s.idle();
  assert.equal(s.requests.length, 2, 'both arrived inside the same turn, at the next step');
  assert.match(textOf(s.requests[1]), /说好做到的时间：「收工」/); assert.match(textOf(s.requests[1]), /在玩什么/);
});
test('an archived home is replaced, keeps the pending alarm, and the old home loses reach_out', async t => {
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('plan_next', { after_minutes: 30, note: '看书' }) : textResponse('嗯'));
  await s.start();
  const first = s.life.snapshot().homeSessionId!; s.archived.add(first);
  s.timers.advance(30 * 60_000); await s.idle();
  const second = s.life.snapshot().homeSessionId!;
  assert.notEqual(second, first); assert.equal(s.renamed.get(second), '鲸鲸的家');
  assert.match(textOf(s.requests.at(-1)!), /「看书」/);
  const old = s.ctx.agents.get(SessionId(first))!;
  old.followup(userMessage('还在吗')); await old.whenIdle();
  const names = toolNames(s.requests.at(-1)!);
  assert.ok(!names.includes('read_diary') && !names.includes('reach_out') && count(names, 'plan_next') === 1, 'the old home keeps the alarm tools like any session, and loses reach_out');
  assert.doesNotMatch(textOf(s.requests.at(-1)!), /你现在在自己的家里/);
});
test('an existing home gets full access again whenever it is resolved', async t => {
  const s = await setup(t, () => textResponse('回来了'), { before: async worldDir => { await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'home-0' })); } });
  await createAgent(s.ctx, 'home-0');
  await s.life.start();
  assert.equal(s.created(), 0); assert.ok(s.fullAccess.has('home-0'));
});
test('a restart with an idle home and no pending alarm sets the fallback alarm, and it rings', async t => {
  const s = await setup(t, () => textResponse('醒了'), { before: async worldDir => { await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'home-0' })); } });
  await createAgent(s.ctx, 'home-0');
  await s.start();
  assert.equal(s.created(), 0); assert.equal(s.requests.length, 0);
  assert.deepEqual(s.alarm(), { at: '2026-10-24T00:00:00.000Z', source: 'fallback' });
  assert.equal(s.store.read().alarm?.source, 'fallback');
  s.timers.advance(21 * 3_600_000); await s.idle();
  assert.equal(s.requests.length, 1); assert.match(textOf(s.requests[0]), /没说接下来做什么/);
  assert.deepEqual(s.store.wakes().map(wake => wake.source), ['fallback']);
});
test('a rebuilt home with no pending alarm gets a first wake', async t => {
  const s = await setup(t, () => textResponse('新家'), { before: async worldDir => { await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'gone' })); } });
  await s.start();
  assert.notEqual(s.life.snapshot().homeSessionId, 'gone');
  assert.deepEqual(s.store.wakes().map(wake => wake.source), ['first']);
  assert.match(textOf(s.requests[0]), /这是你的家/);
});
test('a home rebuilt while her own alarm is pending greets her at once, is not asked about, and the alarm still rings', async t => {
  const s = await setup(t, () => textResponse('新家'), { before: async worldDir => { await writeFile(join(worldDir, 'life.json'), JSON.stringify({
    version: 1, homeSessionId: 'archived-home', alarm: { at: '2026-10-23T04:00:00.000Z', note: '歇着', setAt: '2026-10-23T02:00:00.000Z', source: 'plan' },
  })); } });
  s.archived.add('archived-home');
  await s.start();
  assert.equal(s.requests.length, 1, 'only the greeting, no early-stop question after it');
  assert.match(textOf(s.requests[0]), /这是你的家/);
  assert.deepEqual(s.alarm(), { at: '2026-10-23T04:00:00.000Z', source: 'plan' });
  assert.equal(s.store.read().arrival, undefined);
  s.timers.advance(60 * 60_000); await s.idle();
  assert.match(textOf(s.requests.at(-1)!), /说好做到的时间：「歇着」/);
  assert.deepEqual(s.store.wakes().map(wake => wake.source), ['first', 'plan']);
});
test('an alarm that came due while the app was closed is delivered late with the delay', async t => {
  const s = await setup(t, () => textResponse('醒啦'), { before: async worldDir => {
    await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'home-0', alarm: { at: '2026-10-23T00:00:00.000Z', note: '早安', setAt: '2026-10-22T15:00:00.000Z', source: 'plan' } }));
  } });
  await createAgent(s.ctx, 'home-0');
  await s.start();
  assert.match(textOf(s.requests[0]), /「早安」。[^\n]*（晚了 3 小时/);
  assert.equal(s.store.wakes()[0].lateMs, 3 * 3_600_000);
});
test('timers run in short segments, so a wall-clock jump still delivers the alarm', async t => {
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('plan_next', { after_minutes: 120, note: '午睡' }) : textResponse('醒了'));
  await s.start();
  s.timers.jump(2 * 3_600_000);
  s.timers.advance(5 * 60_000); await s.idle();
  assert.match(textOf(s.requests.at(-1)!), /「午睡」/);
});
test('retries back off on schedule even though timers run in short segments', async t => {
  let calls = 0;
  const s = await setup(t, () => textResponse('终于'), { host: host => ({ ...host, resolveAgent: id => ++calls >= 2 && calls <= 4 ? Promise.reject(new Error('home is busy')) : host.resolveAgent(id) }) });
  await s.life.start(); s.timers.advance(0); await s.idle();
  s.timers.advance(60_000); await s.idle();
  s.timers.advance(5 * 60_000); await s.idle();
  assert.ok(s.faults().some(fault => fault.includes('15 分钟后重试')));
  s.timers.advance(5 * 60_000); await s.idle(); s.timers.advance(5 * 60_000); await s.idle();
  assert.equal(s.requests.length, 0, 'a 5-minute segment does not cut the 15-minute retry short');
  s.timers.advance(5 * 60_000); await s.idle();
  assert.equal(s.requests.length, 1); assert.deepEqual(s.store.wakes().map(wake => wake.source), ['first']);
});
test('a failed delivery never fires a newer alarm before it is due', async t => {
  const { held, patch } = holdResolve(2);
  const s = await setup(t, () => textResponse('看书去'), { host: patch, before: existingHome('旧的') });
  await createAgent(s.ctx, 'home-0');
  await s.life.start(); s.timers.advance(0);
  s.life.planNext({ after_minutes: 30 }, '看书');
  held.fail!(new Error('home is busy')); await s.life.settled();
  s.timers.advance(60_000); await s.idle();
  assert.equal(s.store.wakes().length, 0); assert.equal(s.requests.length, 0);
  assert.deepEqual(s.alarm(), { at: '2026-10-23T03:30:00.000Z', source: 'plan' });
  s.timers.advance(29 * 60_000); await s.idle();
  assert.deepEqual(s.store.wakes().map(wake => wake.source), ['plan']);
  assert.match(textOf(s.requests[0]), /「看书」/);
});
test('plan_next while a delivery is resolving the home keeps the new alarm', async t => {
  const { held, patch } = holdResolve(2);
  const s = await setup(t, () => textResponse('好'), { host: patch, before: existingHome('旧的') });
  await createAgent(s.ctx, 'home-0');
  await s.life.start(); s.timers.advance(0);
  s.life.planNext({ after_minutes: 30 }, '新的');
  held.release!(); await s.idle();
  assert.equal(s.requests.length, 0, 'the replaced alarm is not delivered'); assert.equal(s.store.wakes().length, 0);
  assert.deepEqual(s.alarm(), { at: '2026-10-23T03:30:00.000Z', source: 'plan' });
  s.timers.advance(30 * 60_000); await s.idle();
  assert.deepEqual(s.store.wakes().map(wake => wake.source), ['plan']); assert.match(textOf(s.requests[0]), /「新的」/);
});
test('plan_next without a pending alarm keeps the plain text', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const playing = new Promise<void>(resolve => { entered = resolve; });
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('play_game', {}) : textResponse('好'));
  s.ctx.tools.register(testTool('play_game', async () => { entered(); await gate; return 'played'; }));
  await s.life.start(); s.timers.advance(0); await playing; await s.life.settled();
  assert.equal(s.alarm(), undefined);
  assert.equal(s.life.planNext({ after_minutes: 30 }, '看书'), '好，到 2026-10-23T12:30:00+09:00 提醒你。');
  release(); await s.idle();
});
test('plan_next says what it replaced, and the old note with it', async t => {
  const s = await setup(t, () => textResponse('好'));
  await s.start();
  assert.equal(s.alarm()?.source, 'fallback');
  // The plugin's own fallback is not her plan, so replacing it is not worth mentioning.
  assert.equal(s.life.planNext({ after_minutes: 30 }, ''), '好，到 2026-10-23T12:30:00+09:00 提醒你。');
  assert.equal(s.life.planNext({ after_minutes: 20 }, '看下一课'), '好，到 2026-10-23T12:20:00+09:00 提醒你。（替换了原来做到 2026-10-23T12:30:00+09:00 的安排。）');
  assert.equal(s.life.planNext({ after_minutes: 10 }, '只列检查'), '好，到 2026-10-23T12:10:00+09:00 提醒你。（替换了原来做到 2026-10-23T12:20:00+09:00 的安排：「看下一课」。还想留着里面的事，就写进新的 note。）');
});
test('a new alarm clears the retry fault; one that cannot be saved is a fault but still rings', async t => {
  const { held, patch } = holdResolve(2);
  let failWrites = false;
  const s = await setup(t, () => textResponse('嗯'), { host: patch, before: existingHome('旧的'), store: store => ({ ...store, write: state => { if (failWrites) throw new Error('disk full'); store.write(state); } }) });
  await createAgent(s.ctx, 'home-0');
  await s.life.start(); s.timers.advance(0); held.fail!(new Error('home is busy')); await s.life.settled();
  assert.ok(s.faults().some(fault => fault.includes('分钟后重试')));
  s.life.planNext({ after_minutes: 10 }, '再来');
  assert.ok(!s.faults().some(fault => fault.includes('分钟后重试')));
  failWrites = true;
  assert.throws(() => s.life.planNext({ after_minutes: 20 }, '存不下'), /disk full/);
  assert.ok(s.faults().some(fault => fault.startsWith('闹钟没能保存：')));
  s.timers.advance(20 * 60_000); await s.idle();
  assert.match(textOf(s.requests.at(-1)!), /「存不下」/);
});
test('an alarm that was steered counts as delivered even when recording it fails', async t => {
  let failing = false;
  const s = await setup(t, () => textResponse('嗯'), { store: store => ({
    ...store,
    write: state => { if (failing) throw new Error('disk full'); store.write(state); },
    appendWake: record => { if (failing) throw new Error('disk full'); store.appendWake(record); },
  }) });
  await s.start();
  failing = true;
  s.timers.advance(21 * 3_600_000); await s.idle();
  assert.equal(s.requests.length, 2);
  assert.ok(s.faults().some(fault => fault.startsWith('生活状态没能保存：')));
  s.timers.advance(60_000); await s.idle(); s.timers.advance(5 * 60_000); await s.idle();
  assert.equal(s.requests.length, 2, 'not retried');
});
test('a fallback alarm that cannot be saved becomes a fault instead of breaking the turn', async t => {
  let failWrites = false;
  const s = await setup(t, () => textResponse('嗯'), {
    before: async worldDir => { await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'home-0' })); },
    store: store => ({ ...store, write: state => { if (failWrites) throw new Error('disk full'); store.write(state); } }),
  });
  await createAgent(s.ctx, 'home-0');
  await s.start();
  assert.equal(s.life.snapshot().alarm?.source, 'fallback');
  failWrites = true;
  s.timers.advance(21 * 3_600_000); await s.idle();
  assert.deepEqual(s.errors, []); assert.equal(s.requests.length, 1);
  assert.ok(s.faults().some(fault => fault.startsWith('断线保护闹钟没能保存：')));
  assert.equal(s.life.snapshot().alarm?.source, 'fallback');
  s.timers.advance(24 * 3_600_000); await s.idle();
  assert.equal(s.requests.length, 2);
  assert.match(textOf(s.requests.at(-1)!), /没说接下来做什么/, 'the unsaved fallback still rings in this run');
});
test('a failing rename is a fault, and a failing full-access grant retries on the same session', async t => {
  // The rename on creation and the one after the first turn both fail; the next resolve tries again.
  let renameFails = 2; let accessFails = 1;
  const s = await setup(t, () => textResponse('嗯'), { host: host => ({
    ...host,
    setFullAccess: session => { if (accessFails-- > 0) throw new Error('preset refused'); host.setFullAccess(session); },
    rename: async (id, title) => { if (renameFails-- > 0) throw new Error('rename refused'); await host.rename(id, title); },
  }) });
  await s.life.start();
  assert.ok(s.faults().some(fault => fault.startsWith('家打不开：')));
  s.timers.advance(0); await s.idle();
  const home = s.life.snapshot().homeSessionId!;
  assert.equal(s.created(), 1); assert.ok(s.fullAccess.has(home));
  assert.ok(s.faults().some(fault => fault.startsWith('家改名失败：')));
  assert.deepEqual(s.store.wakes().map(wake => wake.source), ['first']);
  s.timers.advance(21 * 3_600_000); await s.idle();
  assert.equal(s.created(), 1); assert.equal(s.renamed.get(home), '鲸鲸的家');
  assert.ok(!s.faults().some(fault => fault.startsWith('家改名失败：')));
});
test('a reloaded runtime replaces the old registrations instead of stacking them', async t => {
  const s = await setup(t, () => textResponse('嗯'));
  const chat = await createAgent(s.ctx, 'chat');
  await s.start();
  const second = s.restart(); await second.start();
  s.timers.advance(21 * 3_600_000); await s.idle();
  const home = toolNames(s.requests.at(-1)!);
  assert.equal(count(home, 'plan_next'), 1); assert.equal(count(home, 'reach_out'), 1); assert.equal(count(home, 'read_diary'), 0);
  chat.followup(userMessage('hi')); await chat.whenIdle();
  assert.equal(count(toolNames(s.requests.at(-1)!), 'plan_next'), 1); assert.equal(count(toolNames(s.requests.at(-1)!), 'reach_out'), 0); assert.equal(count(toolNames(s.requests.at(-1)!), 'read_diary'), 0);
  assert.deepEqual(s.errors, []);
});
test('stop ends the life line: no delivery after it, and plan_next refuses', async t => {
  const { held, patch } = holdResolve(2);
  const s = await setup(t, () => textResponse('嗯'), { host: patch });
  await s.life.start();
  s.timers.advance(0);
  s.life.stop(); held.release!(); await s.idle();
  assert.equal(s.requests.length, 0); assert.equal(s.store.wakes().length, 0);
  assert.ok(s.store.read().arrival, 'the undelivered greeting stays saved');
  assert.throws(() => s.life.planNext({ after_minutes: 5 }, '还想'), /生活线已停止/);
});
test('a registration failure is a fault and never breaks agent creation', async t => {
  const s = await setup(t, () => textResponse('嗯'), { before: async worldDir => { await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'clash' })); } });
  s.ctx.on('agent/created', ({ agent }) => { if (agent.id === 'clash') agent.ctx.tools.register(testTool('plan_next', async () => 'x')); return undefined; });
  const clash = await createAgent(s.ctx, 'clash');
  assert.ok(clash);
  await s.start().catch(() => undefined);
  assert.ok(s.faults().some(fault => fault.startsWith('工具挂载失败：')));
});
test('home tool calls are logged with the outside-room flag and their outcome', async t => {
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('pwsh', { command: 'Start-Process notepad' }) : index === 1 ? toolCall('broken', {}) : textResponse('写好了'));
  s.ctx.tools.register(testTool('pwsh', async () => 'ok'));
  s.ctx.tools.register(testTool('broken', async () => { throw new Error('boom'); }));
  await s.start();
  const [day] = s.store.activityDays();
  assert.deepEqual(s.store.activity(day).map(record => [record.tool, record.summary, record.outside, record.status]), [['pwsh', 'Start-Process notepad', true, 'ok'], ['broken', '{}', false, 'error']]);
});
test('compactions in world sessions are recorded for the console', async t => {
  const s = await setup(t, request => request.purpose === 'compaction' ? textResponse('摘要') : textResponse('reply ' + 'detail '.repeat(100)));
  await s.ctx.plugin(TokenMeter).await();
  await s.ctx.plugin(ToolFreeCompaction, { auto: false, timeZone: 'UTC', headroomTokens: 0, maxTokens: 128 }).await();
  await s.start();
  const home = s.ctx.agents.get(SessionId(s.life.snapshot().homeSessionId!))!;
  assert.ok(await s.ctx.compaction.compactNow(home, new AbortController().signal));
  assert.equal(s.store.compactions().length, 1); assert.equal(s.store.compactions()[0].ok, true);
  assert.ok((s.store.compactions()[0].shadowedTokens ?? 0) > 0);
});
test('a compaction log that cannot be written is a fault', async t => {
  const s = await setup(t, request => request.purpose === 'compaction' ? textResponse('摘要') : textResponse('reply ' + 'detail '.repeat(100)), { store: store => ({ ...store, appendCompaction: () => { throw new Error('disk full'); } }) });
  await s.ctx.plugin(TokenMeter).await();
  await s.ctx.plugin(ToolFreeCompaction, { auto: false, timeZone: 'UTC', headroomTokens: 0, maxTokens: 128 }).await();
  await s.start();
  const home = s.ctx.agents.get(SessionId(s.life.snapshot().homeSessionId!))!;
  assert.ok(await s.ctx.compaction.compactNow(home, new AbortController().signal));
  assert.ok(s.faults().some(fault => fault.startsWith('压缩记录写入失败：')));
});
test('reach_out reaches the outlets with her name, and a failed push there is a fault until one works', async t => {
  const sent: unknown[] = []; let fails = true;
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('reach_out', { text: '想你了' }) : index === 1 ? toolCall('reach_out', { text: '又想你了' }, 'second') : textResponse('嗯'), {
    notifier: { toast: async () => {}, outlets: [{ name: '桌面应用', kinds: ['reach'], send: async push => { sent.push(push); if (fails) { fails = false; throw new Error('connect ECONNREFUSED'); } } }] },
  });
  const faults: string[][] = [];
  s.ctx.on('session/event', (_session, event) => { if (event.type === 'tool/result') faults.push(s.faults()); });
  await s.start();
  assert.deepEqual(sent, [{ text: '想你了', kind: 'reach', name: '鲸鲸' }, { text: '又想你了', kind: 'reach', name: '鲸鲸' }]);
  assert.deepEqual(faults[0], ['桌面应用没送到：connect ECONNREFUSED']);
  assert.ok(!s.faults().some(fault => fault.startsWith('桌面应用')), 'cleared by the next push that works');
});
test('home() opens the same home the alarm uses', async t => {
  const s = await setup(t, () => textResponse('嗯'));
  await s.start();
  assert.equal((await s.life.home()).id, s.life.snapshot().homeSessionId);
  assert.equal(s.created(), 1);
});
test('check_alarm tells her what is next; cancel_alarm puts her own alarm back to the morning fallback', async t => {
  const s = await setup(t, () => textResponse('嗯'));
  await s.start();
  assert.ok(['check_alarm', 'cancel_alarm'].every(name => toolNames(s.requests[0]!).includes(name)));
  assert.equal(s.life.checkAlarm(), '你现在没有自己定的闹钟。下一次会在 2026-10-24T09:00:00+09:00（还有 21 小时）按平常的时间叫你。');
  s.life.planNext({ after_minutes: 90 }, '看 B 站');
  assert.equal(s.life.checkAlarm(), '你说好做「看 B 站」做到 2026-10-23T13:30:00+09:00（还有 1 小时 30 分）。');
  assert.equal(s.life.cancelAlarm(), '好，取消了做到 2026-10-23T13:30:00+09:00 的安排：「看 B 站」。不另定的话，就休息到 2026-10-24T09:00:00+09:00。');
  assert.deepEqual(s.alarm(), { at: '2026-10-24T00:00:00.000Z', source: 'fallback' });
  assert.equal(s.life.cancelAlarm(), '现在没有你自己定的闹钟，不用取消。下一次会在 2026-10-24T09:00:00+09:00 按平常的时间叫你。');
  assert.deepEqual(s.alarm(), { at: '2026-10-24T00:00:00.000Z', source: 'fallback' });
});
test('a world alarm.md shapes the wake messages and the tool descriptions; an unreadable one is a fault and the shipped wording is used', async t => {
  const s = await setup(t, () => textResponse('嗯'), { before: dir => writeFile(join(dir, 'alarm.md'), '## 第一次到家\n你好呀{{name}}，{{partner}}给你搭了个家。\n## plan_next 说明\n自己定的说明，例如 {{example}}\n') });
  await s.start();
  assert.match(textOf(s.requests[0]!), /【你的时间】你好呀鲸鲸，伙伴给你搭了个家。\n接下来想做什么，用 plan_next 说好做到几点/);
  assert.equal(s.requests[0]!.tools?.find(tool => tool.name === 'plan_next')?.description, '自己定的说明，例如 2026-10-23T21:00:00+09:00');
  assert.ok(!s.faults().some(fault => fault.includes('闹钟模板')));

  const broken = await setup(t, () => textResponse('嗯'), { before: dir => mkdir(join(dir, 'alarm.md')) });
  await broken.start();
  assert.match(textOf(broken.requests[0]!), /【你的时间】这是你的家。/);
  assert.ok(broken.faults().some(fault => /闹钟模板 .* 读不了，先用默认的/.test(fault)), broken.faults().join('|'));
});
test('an alarm set from a chat session rings at home, not in the chat', async t => {
  const sessionOf = (request: GenerateOptions) => (request as { sessionId?: string }).sessionId;
  let asked = false;
  const s = await setup(t, request => {
    if (sessionOf(request) === 'chat' && !asked) { asked = true; return toolCall('plan_next', { after_minutes: 30, note: '提醒伙伴喝水' }); }
    return textResponse('嗯');
  });
  await s.start();
  const chat = await createAgent(s.ctx, 'chat');
  chat.followup(userMessage('半小时后提醒我喝水')); await chat.whenIdle();
  assert.equal(s.alarm()?.source, 'plan');
  const before = s.requests.length;
  s.timers.advance(30 * 60_000); await s.idle();
  const home = s.life.snapshot().homeSessionId!;
  const rung = s.requests.slice(before).filter(request => sessionOf(request) === home);
  assert.equal(rung.length, 1);
  assert.match(textOf(rung[0]!), /【你的时间】[^ ]+ 到了，这是你说好做到的时间：「提醒伙伴喝水」/);
  assert.ok(!s.requests.slice(before).some(request => sessionOf(request) === 'chat'));
});
