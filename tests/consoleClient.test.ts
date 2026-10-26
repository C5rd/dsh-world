import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { renderPersona } from '../src/persona.ts';

test('the client registers the world console settings section under the bundle id', async () => {
  const source = await readFile('client/index.js', 'utf8');
  let loaded: { id: string; factory: (require: (name: string) => unknown) => { inject: string[]; apply(ctx: unknown): void } } | undefined;
  const react = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }), useState: (value: unknown) => [typeof value === 'function' ? (value as () => unknown)() : value, () => {}], useEffect: () => {}, useRef: (current: unknown) => ({ current }) };
  let reply: () => Promise<unknown> = async () => { throw new Error('no fetch'); };
  runInNewContext(source, { fetch: () => reply(), window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } } });
  assert.equal(loaded?.id, 'dsh-world');
  const plugin = loaded!.factory(name => { assert.equal(name, 'react'); return react; });
  assert.deepEqual([...plugin.inject], ['slots']); // spread: the array comes from the vm realm
  const registered: { meta: Record<string, unknown>; render: () => { type: unknown } }[] = [];
  plugin.apply({ slots: { inject: (_name: string, register: () => unknown) => register(), register: (meta: Record<string, unknown>, render: () => { type: unknown }) => { registered.push({ meta, render }); return () => {}; } } });
  assert.deepEqual({ ...registered[0].meta }, { name: 'settings.section', id: 'world-console', order: 28, label: '世界控制台' });
  assert.equal(typeof registered[0].render().type, 'function');
  // minimal fake renderer: call function components, collect text
  type El = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };
  const text = (node: unknown): string => {
    if (node == null || typeof node === 'boolean') return '';
    if (Array.isArray(node)) return node.map(text).join('');
    if (typeof node !== 'object') return String(node);
    const el = node as El;
    if (typeof el.type === 'function') return text((el.type as (p: unknown) => unknown)({ ...el.props, children: el.children }));
    return text(el.children);
  };
  assert.match(text(registered[0].render()), /读取中/);
  const tested = (plugin as unknown as { __test: { Activity: unknown; Diary: unknown; View: unknown; loadSnapshot: unknown; renderPersona: (p: Record<string, string>) => string } }).__test;
  assert.doesNotThrow(() => text(react.createElement(tested.Activity, { days: ['2026-10-23'], zone: 'Asia/Tokyo', tick: 1 })));
  assert.match(text(react.createElement(tested.Activity, { days: [], zone: 'UTC', tick: 0 })), /还没有活动记录/);
  assert.doesNotThrow(() => text(react.createElement(tested.Diary, { dates: ['2026-10-23'] })));
  assert.match(text(react.createElement(tested.Diary, { dates: [] })), /还没有日记/);
  const respond = (status: number, json: () => Promise<unknown>) => { reply = async () => ({ ok: status >= 200 && status < 300, status, json }); };
  const load = tested.loadSnapshot as () => Promise<unknown>;
  respond(404, async () => ({ error: 'not found' })); assert.equal(await load(), null);
  respond(200, async () => { throw new SyntaxError('Unexpected token <'); }); assert.equal(await load(), null, 'a non-JSON page counts as off');
  respond(200, async () => ({ worldId: 'fish' })); assert.equal(await load(), null, 'a snapshot without life counts as off');
  respond(200, async () => ({ worldId: 'fish', life: 'on' })); assert.equal(await load(), null);
  respond(500, async () => ({ error: 'internal error' })); await assert.rejects(load(), /internal error/);
  const degraded = { worldId: 'fish', timeZone: 'UTC', now: '2026-10-23T00:00:00.000Z', life: null, health: ['生活线没能启动：life.json is not valid JSON'], memory: { turns: 0, windowTurns: 200, approxTokens: 0, records: 1, sessions: 1 }, compactions: [], diaryDates: [], activityDays: [] };
  respond(200, async () => degraded); assert.equal(((await load()) as { life: unknown }).life, null);
  const shown = text(react.createElement(tested.View, { snap: degraded, error: null, tick: 0, refresh: () => {} }));
  assert.match(shown, /生活线没能启动：life\.json is not valid JSON/); assert.match(shown, /1 条/); assert.doesNotMatch(shown, /生活线未开启/);
  assert.doesNotThrow(() => text(react.createElement(tested.View, { snap: { worldId: 'fish', timeZone: 'UTC', life: null }, error: null, tick: 0, refresh: () => {} })), 'missing sections never crash the view');
  const fresh = text(react.createElement(tested.View, { snap: { ...degraded, health: [], running: false, name: 'TA' }, error: null, tick: 0, refresh: () => {} }));
  assert.match(fresh, /她的世界/); assert.match(fresh, /她还没有住进来/); assert.match(fresh, /开始/);
  const running = text(react.createElement(tested.View, { snap: { ...degraded, health: [], running: true, name: '小鱼', life: { homeSessionId: 'session-abcdef12', status: 'idle', alarm: { at: '2026-10-23T01:00:00.000Z', source: 'plan', note: '看书' }, recentWakes: [] } }, error: null, tick: 0, refresh: () => {} }));
  assert.match(running, /小鱼的世界/); assert.match(running, /运行中/); assert.match(running, /停止/); assert.match(running, /看书/); assert.doesNotMatch(running, /还没有住进来/);
  const pendingScope = text(react.createElement(tested.View, { snap: { ...degraded, memory: { ...degraded.memory, archiveScope: 'home', selectedArchiveScope: 'workspace', restartRequired: true } }, error: null, tick: 0, refresh: () => {} }));
  assert.match(pendingScope, /当前归档：仅家会话/);
  assert.match(pendingScope, /家所在工作区/);
  assert.match(pendingScope, /请重启 DSH/);
  assert.doesNotMatch(pendingScope, /所有会话/);
  for (const persona of [{ 名字: '小鱼', 她是谁: '一条鱼。', 性格: '嘴硬', 说话方式: '', 愿景: '自由', 补充: '别复述' }, { 名字: '', 她是谁: '', 性格: '', 说话方式: '短句', 愿景: '', 补充: '' }]) {
    assert.equal(tested.renderPersona(persona), renderPersona(persona), 'the console previews exactly what she reads');
  }
});
