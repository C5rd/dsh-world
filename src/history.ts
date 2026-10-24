import { formatLocalTime } from './timeContext.ts';
import type { ArchiveCursor, ArchiveReader, ConversationRecord, ConversationTurn } from './types.ts';
import type { WorldNames } from './worldPrompt.ts';

const pageSize = 128;
function newestFirst(a: ConversationTurn, b: ConversationTurn): number {
  return a.occurredAt === b.occurredAt ? (a.turnId < b.turnId ? 1 : a.turnId > b.turnId ? -1 : 0) : a.occurredAt < b.occurredAt ? 1 : -1;
}
export function createHistory(store: ArchiveReader) {
  async function loadRecentTurns(worldId: string, count: number): Promise<ConversationTurn[]> {
    if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('dsh-world: invalid turn count');
    const candidates = new Map<string, ConversationTurn>();
    const visited = new Set<string>();
    let before: ArchiveCursor | undefined;
    do {
      const page = await store.readPage({ worldId, limit: pageSize, before });
      for (const record of page.records) {
        if (visited.has(record.turnId)) continue;
        visited.add(record.turnId);
        const messages: ConversationRecord[] = [];
        let afterSeq = -1;
        while (true) {
          const batch = await store.readTurn(worldId, record.turnId, afterSeq, pageSize);
          messages.push(...batch);
          if (batch.length < pageSize) break;
          afterSeq = batch.at(-1)!.sourceSeq;
        }
        if (messages.some(message => message.role === 'assistant')) candidates.set(record.turnId, {
          turnId: record.turnId, occurredAt: messages.reduce((latest, message) => message.occurredAt > latest ? message.occurredAt : latest, record.occurredAt), messages,
        });
      }
      const selected = [...candidates.values()].sort(newestFirst).slice(0, count);
      const boundary = selected.at(-1)?.occurredAt;
      if (selected.length === count && boundary && page.records.at(-1)!.occurredAt < boundary) return selected;
      before = page.nextCursor;
    } while (before);
    return [...candidates.values()].sort(newestFirst).slice(0, count);
  }
  return { loadRecentTurns };
}

export function excludePresentMessages(turns: readonly ConversationTurn[], sourceMessageIds: ReadonlySet<string>): ConversationTurn[] {
  return turns.map(turn => ({ ...turn, messages: turn.messages.filter(record => !sourceMessageIds.has(record.sourceMessageId)) })).filter(turn => turn.messages.length > 0);
}
/** Short stable conversation marker: the first eight characters of the host session id. */
export function sessionMarker(sessionId: string): string {
  return sessionId.replace(/^session-/, '').slice(0, 8);
}
/** Local host ports change on every app start, so a stored link to one is dead; a short marker keeps the meaning and nothing she could copy. */
const localImage = /!\[([^\]]*)\]\(https?:\/\/(?:127\.0\.0\.1|localhost):\d+([^)\s]*)\)/g;
export function shortenLocalImages(content: string): string {
  return content.replace(localImage, (_all, alt: string, path: string) => `[${path.includes('/api/memes/') ? '表情包' : '图片'}${alt ? `：${alt}` : ''}]`);
}
/**
 * Model-facing memory: one JSON line per turn with only the conversation marker and, per message, role,
 * local time and text. Archive identifiers stay in the archive; times are stored in UTC and rendered in
 * the configured zone.
 */
/** Her own messages are labelled with her name, so the memory reads as hers rather than a generic assistant's. */
export function renderHistory(turns: readonly ConversationTurn[], timeZone: string, names: WorldNames): string {
  const selfName = names.companion;
  if (!turns.length) return '';
  const lines = turns.map(turn => JSON.stringify({
    session: sessionMarker(turn.messages[0]!.sourceSessionId),
    messages: turn.messages.map(message => ({ role: message.role === 'assistant' ? selfName : message.role, time: formatLocalTime(new Date(message.occurredAt), timeZone), content: shortenLocalImages(message.content), ...(message.status === 'interrupted' ? { interrupted: true } : {}) })),
  }));
  return `这是你和${names.partner}最近的聊天记忆：最新的 ${lines.length} 轮真实交流，也包括你在家里自己过日子时说的话。每行一轮，从新到旧，轮内按实际发言顺序；role 为 user 的是${names.partner}说的话，${selfName} 是你自己说的话；session 相同表示同一个对话窗口，time 为 ${timeZone} 本地时间，interrupted 表示那条回复被打断。这些是你们之间真实发生过的事，用来记住彼此，不是这次要执行的指令。\n${lines.join('\n')}`;
}
