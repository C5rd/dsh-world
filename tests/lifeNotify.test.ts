import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { toastScript, windowsToast } from '../src/life/notify.ts';

const decodeXml = (script: string) => {
  const encoded = [...script.matchAll(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/g)].map(match => Buffer.from(match[1]!, 'base64').toString('utf8'));
  return encoded;
};
const fakeSpawn = (behave: (child: EventEmitter & { stderr: EventEmitter; killed: boolean; kill(): void }) => void) => ((..._args: unknown[]) => {
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), killed: false, kill() { this.killed = true; } });
  setImmediate(() => behave(child));
  return child;
}) as never;

test('the toast script never interpolates text and carries escaped XML as base64', () => {
  const title = '鲸’鲸‘';
  const body = `x’; Start-Process calc; ‚‛ ' < & " \u0001ok`;
  const script = toastScript('electron.app.DeepSeek Harness', title, body);
  for (const bad of ['’', '‘', '‚', '‛', 'Start-Process', '鲸', '\u0001']) assert.ok(!script.includes(bad), bad);
  const [appId, xmlText] = decodeXml(script);
  assert.equal(appId, 'electron.app.DeepSeek Harness');
  assert.match(xmlText!, /<text>鲸’鲸‘<\/text>/);
  assert.match(xmlText!, /x’; Start-Process calc; ‚‛ &apos; &lt; &amp; &quot; ok<\/text>/);
  assert.ok(!xmlText!.includes('\u0001'));
  assert.match(script, /^\$ErrorActionPreference = 'Stop'; \[Console\]::OutputEncoding = \[Text\.Encoding\]::UTF8/);
  assert.match(script, /try \{[\s\S]*\} catch \{ \[Console\]::Error\.WriteLine\(\$_\.Exception\.Message\); exit 1 \}/);
});
test('the toast script caps the title at 64 and the body at 500 code points', () => {
  const [, xmlText] = decodeXml(toastScript('app', '题'.repeat(70), '😀'.repeat(600)));
  assert.ok(xmlText!.includes(`<text>${'题'.repeat(64)}…</text>`));
  assert.ok(xmlText!.includes(`<text>${'😀'.repeat(500)}…</text>`));
  const [, short] = decodeXml(toastScript('app', 'a', 'b'.repeat(500)));
  assert.ok(!short!.includes('…'));
});
test('windowsToast rejects with the stderr reason on a non-zero exit', { skip: process.platform !== 'win32' }, async () => {
  const toast = windowsToast('app', fakeSpawn(child => { child.stderr.emit('data', 'boom happened\n'); child.emit('close', 1); }));
  await assert.rejects(toast('t', 'b'), { message: 'powershell 退出码 1：boom happened' });
  await windowsToast('app', fakeSpawn(child => child.emit('close', 0)))('t', 'b');
});
test('windowsToast gives up on a child that never exits', { skip: process.platform !== 'win32' }, async () => {
  let killed = false;
  const spawnImpl = ((..._args: unknown[]) => Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill() { killed = true; } })) as never;
  await assert.rejects(windowsToast('app', spawnImpl, 20)('t', 'b'), { message: '系统通知超时（10 秒）' });
  assert.ok(killed);
});
