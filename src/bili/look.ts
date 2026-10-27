/**
 * look.ts —— bili_look 里「看」这件事本身
 *
 * 为什么给她一个「主动看」的工具，而不是只让她等着被推送：
 *   **能不能自己决定看什么，是「自主」这个需要的唯一可验证载体。**
 *   如果她只能看定时器塞给她的东西，「可以说不」就永远只是一句话。
 *
 * 渲染的三条约束，与 client.ts 的三条同构：
 *   1. **只返回素材本身**。不写「我觉得」「这很有意思」，不替她总结——一旦代码替她总结，
 *      她就只是一个内容管道。
 *   2. **不回显状态**。没有「你今天还剩几次」「你已经看过几条」。她要判断的是内容，
 *      不是自己的额度。
 *   3. **不解释为什么少了**。被平台拦下就说「这一会儿看不见」，不教育她。
 */
import { comments, humanCount, humanDuration, popular, precious, ranking, related, video, type Comment, type Video } from './client.ts';

export interface LookInput {
  what?: string;
  bvid?: string;
}

export interface LookResult {
  ok: boolean;
  text: string;
  note: string;
}

const BV = /^BV[0-9A-Za-z]{8,12}$/;

function clip(text: string, max: number): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function when(seconds: number): string {
  if (!seconds) return '';
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function renderList(title: string, list: Video[]): string {
  const lines = list.map((item, index) => {
    const parts = [
      `${item.up || '（无 UP）'}`,
      humanDuration(item.duration),
      `播放 ${humanCount(item.play)}`,
      `弹幕 ${humanCount(item.danmaku)}`,
      item.bvid,
    ].filter(Boolean);
    return `${index + 1}. ${clip(item.title, 60)}\n   ${parts.join(' ｜ ')}`;
  });
  return `${title}\n\n${lines.join('\n')}`;
}

function renderVideo(item: Video, tags: string[]): string {
  const head = [
    item.up || '（无 UP）',
    item.tname || '',
    humanDuration(item.duration),
    `播放 ${humanCount(item.play)}`,
    `弹幕 ${humanCount(item.danmaku)}`,
  ].filter(Boolean);
  const blocks = [
    item.title,
    head.join(' ｜ '),
    when(item.pubdate) ? `发布 ${when(item.pubdate)}` : '',
    item.desc ? `简介：${clip(item.desc, 400)}` : '',
    tags.length ? `标签：${tags.slice(0, 12).join(' / ')}` : '',
    item.bvid,
  ];
  return blocks.filter(Boolean).join('\n');
}

function renderComments(list: Comment[]): string {
  const lines = list.map((item, index) => `[${humanCount(item.like)}] ${item.user}：${clip(item.message, 120)}`);
  return `热评（${list.length} 条）\n\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}`;
}

/** 调一次「看」。永不抛出：看不见东西也是一种结果，不是故障。 */
export async function biliLook(input: LookInput = {}): Promise<LookResult> {
  const what = String(input.what ?? 'hot');
  const bvid = String(input.bvid ?? '').trim();

  try {
    if (what === 'video' || what === 'comments') {
      if (!BV.test(bvid)) return { ok: false, text: '', note: '要看哪一条？给一个 BV 号。' };
      const detail = await video(bvid);
      if (!detail.ok) return { ok: false, text: '', note: detail.message ?? '这条没看到。' };
      const item = detail.video!;
      if (what === 'video') return { ok: true, text: renderVideo(item, detail.tags), note: '' };
      const hot = await comments(item.aid, 10);
      if (!hot.ok) return { ok: false, text: '', note: hot.message ?? '评论没取到。' };
      if (!hot.list.length) return { ok: true, text: `${item.title}\n\n（还没有评论）`, note: '' };
      return { ok: true, text: `${item.title}\n\n${renderComments(hot.list)}`, note: '' };
    }

    if (what === 'related') {
      if (!BV.test(bvid)) return { ok: false, text: '', note: '要看哪一条的相关推荐？给一个 BV 号。' };
      const list = await related(bvid, 12);
      if (!list.ok) return { ok: false, text: '', note: list.message ?? '相关推荐没取到。' };
      if (!list.list.length) return { ok: true, text: '（这一条没有相关推荐）', note: '' };
      return { ok: true, text: renderList('相关推荐', list.list), note: '' };
    }

    if (what === 'rank') {
      const list = await ranking(20);
      if (!list.ok) return { ok: false, text: '', note: list.message ?? '排行榜没取到。' };
      return { ok: true, text: renderList('全站排行榜', list.list), note: '' };
    }

    // 默认：热门。热门空的时候退到排行，再退到入站必刷——像一个人翻不到想看的会换一页。
    const first = await popular(24);
    let list = first.ok ? first.list : [];
    if (list.length < 2) {
      const second = await ranking(20);
      if (second.ok) list = [...list, ...second.list];
    }
    if (!list.length) {
      const third = await precious(24);
      if (third.ok) list = third.list;
    }
    if (!list.length) return { ok: false, text: '', note: first.message ?? '这一次什么都没看到。' };
    const unique = list.filter((item, index) => list.findIndex(other => other.bvid === item.bvid) === index);
    return { ok: true, text: renderList('热门', unique.slice(0, 16)), note: '' };
  } catch (error) {
    return { ok: false, text: '', note: `没看成：${error instanceof Error ? error.message : String(error)}` };
  }
}
