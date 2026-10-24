import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeCall } from '../src/life/activity.ts';

const room = 'C:\\Users\\me\\.dsh\\worlds\\jingjing\\room';
const outside = (tool: string, args: unknown) => summarizeCall(tool, JSON.stringify(args), room).outside;
test('shell commands are always outside and summarized by their command', () => {
  assert.deepEqual(summarizeCall('pwsh', JSON.stringify({ command: 'Start-Process   steam://run/1' }), room), { summary: 'Start-Process steam://run/1', outside: true });
  assert.equal(outside('Bash', { command: 'ls' }), true);
  assert.equal(outside('PowerShell', { command: 'ls' }), true);
});
test('file tools are outside only when a path leaves the room', () => {
  assert.equal(outside('write', { path: 'notes/plan.md', content: 'x' }), false);
  assert.equal(outside('write', { file_path: room + '\\a.md' }), false);
  assert.equal(outside('edit', { path: '../escape.md' }), true);
  assert.equal(outside('read', { paths: ['a.md', 'D:\\work\\b.md'] }), true);
  assert.equal(summarizeCall('read', JSON.stringify({ path: 'notes/plan.md' }), room).summary, 'notes/plan.md');
});
test('path boundaries: the room itself, case, dot-dot names, UNC', () => {
  assert.equal(outside('read', { path: room }), false);
  assert.equal(outside('read', { path: room.toUpperCase() + '\\A.md' }), false);
  assert.equal(outside('read', { path: '..foo.md' }), false);
  assert.equal(outside('read', { path: '\\\\server\\share\\x' }), true);
});
test('nested and extra path keys are inspected', () => {
  assert.equal(outside('edit', { operations: [{ path: 'D:\\x' }] }), true);
  assert.equal(outside('edit', { operations: [{ path: 'a.md' }] }), false);
  assert.equal(outside('glob', { root: 'D:\\work' }), true);
  assert.equal(outside('glob', { folder: 'D:\\work' }), true);
});
test('tools without paths and unparsable arguments stay inside with a clipped summary', () => {
  assert.deepEqual(summarizeCall('send_sticker', '{"action":"list"}', room), { summary: '{"action":"list"}', outside: false });
  assert.equal(summarizeCall('web_fetch', 'x'.repeat(500), room).summary.length, 160);
});
test('clip does not split surrogate pairs', () => {
  const out = summarizeCall('pwsh', JSON.stringify({ command: 'x'.repeat(159) + '😀' + 'yyy' }), room).summary;
  assert.ok(out.endsWith('😀'));
  assert.doesNotMatch(out, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
});
