import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createUserMessage, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createWechatModule } from '../src/ecosystem/wechat/index.ts';
import { createWechatRecorder } from '../src/ecosystem/wechat/archive.ts';
import { createArchiveStore } from '../src/store.ts';
import { createWorldRuntime } from '../src/runtime.ts';
import { createWechatSending } from '../src/ecosystem/wechat/sending.ts';
import { hostFixture, textResponse } from './hostFixture.ts';

const chats = [{ id: 'owner', name: '伙伴' }, { id: 'family@chatroom', name: '家庭群' }];
const registration = { accountId: 'wxid_bot', chats };
const words = [{ type: 'text', text: '想跟你说句话' }, { type: 'sticker', stickerId: 'st_hi' }, { type: 'text', text: '晚安' }];
async function* call(name: string, args: object): AsyncIterable<StreamChunk> {
  const block = { type: 'tool-call' as const, id: ToolCallId('proactive'), name, arguments: JSON.stringify(args) };
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments };
  yield { type: 'block-end', index: 0, block };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}

test('a desktop turn can send to either bound chat through persistent tools and one durable queue', async t => {
  let calls = 0;
  const { ctx, root, cleanup } = await hostFixture(t, () => calls++ === 0 ? call('wechat_send', { chatId: 'family@chatroom', messages: words }) : textResponse('这段留在家里'));
  const store = createArchiveStore({ root, worldId: 'test', agentPreset: 'test', timeZone: 'UTC' }); cleanup.push(() => store.close());
  const world = createWorldRuntime(ctx, { worldId: 'test', agentPreset: 'test', timeZone: 'UTC' }, store);
  await world.start(); cleanup.push(() => world.stop());
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), meta: { agentPreset: 'test' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  const file = join(root, 'wechat.json');
  const module = createWechatModule({ ctx, file, worldId: 'test', acceptAgent: candidate => candidate.id === agent.id, home: async () => agent, origin: () => 'http://127.0.0.1:1', allowedHosts: [], ...createWechatRecorder(store, 'test') });
  module.start(); cleanup.push(() => module.stop());
  assert.ok(agent.ctx.tools.get('wechat_send', agent), 'sending is available before any WeChat inbound message');
  assert.ok(agent.ctx.tools.get('wechat_chats', agent));
  assert.ok(agent.ctx.tools.get('wechat_delivery', agent));
  const server = createServer((req, res) => { void module.route.handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const { token, path } = JSON.parse(await readFile(file, 'utf8'));
  const post = (body: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-world-token': token }, body: JSON.stringify(body) });
  assert.equal((await post({ outbox: registration })).status, 200);
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '去跟家人打招呼' }] }));
  await agent.whenIdle(); await ctx.sessions.flush(agent.session); await world.flush();
  const result = await (await post({ outbox: registration })).json();
  assert.equal(result.job.chatId, 'family@chatroom');
  assert.equal(result.job.accountId, 'wxid_bot');
  assert.deepEqual(result.job.messages, words);
  assert.deepEqual((await (await post({ outbox: registration })).json()).job, result.job, 'an unacknowledged claim is returned with the same ID');
  assert.ok(agent.ctx.tools.get('wechat_send', agent), 'the tool survives the end of the turn');
  const record = (await store.readPage({ worldId: 'test', limit: 10 })).records.find(item => item.recordId === result.job.id);
  assert.ok(record);
  assert.match(record.content, /想跟你说句话[\s\S]*st_hi[\s\S]*晚安/);
  assert.doesNotMatch(record.content, /arguments|tool-call/);
  assert.equal(record.speakerId, 'wechat:wxid_bot');
  assert.equal((await post({ receipt: { id: result.job.id, confirmed: 3, status: 'sent' } })).status, 200);
  assert.equal((await (await post({ outbox: registration })).json()).job, undefined);
  const confirmed = (await store.readPage({ worldId: 'test', limit: 10 })).records.find(item => item.recordId === result.job.id)!;
  assert.equal(confirmed.wechatDelivery?.status, 'sent');
  assert.equal((await post({ outbox: { ...registration, accountId: 'other_bot' } })).status, 400);
});

test('an unconfigured target is rejected without queuing or archiving words as sent', async t => {
  let calls = 0;
  const { ctx, root, cleanup } = await hostFixture(t, () => calls++ === 0 ? call('wechat_send', { chatId: 'stranger', messages: words }) : textResponse('没有发出'));
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const sending = createWechatSending({ ctx, file: join(root, 'outbox.sqlite'), worldId: 'test' }); cleanup.push(() => sending.stop());
  for (const tool of sending.tools) cleanup.push(agent.ctx.tools.register(tool));
  await sending.poll(registration);
  assert.ok(agent.ctx.tools.get('wechat_send', agent));
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '主动说话' }] })); await agent.whenIdle();
  const failed = agent.session.snapshotEvents().find(event => event.type === 'tool/result');
  assert.equal(failed?.type === 'tool/result' && failed.data.message.isError, true);
  assert.ok(!agent.session.deriveMessages().some(message => message.source.kind === 'dsh-world-wechat-outgoing'));
  assert.equal(await sending.poll(registration), undefined);
});

test('claimed sends survive a host restart and group-origin sends respect the home-only archive', async t => {
  let calls = 0;
  const { ctx, root, cleanup } = await hostFixture(t, () => calls++ === 0 ? call('wechat_send', { chatId: 'owner', messages: words }) : textResponse('已安排'));
  const config = { root, worldId: 'test', agentPreset: 'test', timeZone: 'UTC', archiveScope: 'home' as const };
  const store = createArchiveStore(config); cleanup.push(() => store.close());
  const isHome = (id: string) => id === 'home';
  const world = createWorldRuntime(ctx, config, store, { prompt: { names: { companion: '鲸鲸', partner: '伙伴' } }, isHome, archiveSession: isHome }); await world.start(); cleanup.push(() => world.stop());
  const agent = (await ctx.agents.create({ sessionId: SessionId('group'), meta: { agentPreset: 'test' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  const file = join(root, 'outbox.sqlite');
  let sending = createWechatSending({ ctx, file, worldId: 'test', ...createWechatRecorder(store, 'test', isHome) });
  cleanup.push(() => sending.stop());
  for (const tool of sending.tools) cleanup.push(agent.ctx.tools.register(tool));
  await sending.poll(registration);
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '从群会话主动联系伙伴' }] }));
  await agent.whenIdle(); await world.flush();
  const claimed = await sending.poll(registration); assert.ok(claimed);
  assert.equal((await store.readPage({ worldId: 'test', limit: 10 })).records.length, 0);
  assert.match(JSON.stringify(agent.session.snapshotEvents()), /dsh-world-wechat-outgoing/);
  await sending.stop();
  sending = createWechatSending({ ctx, file, worldId: 'test', ...createWechatRecorder(store, 'test', isHome) });
  assert.deepEqual(await sending.poll(registration), claimed);
  await sending.receipt({ id: claimed.id, confirmed: 3, status: 'sent' });
  assert.equal(await sending.poll(registration), undefined);
  assert.equal(store.delivery(claimed.id)?.status, 'sent');
  assert.equal((await store.readPage({ worldId: 'test', limit: 10 })).records.length, 0);
  await world.stop();
  const expanded = createWorldRuntime(ctx, { ...config, archiveScope: 'workspace' }, store, { prompt: { names: { companion: '鲸鲸', partner: '伙伴' } }, isHome, archiveSession: () => true });
  await expanded.start(); cleanup.push(() => expanded.stop()); await expanded.flush();
  let recovered = (await store.readPage({ worldId: 'test', limit: 10 })).records.find(record => record.recordId === claimed.id);
  assert.equal(recovered?.wechatDelivery?.status, 'sent', 'scope expansion preserves the receipt already confirmed outside shared memory');
  await sending.receipt({ id: claimed.id, confirmed: 3, status: 'sent' });
  recovered = (await store.readPage({ worldId: 'test', limit: 10 })).records.find(record => record.recordId === claimed.id);
  assert.equal(recovered?.wechatDelivery?.confirmed, 3);
});

test('a send never becomes deliverable when its originating session cannot be flushed', async t => {
  let calls = 0;
  const { ctx, root, cleanup } = await hostFixture(t, () => calls++ === 0 ? call('wechat_send', { chatId: 'owner', messages: words }) : textResponse('留在家里'));
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const sending = createWechatSending({ ctx, file: join(root, 'outbox.sqlite'), worldId: 'test' }); cleanup.push(() => sending.stop());
  for (const tool of sending.tools) cleanup.push(agent.ctx.tools.register(tool));
  await sending.poll(registration);
  const off = ctx.on('session/flush', async session => {
    if (session.id === agent.id && session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'dsh-world-wechat-outgoing')) throw new Error('source disk failure');
  });
  try {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '试着发送' }] })); await agent.whenIdle();
    assert.equal(await sending.poll(registration), undefined);
  } finally { off(); }
});
