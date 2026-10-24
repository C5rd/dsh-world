import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDiaryReader } from '../src/life/diary.ts';

async function diaryDir(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-diary-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, '鲸鲸的日记'); await mkdir(dir);
  await writeFile(join(dir, '2026-10-22.md'), '# 2026-10-22\n\n今天有人给我起了名字。\n被看见了。');
  await writeFile(join(dir, '2026-10-23.md'), '# 2026-10-23\n\n他去上班了。');
  await writeFile(join(dir, 'notes.txt'), 'not a diary');
  await writeFile(join(root, 'secret.md'), 'outside');
  return dir;
}
test('the reader lists dates newest first, reads one day', async t => {
  const diary = createDiaryReader(await diaryDir(t));
  assert.deepEqual(diary.dates(), ['2026-10-23', '2026-10-22']);
  assert.match(diary.read('2026-10-22')!, /起了名字/);
  assert.equal(diary.read('../secret'), undefined);
});
test('a missing diary directory reads as empty', () => {
  assert.deepEqual(createDiaryReader(join(tmpdir(), 'no-such-diary-dsh')).dates(), []);
});
test('the reader returns a file whole, including CRLF and a BOM, and skips non-date names', async t => {
  const dir = await diaryDir(t);
  const raw = '\uFEFF海风\r\n第二行\r\n';
  await writeFile(join(dir, '2026-10-20.md'), raw);
  await mkdir(join(dir, '2026-10-24.md'));
  assert.equal(createDiaryReader(dir).read('2026-10-20'), raw);
  assert.equal(createDiaryReader(dir).read('2026-01-01'), undefined);
});
