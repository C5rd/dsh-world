import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AttachmentId, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment';
import { SessionId } from '@deepseek-ai/dsh-session';
import { admitContextImages } from '../src/ecosystem/wechat/images.ts';
import { createWechatHome } from '../src/ecosystem/wechat/home.ts';
import { channelContext } from '../src/ecosystem/shared/context.ts';
import { conversationKey } from '../src/ecosystem/shared/identity.ts';
import { extractConversationRecords } from '../src/archive.ts';
import { hostFixture, textResponse } from './hostFixture.ts';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';

const identity = { channel: 'wechat', accountId: 'bot', conversationType: 'group' as const, conversationId: 'group@chatroom', speakerId: 'wechat:owner' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a15kAAAAASUVORK5CYII=', 'base64');
const digest = createHash('sha256').update(png).digest('hex');
const image = { file: digest + '.png', quality: 'cached' as const };
const previous = { id: 'm.db:4', occurredAt: '2026-10-25T00:00:00Z', identity, text: '【图片】', image };

test('group images are committed before their session event and never become shared memory records', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('看到了'); });
  const incoming = join(root, 'incoming');
  const directory = join(incoming, createHash('sha256').update(conversationKey(identity)).digest('hex'));
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, image.file), png);
  const saved = join(root, 'saved.png');
  ctx.provide('attachments', {
    imageLimits: { maxImageBytes: 1024 },
    saveImages: async (inputs: readonly SaveImageAttachment[]) => {
      assert.equal(inputs.length, 1); assert.deepEqual(inputs[0].data, png);
      await writeFile(saved, inputs[0].data);
      return [{ attachmentId: AttachmentId(digest), mediaType: 'image/png', bytes: png.length, width: 1, height: 1 }];
    },
  } as never);
  const agent = (await ctx.agents.create({ sessionId: SessionId('group'), meta: { agentPreset: 'test' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => agent, images: (source, context) => admitContextImages(ctx, incoming, source, context) }); cleanup.push(channel.stop);
  await channel.ask('这是什么图片', identity, [previous]);
  assert.deepEqual(await readFile(saved), png);
  const context = requests[0].messages.find(message => message.source?.kind === 'dsh-world-channel-context')!;
  assert.ok(context.content.some(block => block.type === 'image' && block.attachment.attachmentId === digest));
  const log = await ctx.sessionPersistence.open(agent.id, 'read');
  try {
    const { events } = await log.read(0, 128);
    const pictureEvent = events.find(event => event.type === 'user/message' && event.data.source.kind === 'dsh-world-channel-context')!;
    assert.match(JSON.stringify(pictureEvent), new RegExp(digest));
    assert.deepEqual(extractConversationRecords(pictureEvent, { worldId: 'test', agentPreset: 'test', header: log.header, inheritedEventCount: 0, turn: 1 }), []);
    const actualUser = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')!;
    assert.doesNotMatch(JSON.stringify(actualUser), new RegExp(digest));
  } finally { await log.close(); }
});

test('image admission refuses traversal, another group and changed bytes before committing attachments', async t => {
  const { ctx, root } = await hostFixture(t, () => textResponse('unused'));
  let saves = 0;
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1024 }, saveImages: async () => { saves++; return []; } } as never);
  assert.throws(() => channelContext([{ ...previous, image: { ...image, file: '../private.png' } }], identity));
  const directory = join(root, createHash('sha256').update(conversationKey(identity)).digest('hex'));
  await mkdir(directory); await writeFile(join(directory, image.file), Buffer.from('different bytes'));
  await assert.rejects(admitContextImages(ctx, root, identity, [previous]), /digest/);
  await assert.rejects(admitContextImages(ctx, root, { ...identity, conversationId: 'other@chatroom' }, [previous]));
  assert.equal(saves, 0);
});
