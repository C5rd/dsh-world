// 原生通道（qq-native 的模块层）的护栏。
//
// 这一层之前一条测试都没有 —— 去重、白名单、开关、回包全靠真机试。这里把传输层换成假的，
// 事件直接灌进来，跑的是真的 home.ask 和真的 agent，所以「有没有花掉一轮」是真数出来的。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';
import { hostFixture, textResponse } from './hostFixture.ts';
import { createQqNativeModule, type QqNativeConfig, type QqTransport, type QqTransportOptions } from '../src/ecosystem/qq-native/index.ts';
import { DEFAULT_QQ_PROACTIVE_POLICY } from '../src/ecosystem/qq-native/proactive.ts';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** 传输层的替身：记下通道交给它的回调，测试拿它们灌事件。 */
function fakeTransport() {
  const sent: { kind: string; to: string; text: string }[] = [];
  let options: QqTransportOptions | undefined;
  let state = 'closed';
  const factory = (next: QqTransportOptions): QqTransport => {
    options = next;
    return {
      async start() { state = 'online'; },
      async stop() { state = 'closed'; },
      getState: () => state,
      async sendGroup(groupId: string, text: string) { sent.push({ kind: 'group', to: groupId, text }); return { messageId: 'g1' }; },
      async sendPrivate(userId: string, text: string) { sent.push({ kind: 'private', to: userId, text }); return { messageId: 'p1' }; },
    };
  };
  return {
    factory,
    sent,
    emit: (message: unknown) => options?.onPrivateMessage?.(message),
    emitGroup: (message: unknown) => options?.onGroupMessage?.(message),
  };
}

/** 传输层交出来的归一化形状。 */
const incoming = (over: Partial<{ kind: 'group' | 'private'; groupId: string | null; userId: string; messageId: string; selfId: string; text: string; segments: Array<{ type?: string; data?: Record<string, unknown> }> }> = {}) => ({
  kind: 'private' as const, groupId: null, userId: '3475994805', messageId: '7999', selfId: '2039693365', text: '在吗',
  ...over,
});

const configOf = (over: Partial<QqNativeConfig> = {}): QqNativeConfig => ({
  enabled: true,
  wsUrl: 'ws://127.0.0.1:1',
  accessToken: '',
  allowPrivate: ['3475994805'],
  allowGroups: ['681528723'],
  autoReply: true,
  contextMessages: 3,
  bindHomeSession: 'none',
  groupTrigger: 'mention',
  groupKeywords: [],
  proactive: { enabled: false, dryRun: false, policy: {} },
  ...over,
});

async function settle(ms = 400) { await new Promise(resolve => setTimeout(resolve, ms)); }

test('关掉自动回复就是「收到但不理」：连问都不问，一轮都不花', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('回完了'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf({ autoReply: false }), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  wire.emit(incoming());
  await settle();

  assert.equal(turns, 0, '关着自动回复不该有回合');
  assert.equal(wire.sent.length, 0, '也不该往外发东西');
  assert.ok(channel.status().lastEventAt, '但消息确实收到了（lastEventAt 有值）');
});

test('开着自动回复：花一轮，把这轮的话发回同一个人', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('回完了'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf(), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  wire.emit(incoming());
  await settle(600);

  assert.equal(turns, 1);
  assert.deepEqual(wire.sent, [{ kind: 'private', to: '3475994805', text: '回完了' }]);
  assert.equal(channel.status().sent, 1);
  assert.equal(channel.status().failed, 0);
});

test('三条不该问的：重复的 id、不在白名单的、她自己发的', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('回完了'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf(), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  wire.emit(incoming({ messageId: '8001' }));
  await settle(600);
  assert.equal(turns, 1, '第一条该问');

  wire.emit(incoming({ messageId: '8001' }));                       // 同一条消息的重投
  wire.emit(incoming({ messageId: '8002', userId: '999999' }));     // 不在白名单
  wire.emit(incoming({ messageId: '8003', userId: '2039693365' })); // 她自己发的（回声）
  wire.emit(incoming({ messageId: '' }));                           // 协议里没给 id：不拦，但也别当重复
  await settle(600);
  assert.equal(turns, 2, '只有「没 id 的那条」该再多一次；重复/白名单外/自己的都不算');
});

test('群里说话也走同一条线，回包发回群里', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('群里回一句'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf(), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  // 现在群里默认只接被叫到的：给个 @ 段，这条测的是「回包发回群里」而不是闸门。
  wire.emitGroup(incoming({
    kind: 'group', groupId: '681528723', userId: '3997750133', messageId: '9001', text: '@2039693365 大家好',
    segments: [{ type: 'at', data: { qq: '2039693365' } }, { type: 'text', data: { text: ' 大家好' } }],
  }));
  await settle(600);

  assert.equal(turns, 1);
  assert.deepEqual(wire.sent, [{ kind: 'group', to: '681528723', text: '群里回一句' }]);
});

test('面板上那两个开关：当场起停「先开口」的引擎，开关写进 stateFile', async t => {
  const { ctx, cleanup } = await hostFixture(t, () => textResponse('不该被问到'));
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const dir = mkdtempSync(join(tmpdir(), 'qq-native-switch-'));
  const stateFile = join(dir, 'qq-native.json');
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf(), logger: quiet, transport: wire.factory, stateFile });
  channel.start(); cleanup.push(channel.stop);

  assert.equal(channel.status().proactive, null, '出厂是关的：状态里连引擎都没有');

  // 打开：引擎当场起来（演练模式一起开着，免得它真去问她 —— 这一条测的是开关，不是判定）
  const on = channel.setProactive({ enabled: true, dryRun: true });
  assert.equal(on.proactive?.enabled, true);
  assert.equal(on.proactive?.dryRun, true, 'dryRun 要真的读穿到引擎里');
  assert.equal(on.proactive?.policy.idleThresholdMs, DEFAULT_QQ_PROACTIVE_POLICY.idleThresholdMs, '策略没给就用默认那套');

  // 只拨 dryRun：enabled 不受影响
  const flipped = channel.setProactive({ dryRun: false });
  assert.equal(flipped.proactive?.enabled, true);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).proactive, { enabled: true, dryRun: false });

  // 关掉：引擎停掉，状态里就没了
  assert.equal(channel.setProactive({ enabled: false }).proactive, null);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).proactive, { enabled: false, dryRun: false });
});

test('群里没叫她就不接：只记上下文，不花一轮', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('不该被问到'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf(), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  // 一句普通群聊：没 @、没引用、没关键词
  wire.emitGroup(incoming({ kind: 'group', groupId: '681528723', userId: '3997750133', messageId: '9101', text: '中午吃什么' }));
  await settle(600);

  assert.equal(turns, 0, '没叫到她的群消息不该花一轮');
  assert.equal(wire.sent.length, 0, '也不该往群里冒泡');
  assert.ok(channel.status().lastEventAt, '但消息确实收到了');
});

test('群里被 @ 到、或者有人引用她刚说的话，才递给她', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('在'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf(), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  // 被 @：at 段指着她自己的号
  wire.emitGroup(incoming({
    kind: 'group', groupId: '681528723', userId: '3997750133', messageId: '9201', text: '@2039693365 在吗',
    segments: [{ type: 'at', data: { qq: '2039693365' } }, { type: 'text', data: { text: ' 在吗' } }],
  }));
  await settle(600);
  assert.equal(turns, 1, '@ 到她就该接');
  assert.equal(wire.sent.length, 1);

  // 引用她刚回的那句：她发出去的消息 id 是 g1（假传输层固定返回的）
  wire.emitGroup(incoming({
    kind: 'group', groupId: '681528723', userId: '3997750133', messageId: '9202', text: '[引用消息] 这句什么意思',
    segments: [{ type: 'reply', data: { id: 'g1' } }, { type: 'text', data: { text: ' 这句什么意思' } }],
  }));
  await settle(600);
  assert.equal(turns, 2, '有人引用她的话也是冲着她来的');
});

test('命中关键词也算在叫她；私聊不受这个闸门管', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('在'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf({ groupKeywords: ['大肥鱼'] }), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  wire.emitGroup(incoming({ kind: 'group', groupId: '681528723', userId: '3997750133', messageId: '9301', text: '大肥鱼呢' }));
  await settle(600);
  assert.equal(turns, 1, '关键词命中就该接');

  // 私聊：不管关键词、不管 @，一律接
  wire.emit(incoming({ messageId: '9302', text: '喂' }));
  await settle(600);
  assert.equal(turns, 2, '私聊照旧每句都接');
});

test('groupTrigger 拨成 all：群里每句都接（逃生口）', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('在'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf({ groupTrigger: 'all' }), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  wire.emitGroup(incoming({ kind: 'group', groupId: '681528723', userId: '3997750133', messageId: '9401', text: '随便说一句' }));
  await settle(600);
  assert.equal(turns, 1, 'all 就是老的「句句都接」');
});

test('不在白名单的消息：到过、被挡下，状态里分得出来', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('不该被问到'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf(), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  wire.emit(incoming({ userId: '111111', messageId: '9501' }));
  await settle();

  const status = channel.status();
  assert.equal(turns, 0, '不在白名单不该问她');
  assert.equal(status.blocked, 1, '但要记一笔：这条确实到过通道');
  assert.ok(status.lastBlockedAt, '时间戳也留着');
  assert.ok(status.lastEventAt, 'lastEventAt 同时会动 —— 两个数一起看才知道是「送到了但被挡」');
});
