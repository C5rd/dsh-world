import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm';
import { createAlbum, recentImages } from '../src/life/album.ts';
import { lifeTools } from '../src/life/tools.ts';

const png = (seed: number) => new Uint8Array([137, 80, 78, 71, seed, seed + 1, seed + 2]);
const ref = (id: string, mediaType: ImageAttachmentRef['mediaType'] = 'image/png') => ({ attachmentId: id, mediaType, bytes: 7, width: 1, height: 1 }) as unknown as ImageAttachmentRef;
const store = (files: Record<string, Uint8Array>) => ({ readImage: async (r: ImageAttachmentRef) => ({ ref: r, data: files[String(r.attachmentId)]! }) }) as unknown as AttachmentStore;
function setup(t: TestContext, files: Record<string, Uint8Array>) {
  const roomDir = mkdtempSync(join(tmpdir(), 'dw-album-'));
  t.after(() => rmSync(roomDir, { recursive: true, force: true }));
  const album = createAlbum({ roomDir, timeZone: 'Asia/Seoul', attachments: () => store(files), now: () => new Date('2026-10-26T01:41:00Z') });
  return { roomDir, album, folder: join(roomDir, '相册') };
}

test('recentImages lists what was shown to her, newest first, and skips her own messages', () => {
  const shown = (...refs: ImageAttachmentRef[]) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '看' }, ...refs.map(attachment => ({ type: 'image' as const, attachment }))] });
  const messages: Message[] = [shown(ref('a')), { role: 'assistant', content: [{ type: 'text', text: '好看' }] } as unknown as Message, shown(ref('b'), ref('c'))];
  assert.deepEqual(recentImages(messages).map(r => String(r.attachmentId)), ['c', 'b', 'a']);
});
test('keeping a photo copies it into her album with the words she kept it with', async t => {
  const { album, folder } = setup(t, { a: png(1), b: png(9) });
  const answer = await album.keep([ref('b'), ref('a')], { caption: '那天的海很蓝', title: '海 边' });
  assert.match(answer, /已留在相册：相册\/2026-10-26-1041-海-边-[0-9a-f]{12}\.png/);
  const [name] = readdirSync(folder).filter(file => file.endsWith('.png'));
  assert.deepEqual([...readFileSync(join(folder, name))], [...png(9)], 'the newest picture is kept by default');
  const index = readFileSync(join(folder, '相册.md'), 'utf8');
  assert.match(index, /^# 相册/);
  assert.ok(index.endsWith(`- 2026-10-26 10:41 · 海 边 · [${name}](${name}) · 那天的海很蓝
`), index);
  await album.keep([ref('b'), ref('a')], { caption: '另一张', which: 2 });
  assert.equal(readdirSync(folder).filter(file => file.endsWith('.png')).length, 2);
  assert.equal(readFileSync(join(folder, '相册.md'), 'utf8').match(/^- /gm)!.length, 2, 'the heading is written once');
});
test('the same picture is kept once', async t => {
  const { album, folder } = setup(t, { a: png(1) });
  await album.keep([ref('a')], { caption: '第一次' });
  const again = await album.keep([ref('a')], { caption: '第二次' });
  assert.match(again, /已经留在相册里了/);
  assert.equal(readdirSync(folder).filter(file => file.endsWith('.png')).length, 1);
  assert.doesNotMatch(readFileSync(join(folder, '相册.md'), 'utf8'), /第二次/);
});
test('it says what is wrong instead of keeping something else', async t => {
  const { album, folder } = setup(t, { a: png(1) });
  await assert.rejects(album.keep([ref('a')], { caption: '  ' }), /为什么想留/);
  await assert.rejects(album.keep([ref('a')], { caption: 'x'.repeat(501) }), /太长/);
  await assert.rejects(album.keep([ref('a')], { caption: 'x', title: 'y'.repeat(41) }), /标题太长/);
  await assert.rejects(album.keep([ref('a')], { caption: 'x', which: 0 }), /which/);
  await assert.rejects(album.keep([ref('a')], { caption: 'x', which: 2 }), /只有 1 张/);
  await assert.rejects(album.keep([], { caption: 'x' }), /没有可以留的图片/);
  assert.throws(() => readdirSync(folder), 'nothing was written');
});
test('with no host image store she is told, not silently skipped', async t => {
  const roomDir = mkdtempSync(join(tmpdir(), 'dw-album-')); t.after(() => rmSync(roomDir, { recursive: true, force: true }));
  const album = createAlbum({ roomDir, timeZone: 'UTC', attachments: () => undefined });
  await assert.rejects(album.keep([ref('a')], { caption: 'x' }), /图片存储/);
});
test('a title cannot escape the album folder', async t => {
  const { album, folder } = setup(t, { a: png(1) });
  await album.keep([ref('a')], { caption: 'x', title: '../../evil\name' });
  const names = readdirSync(folder);
  assert.ok(names.every(name => !name.includes('..') && !/[\/]/.test(name)), names.join('|'));
});
test('keep_photo is offered only when the host can keep photos, and forwards what she wrote', async () => {
  const none = { outlets: [] };
  assert.deepEqual(lifeTools({ planNext: () => '', notifier: none }).map(tool => tool.name), ['plan_next', 'reach_out']);
  const seen: unknown[] = [];
  const tools = lifeTools({ planNext: () => '', checkAlarm: () => '', cancelAlarm: () => '', notifier: none, keepPhoto: async input => { seen.push(input); return 'kept'; } });
  assert.deepEqual(tools.map(tool => tool.name), ['plan_next', 'reach_out', 'check_alarm', 'cancel_alarm', 'keep_photo']);
  const keep = tools.at(-1)!;
  assert.equal(await keep.execute({ caption: '好看', which: 2 }, {} as never), 'kept');
  assert.deepEqual(seen, [{ caption: '好看', which: 2 }]);
});
