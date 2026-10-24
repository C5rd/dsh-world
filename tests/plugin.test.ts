import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { Context } from '@deepseek-ai/cordis';
import { join } from 'node:path';
import { createUserMessage, isAgentLoopRequest, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { hostFixture, mountCompaction, textResponse } from './hostFixture.ts';
import { createWorldRuntime } from '../src/index.ts';
import * as worldPlugin from '../src/index.ts';
import { createArchiveStore } from '../src/store.ts';
import { record } from './fixtures.ts';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import ToolFreeCompaction from '../src/compaction.ts';
declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'test-schedule': { kind: 'test-schedule' } } }

const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'Asia/Seoul' };
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const textOf = (request: GenerateOptions) => request.messages.map(m => m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')).join('\n');
const kinds = (request: GenerateOptions) => request.messages.map(m => m.source?.kind as string | undefined);
/** Mirrors the host time-context plugin: the outermost pre-step listener appends its snapshot last. */
function hostTime(ctx: Context) {
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next();
    return decision.kind === 'reject' ? decision : { ...decision, messages: [...decision.messages, createUserMessage({ source: { kind: 'time-context' } as never, content: [{ type: 'text', text: 'Time sampled by host' }] })] };
  }, { prepend: true });
}

test('real host sends A memory in B once, keeps it across a same-step retry, and archives only conversation text', async t => {
  const requests: GenerateOptions[] = []; let retry = false;
  const { ctx, root, cleanup } = await hostFixture(t, async function* (request) {
    requests.push(request);
    if (retry) { retry = false; yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'retry' } } }; return; }
    yield* textResponse('visible reply');
  });
  hostTime(ctx);
  const store = createArchiveStore({ ...config, root });
  const world = createWorldRuntime(ctx, config, store);
  await world.start(); cleanup.push(() => world.stop());
  const a = await ctx.agents.create({ sessionId: SessionId('a'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  a.agent.followup(user('remember exact words')); await a.agent.whenIdle(); await world.flush();
  const b = await ctx.agents.create({ sessionId: SessionId('b'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  retry = true;
  const dispose = ctx.on('agent/request-error', async () => ({ kind: 'retry' }));
  b.agent.followup(user('hello again')); await b.agent.whenIdle(); dispose(); await world.flush();
  assert.equal(requests.length, 3);
  for (const request of requests.slice(1)) {
    assert.ok(textOf(request).includes('remember exact words') && textOf(request).includes('visible reply'));
    assert.equal(kinds(request).filter(kind => kind === 'dsh-world-history').length, 1);
    assert.equal(kinds(request).at(-1), 'time-context');
  }
  assert.equal(requests[1].messages.find(m => m.source?.kind === 'dsh-world-history')!.id, requests[2].messages.find(m => m.source?.kind === 'dsh-world-history')!.id);
  const days = await readdir(join(root, 'worlds/fish/conversations'));
  const rows = (await Promise.all(days.map(day => readFile(join(root, 'worlds/fish/conversations', day), 'utf8')))).join('').trim().split('\n').map(s => JSON.parse(s));
  assert.equal(rows.length, 4);
  assert.ok(rows.every(r => !r.content.includes('Time sampled') && !r.content.includes('最近的聊天记忆')));
});
test('tool continuation keeps call/result pairing and does not re-admit the frozen memory block', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, async function* (request) {
    requests.push(request);
    if (requests.length === 1) {
      const block = { type: 'tool-call' as const, id: ToolCallId('call'), name: 'clock', arguments: '{}' };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: 'clock', argumentsDelta: '{}' };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    yield* textResponse('done');
  });
  ctx.tools.register(defineTool({ name: 'clock', description: 'test', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'tool result' }));
  const store = createArchiveStore({ ...config, root });
  await store.appendRecords([record('seed', { content: 'earlier memory' })]);
  const world = createWorldRuntime(ctx, config, store); await world.start(); cleanup.push(() => world.stop());
  const handle = await ctx.agents.create({ sessionId: SessionId('tool-session'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('use clock')); await handle.agent.whenIdle();
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some(m => m.role === 'tool' && m.toolCallId === 'call'));
  assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length), requests[0].messages, 'the continuation extends the previous request unchanged');
  assert.equal(kinds(requests[1]).filter(kind => kind === 'dsh-world-history').length, 1);
});
test('memory loads through pre-step, host time stays last, and tool-step compaction re-admits memory after the summary', async t => {
  const requests: GenerateOptions[] = []; let calls = 0;
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) {
    if (request.purpose === 'compaction') { yield* textResponse('用户问好，鲸鲸调用工具后准备回答。'); return; }
    requests.push(request);
    if (++calls === 1) {
      const block = { type: 'tool-call' as const, id: ToolCallId('stock-call'), name: 'work', arguments: '{}' };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: '{}' };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    yield* textResponse('reply');
  });
  hostTime(ctx);
  ctx.tools.register(defineTool({ name: 'work', description: 'test', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'STOCK_TOOL_RESULT' }));
  await ctx.plugin(TokenMeter).await();
  await ctx.plugin(ToolFreeCompaction, { auto: true, timeZone: 'Asia/Seoul', headroomTokens: 0, thresholdRatio: 0.0002, maxTokens: 128 }).await();
  const store = createArchiveStore({ ...config, root });
  await store.appendRecords([record('stock-seed', { content: 'memory from yesterday ' + 'detail '.repeat(30) })]);
  const world = createWorldRuntime(ctx, config, store); await world.start(); cleanup.push(() => world.stop());
  const handle = await ctx.agents.create({ sessionId: SessionId('stock'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('hello ' + 'words '.repeat(200))); await handle.agent.whenIdle();
  assert.equal(errors.length, 0, errors.map(e => String((e as { error: Error }).error)).join('\n'));
  assert.equal(requests.length, 2);
  const first = kinds(requests[0]);
  assert.ok(first.indexOf('dsh-world-history') < first.indexOf('user'), first.join(','));
  assert.equal(first.at(-1), 'time-context');
  // The tool step was compacted away, so the continuation re-admits memory after the summary.
  const resumed = kinds(requests[1]);
  assert.deepEqual(resumed.slice(0, 3), ['system-prompt', 'compact-checkpoint', 'dsh-world-history'], resumed.join(','));
  assert.ok(!requests[1].messages.some(m => m.role === 'tool' || m.content.some(b => b.type === 'tool-call')));
  assert.ok(textOf(requests[1]).includes('memory from yesterday'));
  assert.equal(resumed.filter(kind => kind === 'dsh-world-history').length, 1);
});
test('proactive assistant text is archived without turning its scheduler prompt into a user message', async t => {
  const { ctx, root, cleanup } = await hostFixture(t, () => textResponse('proactive hello'));
  const store = createArchiveStore({ ...config, root }); const world = createWorldRuntime(ctx, config, store);
  await world.start(); cleanup.push(() => world.stop());
  const handle = await ctx.agents.create({ sessionId: SessionId('proactive'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(createUserMessage({ source: { kind: 'test-schedule' }, content: [{ type: 'text', text: 'internal scheduled trigger' }] }));
  await handle.agent.whenIdle(); await world.flush();
  const records = (await store.readPage({ worldId: 'fish', limit: 10 })).records;
  assert.deepEqual(records.map(r => [r.role, r.content]), [['assistant', 'proactive hello']]);
});
test('unload, reload, restored sessions and fork inheritance preserve IDs without duplicate listeners', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); });
  let store = createArchiveStore({ ...config, root }); let world = createWorldRuntime(ctx, config, store);
  await world.start(); cleanup.push(() => world.stop());
  const options = { provider: 'test', model: 'test' };
  let a = await ctx.agents.create({ sessionId: SessionId('original'), meta: { agentPreset: 'companion' }, agentOptions: options });
  a.agent.followup(user('first exact message')); await a.agent.whenIdle(); await world.flush();
  const seed = a.agent.session.snapshotEvents();
  await a.dispose(); await world.stop();
  store = createArchiveStore({ ...config, root }); world = createWorldRuntime(ctx, config, store); await world.start();
  a = await ctx.agents.resume({ resumeSessionId: SessionId('original'), agentOptions: options });
  a.agent.followup(user('second exact message')); await a.agent.whenIdle(); await world.flush();
  const b = await ctx.agents.create({ sessionId: SessionId('branch'), meta: { agentPreset: 'companion', parentSession: SessionId('original'), isSeeded: true }, seed, inheritedEventCount: seed.length as never, agentOptions: options });
  b.agent.followup(user('branch own message')); await b.agent.whenIdle(); await world.flush();
  assert.equal(errors.length, 0);
  assert.equal((await store.readPage({ worldId: 'fish', limit: 100 })).records.length, 6);
  assert.equal((textOf(requests[1]).match(/first exact message/g) ?? []).length, 1);
});
test('successful compaction reloads the newest archive once, including newer conversations in other sessions', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) { if (isAgentLoopRequest(request)) requests.push(request); yield* textResponse(isAgentLoopRequest(request) ? 'reply' : 'compacted summary'); });
  await mountCompaction(ctx);
  const store = createArchiveStore({ ...config, root });
  await store.appendRecords([{ schemaVersion: 1, worldId: 'fish', recordId: 'old', sourceSessionId: 'old', sourceMessageId: 'old', sourceSeq: 1, turnId: 'old:1', role: 'assistant', occurredAt: '2026-01-01T00:00:00.000Z', content: 'full original memory', status: 'complete' }]);
  const world = createWorldRuntime(ctx, config, store); await world.start(); cleanup.push(() => world.stop());
  const handle = await ctx.agents.create({ sessionId: SessionId('compact'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('first ' + 'context '.repeat(200))); await handle.agent.whenIdle();
  await store.appendRecords([{ schemaVersion: 1, worldId: 'fish', recordId: 'new', sourceSessionId: 'other', sourceMessageId: 'new', sourceSeq: 1, turnId: 'other:1', role: 'assistant', occurredAt: '2026-10-23T23:59:00.000Z', content: 'new memory from another conversation', status: 'complete' }]);
  handle.agent.followup(user('before compaction')); await handle.agent.whenIdle();
  assert.ok(!textOf(requests[1]).includes('new memory from another conversation'));
  const compacted = await ctx.compaction.compactNow(handle.agent, new AbortController().signal);
  assert.ok(compacted);
  handle.agent.followup(user('next')); await handle.agent.whenIdle();
  assert.equal(errors.length, 0, errors.map(e => String((e as { error: Error }).error.stack)).join('\n')); assert.equal(requests.length, 3);
  assert.ok(textOf(requests[2]).includes('full original memory'));
  assert.ok(textOf(requests[2]).includes('new memory from another conversation'));
  handle.agent.followup(user('one more')); await handle.agent.whenIdle();
  assert.equal(requests[2].messages.find(m => m.source?.kind === 'dsh-world-history')!.id, requests[3].messages.find(m => m.source?.kind === 'dsh-world-history')!.id);
});
test('overflow remains eligible for host recovery and reports an explicit capacity failure if recovery cannot fit', async t => {
  let calls = 0;
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* () { calls++; yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'provider context exceeded' } } }; });
  const world = createWorldRuntime(ctx, config, createArchiveStore({ ...config, root })); await world.start(); cleanup.push(() => world.stop());
  ctx.on('agent/request-error', async () => calls < 2 ? { kind: 'retry' } : undefined);
  const handle = await ctx.agents.create({ sessionId: SessionId('capacity'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('too large')); await handle.agent.whenIdle();
  assert.equal(calls, 2);
  assert.equal(errors.length, 1);
  assert.match(String((errors[0] as { error: Error }).error), /容量不足/);
});
test('automatic tool-free compaction is followed by the latest 200 turns before the next conversation request', async t => {
  const requests: GenerateOptions[] = []; const summaries: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) {
    if (isAgentLoopRequest(request)) { requests.push(request); yield* textResponse('conversation response'); }
    else { summaries.push(request); yield* textResponse('short host summary'); }
  });
  await ctx.plugin(TokenMeter).await();
  await ctx.plugin(ToolFreeCompaction, { auto: true, timeZone: 'Asia/Seoul', thresholdRatio: 0.0002, retainTokens: 0, headroomTokens: 0, maxTokens: 128 }).await();
  const store = createArchiveStore({ ...config, root });
  await store.appendRecords(Array.from({ length: 200 }, (_, i) => record(`seed${i}`, { turnId: `seed:${i}`, sourceSessionId: 'seed', occurredAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), content: `seed-message-${i}` })));
  const world = createWorldRuntime(ctx, config, store); await world.start(); cleanup.push(() => world.stop());
  ctx.systemPrompt.context({ name: 'test-runtime', order: 0, text: 'CURRENT_RUNTIME_CONTEXT' });
  const handle = await ctx.agents.create({ sessionId: SessionId('auto-compact'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('first')); await handle.agent.whenIdle();
  handle.agent.followup(user('second')); await handle.agent.whenIdle(); await world.flush();
  assert.equal(errors.length, 0, errors.map(e => String((e as { error: Error }).error)).join('\n'));
  assert.ok(summaries.length > 0); assert.equal(requests.length, 2);
  // The memory block is replayed unchanged as cacheable prefix; the instruction keeps it out of the summary.
  const memoryBefore = requests[0].messages.find(m => m.source?.kind === 'dsh-world-history')!;
  for (const summary of summaries) {
    assert.deepEqual(summary.messages.find(m => m.source?.kind === 'dsh-world-history'), memoryBefore);
    assert.match(textOf({ ...summary, messages: [summary.messages.at(-1)!] }), /记忆资料.*不要写进摘要/s);
  }
  const memory = requests[1].messages.find(m => m.source?.kind === 'dsh-world-history')!;
  const turns = memory.content.filter(b => b.type === 'text')[0].text.split('\n').slice(1).map(line => JSON.parse(line));
  assert.equal(turns.length, 200);
  assert.ok(turns.some(turn => turn.session === 'auto-com' && turn.messages.some((message: { content: string }) => message.content === 'first')));
  assert.ok(!turns.some(turn => turn.messages.some((message: { content: string }) => message.content === 'seed-message-0')));
  assert.equal(requests[1].messages.filter(m => m.source?.kind === 'dsh-world-history').length, 1);
  // Memory block ahead of the new input; the host's own order after it.
  for (const [request, text] of [[requests[0], 'first'], [requests[1], 'second']] as const) {
    const order = kinds(request);
    const memory = order.indexOf('dsh-world-history');
    const input = request.messages.findIndex(m => m.source?.kind === 'user' && textOf({ ...request, messages: [m] }) === text);
    assert.ok(memory > 0 && memory < input, `memory before new input: ${order.join(',')}`);
    assert.ok(order.slice(memory + 1).every(kind => kind === 'user' || kind === 'runtime-context'));
    assert.ok(input < order.indexOf('runtime-context'), `host admission order is unchanged: ${order.join(',')}`);
  }
  assert.equal(requests[1].messages[0].role, 'system');
  assert.equal(requests[1].messages[1].source?.kind, 'compact-checkpoint');
});
test('Cordis plugin mounting uses isolated DSH_HOME and unload/reload disposes all resources', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); });
  const originalDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  let plugin;
  try { plugin = ctx.plugin(worldPlugin, config); await plugin.await(); }
  finally { if (originalDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalDshHome; }
  const handle = await ctx.agents.create({ sessionId: SessionId('mounted'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('mounted first')); await handle.agent.whenIdle(); await plugin.dispose();
  process.env.DSH_HOME = root;
  try { plugin = ctx.plugin(worldPlugin, config); await plugin.await(); }
  finally { if (originalDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalDshHome; }
  cleanup.push(() => plugin.dispose());
  handle.agent.followup(user('mounted second')); await handle.agent.whenIdle();
  assert.equal(errors.length, 0); assert.equal(requests.length, 2);
});
test('works as installed: with no config the standard preset gets the world prompt and a world named default, and <world>/world-prompt.md replaces the shipped template', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); });
  isolateHome(t, root);
  const systemOf = (request: GenerateOptions) => request.messages.filter(m => m.role === 'system').map(m => m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')).join('\n');
  const plugin = ctx.plugin(worldPlugin, {}); cleanup.push(() => plugin.dispose()); await plugin.await();
  const standard = await ctx.agents.create({ sessionId: SessionId('installed'), meta: { agentPreset: 'standard' }, agentOptions: { provider: 'test', model: 'test' } });
  standard.agent.followup(user('第一次见面')); await standard.agent.whenIdle();
  assert.match(systemOf(requests[0]!), /你不只是一个助手[\s\S]*## 我是谁[\s\S]*worlds[\\/]default[\\/]room[\\/]我是谁\.md/);
  await plugin.dispose();
  const archive = createArchiveStore({ worldId: 'default', agentPreset: 'standard', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, root });
  const records = await archive.readPage({ worldId: 'default', limit: 10 }).then(page => page.records).finally(() => archive.close());
  assert.deepEqual(records.filter(r => r.role === 'user').map(r => r.content), ['第一次见面']);

  await writeFile(join(root, 'worlds/default/world-prompt.md'), '我自己的开头，{{name}}。\n\n{{self}}');
  const named = ctx.plugin(worldPlugin, { companionName: '小鱼' }); cleanup.push(() => named.dispose()); await named.await();
  const second = await ctx.agents.create({ sessionId: SessionId('installed-2'), meta: { agentPreset: 'standard' }, agentOptions: { provider: 'test', model: 'test' } });
  second.agent.followup(user('又见面了')); await second.agent.whenIdle();
  assert.match(systemOf(requests.at(-1)!), /^[\s\S]*我自己的开头，小鱼。\n\n## 我是谁/);
  assert.ok(!systemOf(requests.at(-1)!).includes('你不只是一个助手'));
  assert.equal(errors.length, 0);
});
test('the bundled patch inserts the row enabled', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /- insert:\s*\n\s*- id: dsh-world\s*\n\s*name: dsh-world/); assert.doesNotMatch(patch, /disabled:\s*true/);
});
/** Points DSH_HOME at the fixture root for the rest of the test. */
function isolateHome(t: TestContext, root: string) {
  const originalDshHome = process.env.DSH_HOME; process.env.DSH_HOME = root;
  t.after(() => { if (originalDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalDshHome; });
}
/** Fake desktop host services; `ctx.provide(name, value)` registers each on the root fiber in Cordis 4. */
function provideLifeHost(ctx: Context) {
  const routes: { path: string }[] = []; const unregistered: string[] = []; let created = 0;
  ctx.provide('webServer', { getOrigin: () => 'http://127.0.0.1:0', register: (route: { path: string }) => { routes.push(route); return () => { unregistered.push(route.path); }; } });
  ctx.provide('permissionPresets', { set: () => {} });
  ctx.provide('sessionController', {
    create: async ({ agentPreset }: { agentPreset: string }) => ({ sessionId: (await ctx.agents.create({ sessionId: SessionId(`life-home-${++created}`), meta: { agentPreset }, agentOptions: { provider: 'test', model: 'test' } })).agent.id }),
    resolveAgent: async (id: string) => { const agent = ctx.agents.get(SessionId(id)); return agent ? { agent } : { error: { code: 'session/not-found', message: 'missing' } }; },
    rename: async () => ({}),
  });
  return { routes, unregistered };
}
async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`timed out waiting for ${what}`);
}
function captureErrors(ctx: Context) {
  const logged: string[] = [];
  ctx.logger.exporter({ export: message => { if (message.type === 'error') logged.push(message.args.map(arg => arg instanceof Error ? arg.message : String(arg)).join(' ')); } });
  return logged;
}
async function consoleGet(routes: { path: string }[], url: string) {
  const route = routes.find(entry => entry.path === '/dsh-world') as unknown as { handler(req: unknown, res: unknown): Promise<void> };
  let status = 0; let body = '';
  await route.handler({ method: 'GET', url, headers: {} }, { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; } });
  assert.equal(status, 200, body);
  return JSON.parse(body);
}
/**
 * Waits for the first wake (polled through the console route) and the home turn it starts; afterwards
 * nothing writes life.json for an hour. Polling life.json itself would block its atomic rename on Windows.
 */
async function firstWakeDone(ctx: Context, root: string, routes: { path: string }[]): Promise<{ homeSessionId?: string; alarm?: { source: string } }> {
  await until(async () => (await consoleGet(routes, '/dsh-world/console/wakes')).length > 0, 'the first wake');
  for (const agent of ctx.agents.list()) await agent.whenIdle();
  return JSON.parse(await readFile(join(root, 'worlds/fish/life.json'), 'utf8'));
}
test('life stays off by default and starts once its host services exist', async t => {
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* () { yield* textResponse('reply'); });
  isolateHome(t, root);
  const off = ctx.plugin(worldPlugin, config); await off.await(); await off.dispose();
  assert.equal((await readdir(join(root, 'worlds/fish'))).includes('life.json'), false);
  const { routes, unregistered } = provideLifeHost(ctx);
  const logged = captureErrors(ctx);
  const on = ctx.plugin(worldPlugin, { ...config, life: true }); cleanup.push(() => on.dispose()); await on.await();
  await until(async () => (await readdir(join(root, 'worlds/fish'))).includes('life.json'), 'life.json');
  assert.ok((await readdir(join(root, 'worlds/fish'))).includes('life.json'));
  assert.deepEqual(routes.map(route => route.path), ['/dsh-world']);
  assert.ok(!(await readdir(join(root, 'worlds/fish'))).includes('bridge.json'), 'no bridge unless bridge is on');
  // The first wake runs a home turn, which ends without plan_next and so arms the fallback alarm.
  const { homeSessionId, alarm } = await firstWakeDone(ctx, root, routes);
  assert.equal(alarm?.source, 'fallback');
  assert.deepEqual(logged, []); assert.equal(errors.length, 0);
  await on.dispose();
  assert.deepEqual(unregistered, ['/dsh-world']);
  // A stopped life line no longer reacts to home turns: no new fallback alarm is written.
  const before = await readFile(join(root, 'worlds/fish/life.json'), 'utf8');
  const home = ctx.agents.get(SessionId(homeSessionId!))!;
  home.followup(user('after unload')); await home.whenIdle(); await ctx.sessions.flush(home.session);
  assert.equal(await readFile(join(root, 'worlds/fish/life.json'), 'utf8'), before);
});
test('a corrupt life.json leaves the life line off, the console showing why, and the memory plugin running', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); });
  isolateHome(t, root);
  await mkdir(join(root, 'worlds/fish/diary'), { recursive: true });
  await writeFile(join(root, 'worlds/fish/life.json'), '{ not json');
  await writeFile(join(root, 'worlds/fish/diary/2026-10-22.md'), '昨天');
  const seed = createArchiveStore({ ...config, root }); await seed.appendRecords([record('seed', { content: 'earlier memory' })]); seed.close();
  const logged = captureErrors(ctx);
  const { routes } = provideLifeHost(ctx);
  const plugin = ctx.plugin(worldPlugin, { ...config, life: true }); await plugin.await();
  await until(async () => routes.length > 0, 'the console route');
  assert.deepEqual(routes.map(route => route.path), ['/dsh-world']);
  const snapshot = await consoleGet(routes, '/dsh-world/console/snapshot');
  assert.equal(snapshot.worldId, 'fish'); assert.equal(snapshot.life, null);
  assert.equal(snapshot.health.length, 1); assert.match(snapshot.health[0], /^生活线没能启动：.*life\.json/);
  assert.equal(snapshot.memory.records, 1); assert.deepEqual(snapshot.compactions, []); assert.deepEqual(snapshot.activityDays, []);
  assert.deepEqual(snapshot.diaryDates, ['2026-10-22']);
  assert.deepEqual(await consoleGet(routes, '/dsh-world/console/wakes'), []);
  assert.ok(logged.some(line => line.includes('life.json')), logged.join('\n'));
  assert.equal(await readFile(join(root, 'worlds/fish/life.json'), 'utf8'), '{ not json');
  assert.equal(ctx.agents.list().length, 0, 'no home session was created');
  const handle = await ctx.agents.create({ sessionId: SessionId('still-remembers'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('memory still works')); await handle.agent.whenIdle();
  await plugin.dispose(); cleanup.push(() => handle.dispose());
  assert.equal(errors.length, 0);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].messages.find(m => m.source?.kind === 'dsh-world-history') && textOf(requests[0]).includes('earlier memory'));
  const archive = createArchiveStore({ ...config, root });
  const records = await archive.readPage({ worldId: 'fish', limit: 10 }).then(page => page.records).finally(() => archive.close());
  assert.deepEqual(records.map(r => r.content).sort(), ['earlier memory', 'memory still works', 'reply']);
});
test('an archived home is rebuilt, reading workspaceRegistry from another plugin without injecting it', async t => {
  const { ctx, root, cleanup } = await hostFixture(t, async function* () { yield* textResponse('reply'); });
  isolateHome(t, root);
  await ctx.agents.create({ sessionId: SessionId('life-home-old'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  await mkdir(join(root, 'worlds/fish'), { recursive: true });
  await writeFile(join(root, 'worlds/fish/life.json'), JSON.stringify({ version: 1, homeSessionId: 'life-home-old' }));
  // Like the desktop host, the registry comes from a sibling plugin, not from an ancestor of dsh-world.
  await ctx.plugin({ name: 'workspace-registry', apply: (c: Context) => { c.provide('workspaceRegistry', { archivedSessionIds: ['life-home-old'] }); } }).await();
  const logged = captureErrors(ctx);
  const { routes } = provideLifeHost(ctx);
  const plugin = ctx.plugin(worldPlugin, { ...config, life: true }); cleanup.push(() => plugin.dispose()); await plugin.await();
  assert.equal((await firstWakeDone(ctx, root, routes)).homeSessionId, 'life-home-1');
  assert.deepEqual(logged, []);
});
/** A stand-in for the standalone pet's local server. */
async function fakeStandalonePet(t: TestContext) {
  const received: { url?: string; body: unknown }[] = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { received.push({ url: req.url, body: JSON.parse(body) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { received, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
async function routeCall(routes: { path: string }[], path: string, url: string, headers: Record<string, string>, body: string) {
  const route = routes.find(entry => entry.path === path) as unknown as { handler(req: unknown, res: unknown): Promise<void> };
  let status = 0; let text = '';
  await route.handler(Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST', url, headers }), { writeHead: (code: number) => { status = code; }, end: (value: string) => { text = value; } });
  return { status, body: JSON.parse(text) };
}
test('with the bridge and an outlet, words from a local app enter the home and the archive, and her reply goes to the outlet', async t => {
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) {
    yield* textResponse(textOf(request).includes('桌宠上的话') ? '![开心](/m/a.png)\n**在呢**' : '早');
  });
  isolateHome(t, root);
  const pet = await fakeStandalonePet(t);
  const runningFile = join(root, 'pet', 'running.json'); await mkdir(join(root, 'pet'));
  await writeFile(runningFile, String.fromCharCode(0xfeff) + JSON.stringify({ baseUrl: pet.baseUrl }));
  const { routes, unregistered } = provideLifeHost(ctx);
  const logged = captureErrors(ctx);
  const outlets = [{ name: '桌面桌宠', urlFile: runningFile, path: '/dsh-pet-7340/broadcast?pet=main&surface=any' }];
  const plugin = ctx.plugin(worldPlugin, { ...config, companionName: '小鱼', life: true, bridge: true, toast: false, outlets }); cleanup.push(() => plugin.dispose()); await plugin.await();
  await until(async () => routes.length === 2, 'the bridge and console routes');
  assert.deepEqual(routes.map(route => route.path), ['/dsh-world/bridge/say', '/dsh-world']);
  const { homeSessionId } = await firstWakeDone(ctx, root, routes);
  const bridgeFile = join(root, 'worlds/fish/bridge.json');
  const { origin, token, pid, startedAt, name } = JSON.parse(await readFile(bridgeFile, 'utf8'));
  assert.equal(name, '小鱼'); assert.equal(origin, 'http://127.0.0.1:0'); assert.equal(pid, process.pid); assert.match(token, /^[0-9a-f]{64}$/); assert.ok(Number.isFinite(Date.parse(startedAt)));
  const said = await routeCall(routes, '/dsh-world/bridge/say', '/dsh-world/bridge/say', { 'x-dsh-world-token': token }, JSON.stringify({ text: '桌宠上的话' }));
  assert.equal(said.status, 202); assert.equal(said.body.accepted, true); assert.equal(typeof said.body.id, 'string');
  await until(async () => pet.received.length === 1, 'the reply push');
  assert.deepEqual(pet.received, [{ url: '/dsh-pet-7340/broadcast?pet=main&surface=any', body: { text: '在呢', kind: 'reply', name: '小鱼', images: ['http://127.0.0.1:0/m/a.png'] } }]);
  const home = ctx.agents.get(SessionId(homeSessionId!))!; await home.whenIdle(); await ctx.sessions.flush(home.session);
  assert.equal((await routeCall(routes, '/dsh-world/bridge/say', '/dsh-world/bridge/say', { 'x-dsh-world-token': 'wrong' }, '{}')).status, 403);
  // The pet is gone: the reply stays in the home and the console says why it did not arrive.
  await writeFile(runningFile, '{}');
  assert.equal((await routeCall(routes, '/dsh-world/bridge/say', '/dsh-world/bridge/say', { 'x-dsh-world-token': token }, JSON.stringify({ text: '桌宠上的话，第二句' }))).status, 202);
  // The snapshot is cached for a few seconds, so it is read once, after the reply turn.
  await until(async () => ctx.agents.list().every(agent => agent.status === 'idle'), 'the second reply'); await home.whenIdle(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.match((await consoleGet(routes, '/dsh-world/console/snapshot')).health.join('|'), /桌面桌宠没收到小鱼的回复：.*baseUrl/);
  await plugin.dispose();
  assert.ok(!existsSync(bridgeFile)); assert.deepEqual(unregistered.sort(), ['/dsh-world', '/dsh-world/bridge/say']);
  const archive = createArchiveStore({ ...config, root });
  const records = await archive.readPage({ worldId: 'fish', limit: 20 }).then(page => page.records).finally(() => archive.close());
  assert.deepEqual(records.filter(r => r.role === 'user').map(r => r.content).sort(), ['桌宠上的话', '桌宠上的话，第二句'], 'her partner\'s own words, in memory');
  assert.deepEqual(logged, []); assert.equal(errors.length, 0);
});
test('the config takes outlets by name with the kinds they want; the bridge is off and the toast on unless set', () => {
  const parsed = worldPlugin.Config(config);
  assert.deepEqual(parsed.outlets, []); assert.equal(parsed.bridge, false); assert.equal(parsed.toast, true);
  const outlets = [{ name: '桌面应用', urlFile: 'C:/app/running.json', path: '/hook', kinds: ['reply', 'reach'] }, { name: '网页', url: '{origin}/x' }];
  assert.deepEqual(worldPlugin.Config({ ...config, outlets } as never).outlets, [outlets[0], { ...outlets[1], kinds: [] }], 'no kinds is an empty list, read as every kind');
  assert.throws(() => worldPlugin.Config({ ...config, outlets: [{ url: 'http://x' }] } as never), /name/);
  assert.throws(() => worldPlugin.Config({ ...config, outlets: [{ name: 'x', kinds: ['shout'] }] } as never), /shout/);
});
test('the config validates fallbackWakeTime as HH:MM and defaults to 09:00', () => {
  for (const bad of ['25:00', '9am', '24:00', '09:60', '9:00', '']) assert.throws(() => worldPlugin.Config({ ...config, fallbackWakeTime: bad }), /fallbackWakeTime/);
  assert.equal(worldPlugin.Config({ ...config, fallbackWakeTime: '00:00' }).fallbackWakeTime, '00:00');
  assert.equal(worldPlugin.Config({ ...config, fallbackWakeTime: '23:59' }).fallbackWakeTime, '23:59');
  assert.equal(worldPlugin.Config(config).fallbackWakeTime, '09:00');
  assert.doesNotThrow(() => worldPlugin.Config({ ...config, fallbackWakeMinutes: 60 }));
});
