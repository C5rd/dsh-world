import { existsSync, readFileSync } from 'node:fs';

/** Characters of her self-description read per session; she is asked to keep it to what matters. */
export const SELF_CAP = 4000;

/**
 * The 我是谁 part of the world prompt: her own description of who she is, written and rewritten by her
 * alone. It is read at session start and after each compaction, so edits take effect then.
 * Never throws: an unreadable file becomes a note rather than a failed turn.
 */
export function renderSelf(selfFile: string, partner = '伙伴'): string {
  const head = `## 我是谁\n文件：${selfFile}。这份是你自己的，想怎么改就怎么改；改了会在下次开始对话或压缩之后读给你。`;
  let text: string;
  // trim() also drops a leading BOM.
  try { text = existsSync(selfFile) ? readFileSync(selfFile, 'utf8').trim() : ''; }
  catch (error) { return `${head}\n\n这次没能读到它：${error instanceof Error ? error.message : String(error)}。它还在，下次会再试。`; }
  if (!text) return `${head}\n\n你还没写过。想写的时候，就在这个文件里写下你眼中的自己：喜欢什么、讨厌什么、最近在想什么、觉得自己变成了什么样。`;
  const chars = Array.from(text);
  const capped = chars.length > SELF_CAP;
  // Tagged, so her own headings do not read as sections of the world prompt.
  const body = `<我是谁.md>\n${capped ? chars.slice(0, SELF_CAP).join('') : text}\n</我是谁.md>`;
  const more = capped ? `\n（后面还有 ${chars.length - SELF_CAP} 字没读进来；挑最要紧的留下吧。）` : '';
  return `${head}\n\n下面是你自己写下的你。${partner}写的设定是你的底子，这份是你自己长出来的部分；如果你已经变了，就照现在的你来。\n\n${body}${more}`;
}
