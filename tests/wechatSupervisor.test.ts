import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createAdapterSupervisor } from '../src/ecosystem/wechat/supervisor.ts';

class FakeChild extends EventEmitter { pid: number; constructor(pid: number) { super(); this.pid = pid; } }
function setup(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-world-supervisor-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const python = join(dir, 'python.exe'), config = join(dir, 'config.json'), script = join(dir, 'adapter.py');
  for (const file of [python, config, script]) writeFileSync(file, '');
  const children: FakeChild[] = [], launches: { command: string; args: string[] }[] = [], logs: string[] = [], killed: number[] = [];
  const supervisor = createAdapterSupervisor({
    python, config, script, logFile: join(dir, 'adapter.log'), minDelayMs: 5, maxDelayMs: 20, log: message => logs.push(message),
    spawnProcess: ((command: string, args: string[]) => { launches.push({ command, args }); const child = new FakeChild(100 + children.length); children.push(child); return child; }) as never,
    killTree: (child: ChildProcess) => { killed.push(child.pid!); queueMicrotask(() => child.emit('exit', null, 'SIGKILL')); },
  });
  return { dir, python, config, script, children, launches, logs, killed, supervisor };
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('the adapter starts with the bound config and an explicit send permission, and stops with its whole tree', async t => {
  const { supervisor, launches, python, config, script, children, killed } = setup(t);
  supervisor.start();
  assert.equal(launches.length, 1);
  assert.equal(launches[0]!.command, python);
  assert.deepEqual(launches[0]!.args, ['-X', 'utf8', '-u', script, 'watch', '--config', config, '--allow-send']);
  assert.deepEqual(supervisor.status(), { running: true, pid: 100, restarts: 0, lastExit: null, error: null, needsHuman: false });
  await supervisor.stop();
  assert.deepEqual(killed, [children[0]!.pid]);
  assert.equal(supervisor.status().running, false);
  await wait(40);
  assert.equal(launches.length, 1, 'a stopped supervisor never restarts it');
});

test('an exit restarts the adapter after a delay and keeps count', async t => {
  const { supervisor, launches, children, logs } = setup(t);
  supervisor.start();
  children[0]!.emit('exit', 1, null);
  assert.equal(supervisor.status().running, false);
  assert.equal(supervisor.status().lastExit, 'code 1');
  assert.equal(launches.length, 1, 'not at once');
  await wait(60);
  assert.equal(launches.length, 2);
  assert.equal(supervisor.status().restarts, 1);
  assert.match(logs[0]!, /exited \(code 1\)/);
  await supervisor.stop();
});

test('a file that is missing at start is retried and the adapter comes up once it is back', async t => {
  const { supervisor, launches, python, dir } = setup(t);
  rmSync(python);
  supervisor.start();
  assert.equal(launches.length, 0);
  assert.match(supervisor.status().error ?? '', /Python不存在/);
  writeFileSync(python, '');
  await wait(60);
  assert.equal(launches.length, 1);
  assert.equal(supervisor.status().error, null);
  assert.equal(supervisor.status().restarts, 0, 'waiting for a file is not a restart');
  await supervisor.stop();
  assert.ok(readdirSync(dir).includes('config.json'));
});

test('an exit that asks for a person is not retried until the console restarts it', async t => {
  const { supervisor, launches, children } = setup(t);
  supervisor.start();
  children[0]!.emit('exit', 2, null);
  assert.equal(supervisor.status().needsHuman, true);
  await wait(60);
  assert.equal(launches.length, 1, 'retrying cannot help');
  await supervisor.restart();
  assert.equal(launches.length, 2);
  assert.equal(supervisor.status().needsHuman, false);
  assert.equal(supervisor.status().running, true);
  await supervisor.stop();
});

test('restarting a running adapter replaces it once, without a second automatic restart', async t => {
  const { supervisor, launches, killed, children } = setup(t);
  supervisor.start();
  await supervisor.restart();
  assert.deepEqual(killed, [children[0]!.pid]);
  await wait(60);
  assert.equal(launches.length, 2);
  assert.equal(supervisor.status().restarts, 1);
  await supervisor.stop();
});
