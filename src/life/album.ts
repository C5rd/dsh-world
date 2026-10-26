import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { Message } from '@deepseek-ai/dsh-llm';
import { formatLocalTime } from '../timeContext.ts';

export const ALBUM_DIR = '相册';
export const ALBUM_INDEX = '相册.md';
const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as const;
const maxTitle = 40, maxCaption = 500;

export interface KeepInput { caption: string; title?: string; which?: number }

/** The images in partner-side messages, newest first: what she was just shown. */
export function recentImages(messages: readonly Message[]): ImageAttachmentRef[] {
  const found: ImageAttachmentRef[] = [];
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user') continue;
    for (const block of [...message.content].reverse()) if (block.type === 'image') found.push(block.attachment);
  }
  return found;
}
/** A file-name piece from her title: letters, digits and CJK stay, the rest becomes a dash. */
const slug = (title: string) => title.normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, maxTitle);

/**
 * Her keepsake photos. When she is shown a picture she wants to keep, a copy goes into her room beside the diary
 * with the words she kept it with, so it outlives the session it came in. The same picture is kept once.
 */
export function createAlbum(deps: { roomDir: string; timeZone: string; attachments(): AttachmentStore | undefined; now?(): Date }) {
  const folder = () => join(deps.roomDir, ALBUM_DIR);
  async function keep(images: readonly ImageAttachmentRef[], input: KeepInput): Promise<string> {
    const caption = input.caption?.trim();
    if (!caption) throw new Error('留照片要写下你为什么想留它（caption）。');
    if (caption.length > maxCaption) throw new Error(`留言太长了，请控制在 ${maxCaption} 个字以内。`);
    const title = input.title?.trim() ?? '';
    if (title.length > maxTitle) throw new Error(`标题太长了，请控制在 ${maxTitle} 个字以内。`);
    const which = input.which ?? 1;
    if (!Number.isInteger(which) || which < 1) throw new Error('which 要填 1 或更大的整数：1 是最近看到的那张，2 是再往前一张。');
    const ref = images[which - 1];
    if (!ref) throw new Error(images.length ? `这段对话里只有 ${images.length} 张图，没有第 ${which} 张。` : '这段对话里没有可以留的图片。');
    const attachments = deps.attachments();
    if (!attachments) throw new Error('宿主没有提供图片存储，现在留不了照片。');
    const { data } = await attachments.readImage(ref);
    const digest = createHash('sha256').update(data).digest('hex').slice(0, 12);
    mkdirSync(folder(), { recursive: true });
    const kept = readdirSync(folder()).find(name => name.includes(`-${digest}.`));
    if (kept) return `这张已经留在相册里了：${ALBUM_DIR}/${kept}`;
    const local = formatLocalTime(deps.now?.() ?? new Date(), deps.timeZone);
    const name = `${local.slice(0, 10)}-${local.slice(11, 16).replace(':', '')}${title ? `-${slug(title)}` : ''}-${digest}.${extension[ref.mediaType]}`;
    const target = join(folder(), name), temporary = `${target}.${process.pid}.tmp`;
    const fd = openSync(temporary, 'wx');
    try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, target);
    const index = join(folder(), ALBUM_INDEX);
    const heading = existsSync(index) ? '' : '# 相册\n\n我留下来的照片：日期、标题、文件和当时想留下它的话。\n\n';
    appendFileSync(index, `${heading}- ${local.slice(0, 10)} ${local.slice(11, 16)} · ${title || '（没起标题）'} · [${name}](${name}) · ${caption.replace(/\s*\n\s*/g, ' ')}\n`);
    return `已留在相册：${ALBUM_DIR}/${name}（${local.slice(0, 10)}）。想看时用文件工具打开它，相册.md 里有你写下的话。`;
  }
  return { keep };
}
export type Album = ReturnType<typeof createAlbum>;
