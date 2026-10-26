import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { createWorldSwitch } from '../src/worldSwitch.ts';
import { createArchiveSelection } from '../src/archiveSelection.ts';
import { createArchiveStore } from '../src/store.ts';
import { createHistory } from '../src/history.ts';
import { record } from './fixtures.ts';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { hostFixture, textResponse } from './hostFixture.ts';
import { createWorldRuntime } from '../src/runtime.ts';

test('saving archive scope requires restart and preserves the active scope until then', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-scope-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings = createWorldSwitch(dir, 'home');
  assert.equal(settings.archiveScope(), 'home');
  settings.setArchiveScope('workspace');
  assert.equal(settings.archiveScope(), 'home');
  assert.equal(settings.selectedArchiveScope(), 'workspace');
  assert.equal(settings.restartRequired(), true);
  const restarted = createWorldSwitch(dir, 'home');
  assert.equal(restarted.archiveScope(), 'workspace');
  assert.equal(restarted.restartRequired(), false);
  settings.setArchiveScope('home');
  assert.equal(settings.restartRequired(), false);
});

test('workspace scope uses the workspace owning home, includes groups and ignores presets', () => {
  const ctx = new Context();
  ctx.provide('workspaceRegistry', { list: () => [
    { path: 'room', sessionIds: ['home', 'family', 'another-preset'] },
    { path: 'other', sessionIds: ['unrelated'] },
  ] });
  const includes = createArchiveSelection(ctx, 'workspace', id => id === 'home', 'room');
  for (const id of ['home', 'family', 'another-preset']) assert.equal(includes(id), true);
  assert.equal(includes('unrelated'), false);
  const onlyHome = createArchiveSelection(ctx, 'home', id => id === 'home', 'room');
  assert.equal(onlyHome('home'), true); assert.equal(onlyHome('family'), false);
});

test('narrowing memory filters old broader archive records without deleting them', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dw-history-scope-'));
  const store = createArchiveStore({ root, worldId: 'fish', agentPreset: 'test', timeZone: 'UTC' });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  await store.commitRecords([
    record('home', { sourceSessionId: 'home', turnId: 'home:1', occurredAt: '2026-10-25T01:00:00Z' }),
    record('group', { sourceSessionId: 'family', turnId: 'family:1', occurredAt: '2026-10-26T01:00:00Z' }),
  ]);
  const turns = await createHistory(store).loadRecentTurns('fish', 200, id => id === 'home');
  assert.deepEqual(turns.map(turn => turn.turnId), ['home:1']);
  assert.equal(store.stats().records, 2);
});

test('restart discovers cold workspace sessions and replaces an older broad memory block', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('ok'); });
  const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'UTC', archiveScope: 'workspace' as const };
  const store = createArchiveStore({ ...config, root }); cleanup.push(() => store.close());
  const included = new Set(['home', 'family', 'different']);
  const agents = [];
  const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
  for (const id of ['home', 'family', 'different', 'foreign']) {
    const { agent } = await ctx.agents.create({ sessionId: SessionId(id), meta: { agentPreset: id === 'different' ? 'other' : 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
    agent.followup(user(id + '-original')); await agent.whenIdle(); await ctx.sessions.flush(agent.session); agents.push(agent);
  }
  const source = { prompt: { names: { companion: '鱼', partner: '我' } }, isHome: (id: string) => id === 'home', archiveSession: (id: string) => included.has(id) };
  const broad = createWorldRuntime(ctx, config, store, source); await broad.start();
  const archived = (await store.readPage({ worldId: 'fish', limit: 100 })).records.map(row => row.content);
  for (const text of ['home-original', 'family-original', 'different-original']) assert.ok(archived.includes(text), text);
  assert.ok(!archived.includes('foreign-original'));
  const home = agents[0]; home.followup(user('first home request')); await home.whenIdle(); await broad.flush();
  assert.match(JSON.stringify(requests.at(-1)?.messages.filter(message => message.source?.kind === 'dsh-world-history')), /family-original/);
  await broad.stop();
  const narrow = createWorldRuntime(ctx, { ...config, archiveScope: 'home' }, store, { ...source, archiveSession: source.isHome });
  cleanup.push(() => narrow.stop()); await narrow.start();
  home.followup(user('after restart')); await home.whenIdle();
  await narrow.flush();
  const blocks = requests.at(-1)!.messages.filter(message => message.source?.kind === 'dsh-world-history');
  assert.ok(blocks.length <= 1);
  assert.doesNotMatch(JSON.stringify(blocks), /family-original|different-original|foreign-original/);
  assert.ok((await store.readPage({ worldId: 'fish', limit: 100 })).records.some(row => row.content === 'family-original'), 'old archive retained');
});
