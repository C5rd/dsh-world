import { existsSync, readFileSync } from 'node:fs';

/** Characters of her self-description read per session; she is asked to keep it to what matters. */
export const SELF_CAP = 4000;

/**
 * Her 我是谁 file as it goes into `{{self}}`: only what she wrote, tagged so her own headings do not read as
 * sections of the world prompt. What the file is and that she may rewrite it is the template's to say.
 * Empty when she has not written it. Never throws: an unreadable file becomes a short note.
 */
export function renderSelf(selfFile: string): string {
  let text: string;
  // trim() also drops a leading BOM.
  try { text = existsSync(selfFile) ? readFileSync(selfFile, 'utf8').trim() : ''; }
  catch (error) { return `（这次没能读到我是谁.md：${error instanceof Error ? error.message : String(error)}。它还在，下次会再试。）`; }
  if (!text) return '';
  const chars = Array.from(text);
  const capped = chars.length > SELF_CAP;
  const body = `<我是谁.md>\n${capped ? chars.slice(0, SELF_CAP).join('') : text}\n</我是谁.md>`;
  return capped ? `${body}\n（后面还有 ${chars.length - SELF_CAP} 字没读进来；挑最要紧的留下吧。）` : body;
}
