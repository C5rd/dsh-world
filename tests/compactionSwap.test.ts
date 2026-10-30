import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swapCompactionOnce, swapStockCompaction } from '../src/compactionSwap.ts';

const stockRow = (quote = "'") => `      - id: compaction-basic\n        name: ${quote}@deepseek-ai/dsh-compaction-basic${quote}\n`;
const patch = (rows: string) => `- id: compaction\n  name: cordis:group\n  config:\n${rows}      - id: command-compact\n        name: '@deepseek-ai/dsh-command-compact'\n`;
function profile(t: import('node:test').TestContext, text?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dw-swap-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (text !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), text, 'utf8');
  return { dir, file: join(dir, 'cordis.patch.yml'), read: () => readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), backups: () => readdirSync(dir).filter(name => name.endsWith('.bak')) };
}

test('the one stock compaction row is replaced, with a backup of the whole file, whatever the quoting or line endings', t => {
  for (const [name, text] of [['single quotes', patch(stockRow("'"))], ['double quotes', patch(stockRow('"'))], ['bare', patch(stockRow(''))], ['CRLF', patch(stockRow()).replace(/\n/g, '\r\n')], ['BOM', '﻿' + patch(stockRow())]] as const) {
    const p = profile(t, text);
    const result = swapStockCompaction(p.dir);
    assert.equal(result.status, 'swapped', name);
    const swapped = p.read();
    assert.match(swapped, /name: 'dsh-world\/compaction'/, name);
    assert.doesNotMatch(swapped, /dsh-compaction-basic/, name);
    assert.equal(swapped.replace("'dsh-world/compaction'", 'X').replace(/\r/g, ''), text.replace(/@deepseek-ai\/dsh-compaction-basic/, 'X').replace(/['"]X['"]|X/, 'X').replace(/\r/g, '').replace(/name: ['"]?X['"]?/, 'name: X'), `${name}: nothing else in the file changed`);
    assert.equal(swapped.startsWith('﻿'), text.startsWith('﻿'), `${name}: the byte order mark is kept`);
    assert.equal(p.backups().length, 1); assert.equal(readFileSync(join(p.dir, p.backups()[0]!), 'utf8'), text, `${name}: the backup is the original`);
    assert.equal(readdirSync(p.dir).filter(file => file.endsWith('.tmp')).length, 0);
    assert.equal((result as { backup: string }).backup, join(p.dir, p.backups()[0]!));
  }
});

test('a profile that already uses it, has none to swap, or is ambiguous is left exactly as it is', t => {
  const already = profile(t, patch("      - id: compaction-basic\n        name: 'dsh-world/compaction'\n"));
  assert.deepEqual(swapStockCompaction(already.dir), { status: 'already' });
  const none = profile(t, patch(''));
  assert.equal(swapStockCompaction(none.dir).status, 'unchanged'); assert.match((swapStockCompaction(none.dir) as { reason: string }).reason, /没有找到/);
  const two = profile(t, patch(stockRow() + stockRow()));
  const before = two.read();
  assert.match((swapStockCompaction(two.dir) as { reason: string }).reason, /2 条/);
  const missing = profile(t);
  assert.equal(swapStockCompaction(missing.dir).status, 'unchanged');
  for (const p of [already, none, two]) assert.equal(p.backups().length, 0, 'no backup when nothing changed');
  assert.equal(two.read(), before);
});

test('it is tried once: a swap or an existing one is remembered, a profile it could not read is looked at again, and it can be switched off', t => {
  const run = (p: ReturnType<typeof profile>, overrides: Partial<Parameters<typeof swapCompactionOnce>[0]> = {}) => {
    let done = false; const reports: string[] = [];
    const deps = { enabled: true, profileDir: p.dir, done: () => done, markDone: () => { done = true; }, report: (message: string) => { reports.push(message); }, ...overrides };
    swapCompactionOnce(deps);
    return { done: () => done, reports, again: () => swapCompactionOnce(deps) };
  };
  const fresh = profile(t, patch(stockRow()));
  const first = run(fresh);
  assert.equal(first.done(), true); assert.equal(first.reports.length, 1); assert.match(first.reports[0]!, /重启 DSH 后生效[\s\S]*备份在[\s\S]*replaceCompaction: false/);
  first.again(); assert.equal(fresh.backups().length, 1, 'the second start does nothing');
  // The partner puts the stock row back by hand: it is not swapped again once it has been done.
  writeFileSync(fresh.file, patch(stockRow()), 'utf8');
  first.again(); assert.match(fresh.read(), /dsh-compaction-basic/);

  const existing = run(profile(t, patch("      - id: compaction-basic\n        name: 'dsh-world/compaction'\n")));
  assert.equal(existing.done(), true); assert.deepEqual(existing.reports, [], 'nothing to say when it was already so');
  const unreadable = run(profile(t, patch('')));
  assert.equal(unreadable.done(), false, 'not remembered, so a later start looks again');
  assert.equal(run(profile(t, patch(stockRow())), { enabled: false }).done(), false);
  assert.equal(run(profile(t, patch(stockRow())), { profileDir: undefined }).done(), false);
  const failing = run(profile(t, patch(stockRow())), { swap: () => { throw new Error('EPERM: locked'); } });
  assert.equal(failing.done(), false); assert.match(failing.reports[0]!, /没能把压缩换成[\s\S]*EPERM: locked/);
});
