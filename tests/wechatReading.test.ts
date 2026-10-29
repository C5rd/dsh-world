import assert from 'node:assert/strict';
import test from 'node:test';
import { createWechatReading } from '../src/ecosystem/wechat/reading.ts';
import { speakerIdentity } from '../src/ecosystem/shared/identity.ts';

const identity = speakerIdentity({ channel: 'wechat', accountId: 'bot', speakerId: 'wechat:bot', conversationId: 'family@chatroom', conversationType: 'group', conversationName: '家人' });
const entry = { id: 'm.db:1', occurredAt: '2026-10-27T10:00:00Z', text: '今晚吃面', identity: { ...identity, speakerId: 'wechat:dad', speakerName: '爸爸' } };
function fixture() {
  let allowed = true;
  const reading = createWechatReading({ target: (id: string) => { if (!allowed || id !== identity.conversationId) throw new Error('聊天不在配置中'); return identity; } });
  const controller = new AbortController();
  const run = (args: object = {}) => reading.tool.execute({ chatId: identity.conversationId, ...args }, { signal: controller.signal } as never);
  return { reading, controller, run, revoke: () => { allowed = false; } };
}

test('history reads a configured group without a mention and keeps the same chatId and stable cursor for sending', async t => {
  const { reading, run } = fixture(); t.after(reading.stop);
  const result = run({ limit: 2 });
  const job = reading.poll()!;
  assert.equal(job.chatId, identity.conversationId); assert.equal(job.accountId, 'bot'); assert.equal(job.limit, 2);
  assert.deepEqual(reading.poll(), job, 'read-only requests can safely be delivered again until answered');
  reading.accept({ id: job.id, accountId: 'bot', chatId: job.chatId, messages: [entry], nextCursor: 'older-page' });
  const page = JSON.parse(await result as string);
  assert.equal(page.chatId, identity.conversationId); assert.equal(page.messages[0].identity.speakerId, 'wechat:dad');
  const older = run({ cursor: page.nextCursor });
  const next = reading.poll()!; assert.equal(next.cursor, 'older-page');
  reading.accept({ id: next.id, accountId: 'bot', chatId: next.chatId, messages: [] });
  assert.deepEqual(JSON.parse(await older as string).messages, []);
  assert.equal(reading.poll(), undefined);
});

test('history rejects invalid pagination, private chats, another account and cross-group results', async t => {
  const { reading, run } = fixture(); t.after(reading.stop);
  for (const args of [{ limit: 0 }, { limit: 21 }, { chatId: 'private' }, { cursor: '' }]) await assert.rejects(run(args));
  const result = run(); const job = reading.poll()!;
  assert.throws(() => reading.accept({ id: job.id, accountId: 'other', chatId: job.chatId, messages: [] }));
  assert.throws(() => reading.accept({ id: job.id, accountId: 'bot', chatId: job.chatId, messages: [{ ...entry, identity: { ...entry.identity, conversationId: 'other@chatroom' } }] }));
  reading.accept({ id: job.id, accountId: 'bot', chatId: job.chatId, error: '数据库快照不可读取' });
  await assert.rejects(result, /数据库快照不可读取/);
});

test('cancellation, stopping and a removed target release waiting reads; late results are harmless', async () => {
  const f = fixture();
  const pending = f.run(); const job = f.reading.poll()!;
  f.controller.abort(new Error('turn cancelled')); await assert.rejects(pending, /turn cancelled/);
  assert.equal(f.reading.poll(), undefined);
  f.reading.accept({ id: job.id, accountId: 'bot', chatId: job.chatId, messages: [] });
  const g = fixture(); const removed = g.run(); g.revoke();
  assert.equal(g.reading.poll(), undefined); await assert.rejects(removed, /聊天不在配置中/);
  const stopped = f.reading.tool.execute({ chatId: identity.conversationId }, { signal: new AbortController().signal } as never);
  f.reading.stop(); await assert.rejects(stopped, /停止/); g.reading.stop();
});

test('an absent or old adapter times out instead of hanging the model turn', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { reading, run } = fixture(); t.after(reading.stop);
  const pending = run(); const failed = assert.rejects(pending, /超时/);
  t.mock.timers.tick(30_000); await failed;
  assert.equal(reading.poll(), undefined);
});

test('only consumed successful reads acknowledge clearing; duplicate deliveries keep the same result', async t => {
  const f = fixture(); t.after(f.reading.stop);
  const pending = f.run(); const job = f.reading.poll()!;
  const result = { id: job.id, accountId: 'bot', chatId: job.chatId, messages: [entry] };
  assert.equal(f.reading.accept(result), true); await pending;
  assert.equal(f.reading.accept(result), true, 'a lost HTTP acknowledgement may be retried');
  assert.equal(f.reading.accept({ ...result, messages: [] }), false);
  const g = fixture(); t.after(g.reading.stop);
  const cancelled = g.run(); const old = g.reading.poll()!;
  g.controller.abort(new Error('cancelled')); await assert.rejects(cancelled);
  assert.equal(g.reading.accept({ ...result, id: old.id }), false, 'a late ignored result must not clear unread');
});
