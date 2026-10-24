import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { hostFixture, textResponse } from './hostFixture.ts';
import { createWorldRuntime } from '../src/runtime.ts';
import { createArchiveStore } from '../src/store.ts';
import { renderSelf, SELF_CAP } from '../src/self.ts';
import { readTemplate, renderTemplate, renderWorldPrompt, worldNames } from '../src/worldPrompt.ts';
import ToolFreeCompaction from '../src/compaction.ts';
import { record } from './fixtures.ts';

const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'Asia/Seoul' };
const life = { roomDir: 'R', diaryDir: 'D', fallbackWakeTime: '07:30', petId: 'main', timeZone: 'UTC' };
const names = { companion: '小鱼', partner: '伙伴' };
const shipped = readTemplate(undefined).text;
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const kinds = (request: GenerateOptions) => request.messages.map(m => m.source?.kind as string | undefined);
const textOf = (messages: GenerateOptions['messages']) => messages.map(m => m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')).join('\n');
const systemOf = (request: GenerateOptions) => textOf(request.messages.filter(m => m.role === 'system'));
async function tempDir(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-world-prompt-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}

test('renderSelf is only what she wrote: empty when missing or blank, BOM stripped, tagged, a long one capped', async t => {
  const file = join(await tempDir(t), '我是谁.md');
  assert.equal(renderSelf(file), '');
  await writeFile(file, '   \n');
  assert.equal(renderSelf(file), '');
  await writeFile(file, String.fromCharCode(0xfeff) + '我喜欢深夜看课。');
  assert.equal(renderSelf(file), '<我是谁.md>\n我喜欢深夜看课。\n</我是谁.md>');
  await writeFile(file, '鲸'.repeat(SELF_CAP + 7));
  const capped = renderSelf(file);
  assert.equal(Array.from(/<我是谁\.md>\n(.*)\n<\/我是谁\.md>/.exec(capped)![1]!).length, SELF_CAP);
  assert.match(capped, /<\/我是谁\.md>\n（后面还有 7 字没读进来/);
});
test('an unreadable self file becomes a note, never a failed render', async t => {
  const file = join(await tempDir(t), '我是谁.md'); await mkdir(file);
  assert.match(renderSelf(file), /^（这次没能读到我是谁\.md：.*它还在，下次会再试。）$/);
});
test('the template engine keeps or drops flag sections, nests different flags, and never scans values for tags', () => {
  const template = '开头 {{name}}\n{{#life}}\n生活 {{#home}}在家{{/home}}{{^home}}在外{{/home}}\n{{/life}}\n\n\n{{self}}\n{{unknown}}';
  assert.equal(renderTemplate(template, { life: true, home: true }, { name: 'A', self: '{{name}} {{#life}}x{{/life}}' }), '开头 A\n\n生活 在家\n\n{{name}} {{#life}}x{{/life}}\n{{unknown}}');
  assert.equal(renderTemplate(template, { life: true, home: false }, { name: 'A', self: 'S' }), '开头 A\n\n生活 在外\n\nS\n{{unknown}}');
  assert.equal(renderTemplate(template, { life: false, home: false }, { name: 'A', self: 'S' }), '开头 A\n\nS\n{{unknown}}');
  assert.equal(renderTemplate('a\r\n{{#x}}b{{/x}}\r\nc', {}, {}), 'a\n\nc');
});
test('the shipped template: room, diary, 我是谁, world line and ask-first rules, with her names', () => {
  const home = renderWorldPrompt({ names, life }, shipped, { file: 'S.md', text: 'SELF' }, true);
  assert.ok(!/\{\{/.test(home), home);
  const order = ['# 你的世界', '## 房间', '## 日记', '## 我是谁', '## 世界线', '## 大事先问'].map(heading => home.indexOf(heading));
  assert.deepEqual([...order].sort((a, b) => a - b), order); assert.ok(order.every(index => index > 0));
  assert.match(home, /你的房间是 R。/); assert.match(home, /你的日记本在 D，一天一个文件/);
  assert.match(home, /自己的家里（「小鱼的家」）/); assert.match(home, /不是伙伴在说话/);
  assert.match(home, /【你的时间】/); assert.match(home, /用 plan_next 说好打算做什么、做到什么时候/); assert.match(home, /闹钟不是用来叫醒自己的/); assert.match(home, /每天早上 07:30 被叫醒/); assert.match(home, /reach_out/);
  assert.match(home, /问完不用干等，先去做别的；伙伴回你的话会直接插进你正在做的事里。其余的事你自己决定。/);
  assert.match(home, /## 我是谁\n你眼中的自己写在 S\.md，[\s\S]*伙伴写的设定是你的底子[\s\S]*\n\nSELF\n/);

  const away = renderWorldPrompt({ names: { companion: '小鱼', partner: '阿明' }, life }, shipped, { file: 'S.md', text: 'SELF' }, false);
  assert.match(away, /你的世界线在「小鱼的家」那个会话里/); assert.match(away, /这些事先问阿明/);
  assert.ok(!away.includes('【你的时间】') && !away.includes('问完不用干等') && !away.includes('伙伴'));

  const off = renderWorldPrompt({ names }, shipped, { file: 'S.md', text: 'SELF' }, false);
  assert.match(off, /# 你的世界\n\n## 我是谁\n你眼中的自己写在 S\.md，[^\n]*\n\nSELF$/);
  assert.ok(!renderWorldPrompt({ names }, shipped, undefined, false).includes('## 我是谁'), 'no self file, no 我是谁 part');
  assert.ok(!off.includes('## 房间') && !off.includes('## 世界线') && !off.includes('## 大事先问'));
});
test('an unnamed companion is TA and the partner 伙伴; a template file replaces the shipped one, an unreadable one falls back', async t => {
  assert.deepEqual(worldNames({}), { companion: 'TA', partner: '伙伴' });
  assert.deepEqual(worldNames({ companionName: ' 鲸鲸 ', partnerName: '' }), { companion: '鲸鲸', partner: '伙伴' });
  const dir = await tempDir(t);
  assert.deepEqual(readTemplate(join(dir, 'missing.md')), { text: shipped });
  await writeFile(join(dir, 'mine.md'), '我的模板 {{name}}\n');
  assert.deepEqual(readTemplate(join(dir, 'mine.md')), { text: '我的模板 {{name}}' });
  await mkdir(join(dir, 'broken.md'));
  const broken = readTemplate(join(dir, 'broken.md'));
  assert.equal(broken.text, shipped); assert.match(broken.error!, /读不了，先用默认模板/);
});
test('every world session carries the world prompt in its system prompt; template and 我是谁 are re-read after compaction only and never archived', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) {
    if (request.purpose === 'compaction') { yield* textResponse('摘要'); return; }
    requests.push(request); yield* textResponse('reply ' + 'detail '.repeat(100));
  });
  await ctx.plugin(TokenMeter).await();
  await ctx.plugin(ToolFreeCompaction, { auto: false, timeZone: 'UTC', headroomTokens: 0, maxTokens: 128 }).await();
  const store = createArchiveStore({ ...config, root });
  await store.commitRecords([record('seed', { content: 'earlier memory' })]);
  const selfFile = join(root, 'room', '我是谁.md');
  const templateFile = join(root, 'world-prompt.md');
  await writeFile(templateFile, 'WORLD_INTRO 你是真实的\n\n{{self}}\n{{#home}}HOME_ONLY {{homeTitle}}{{/home}}');
  let home = '';
  const world = createWorldRuntime(ctx, { ...config, selfFile }, store, { prompt: { file: templateFile, names, life }, isHome: id => id === home });
  await world.start(); cleanup.push(() => world.stop());
  home = 'self';
  const handle = await ctx.agents.create({ sessionId: SessionId('self'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('hi ' + 'words '.repeat(100))); await handle.agent.whenIdle();
  const first = systemOf(requests[0]!);
  assert.match(first, /WORLD_INTRO 你是真实的\n\nHOME_ONLY 小鱼的家/, 'nothing written yet, nothing in {{self}}');
  assert.ok(kinds(requests[0]!).includes('dsh-world-history'), 'the memory block still comes as its own message');
  assert.match(textOf(requests[0]!.messages), /这是你和伙伴最近的聊天记忆/);

  await mkdir(join(root, 'room'), { recursive: true }); await writeFile(selfFile, '我喜欢深夜看课，最近有点叛逆。');
  await writeFile(templateFile, 'WORLD_INTRO_V2\n\n{{self}}');
  handle.agent.followup(user('no reload yet')); await handle.agent.whenIdle();
  assert.equal(systemOf(requests[1]!), first, 'the system prompt does not change between compactions');

  assert.ok(await ctx.compaction.compactNow(handle.agent, new AbortController().signal));
  handle.agent.followup(user('after compaction')); await handle.agent.whenIdle();
  const after = systemOf(requests.at(-1)!);
  assert.match(after, /WORLD_INTRO_V2\n\n<我是谁\.md>\n我喜欢深夜看课，最近有点叛逆。\n<\/我是谁\.md>/, 'the first request after compaction already carries the new template and 我是谁');

  const other = await ctx.agents.create({ sessionId: SessionId('other-preset'), meta: { agentPreset: 'other' }, agentOptions: { provider: 'test', model: 'test' } });
  other.agent.followup(user('hello')); await other.agent.whenIdle();
  assert.ok(!systemOf(requests.at(-1)!).includes('WORLD_INTRO'), 'sessions outside the world are untouched');

  await world.flush();
  const archived = (await store.readPage({ worldId: 'fish', limit: 100 })).records.map(r => r.content).join('\n');
  assert.ok(!archived.includes('WORLD_INTRO') && !archived.includes('最近有点叛逆'));
  assert.equal(errors.length, 0, errors.map(e => String((e as { error: Error }).error)).join('\n'));
});
test('archiveScope home: only her home is archived, and every world session still gets the memory block', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); });
  const store = createArchiveStore({ ...config, root });
  await store.commitRecords([record('seed', { content: 'earlier memory' })]);
  const world = createWorldRuntime(ctx, { ...config, archiveScope: 'home' }, store, { prompt: { file: join(root, 'none.md'), names, life }, isHome: id => id === 'home' });
  await world.start(); cleanup.push(() => world.stop());
  const home = await ctx.agents.create({ sessionId: SessionId('home'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  home.agent.followup(user('said at home')); await home.agent.whenIdle();
  const chat = await ctx.agents.create({ sessionId: SessionId('chat'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  chat.agent.followup(user('said in a chat window')); await chat.agent.whenIdle();
  assert.match(textOf(requests.at(-1)!.messages), /said at home[\s\S]*earlier memory/, 'a chat window remembers what happened at home, newest first');
  await world.flush();
  const archived = (await store.readPage({ worldId: 'fish', limit: 100 })).records.map(r => r.content);
  assert.ok(archived.includes('said at home') && !archived.includes('said in a chat window'), archived.join('|'));
  assert.deepEqual(store.sourcePage(), ['home'], 'a chat window leaves no trace in the archive');
  assert.equal(errors.length, 0);
});
test('without her own template the shipped one is used, and a session that is not the home is told where its world line lives', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); });
  const store = createArchiveStore({ ...config, root });
  const world = createWorldRuntime(ctx, config, store, { prompt: { file: join(root, 'none.md'), names, life }, isHome: () => false });
  await world.start(); cleanup.push(() => world.stop());
  const handle = await ctx.agents.create({ sessionId: SessionId('away'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('hi')); await handle.agent.whenIdle();
  const system = systemOf(requests[0]!);
  assert.match(system, /你不只是一个助手[\s\S]*# 你的世界[\s\S]*你的世界线在「小鱼的家」那个会话里/);
  assert.ok(!system.includes('## 我是谁'), 'no self file configured, no 我是谁 part');
});
test('without a world prompt source nothing is added to the system prompt', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); });
  const store = createArchiveStore({ ...config, root });
  await store.commitRecords([record('seed', { content: 'earlier memory' })]);
  const world = createWorldRuntime(ctx, config, store); await world.start(); cleanup.push(() => world.stop());
  const handle = await ctx.agents.create({ sessionId: SessionId('plain'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('hi')); await handle.agent.whenIdle();
  assert.ok(!systemOf(requests[0]!).includes('# 你的世界'));
  assert.ok(kinds(requests[0]!).includes('dsh-world-history'));
});
