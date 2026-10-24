import type { Context } from '@deepseek-ai/cordis';
import { SessionId, type Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { extractConversationRecords } from './archive.ts';
import type { ArchiveStore } from './store.ts';
import type { WorldConfig } from './types.ts';

const pageSize = 128;
export function belongsToWorld(session: Pick<Session, 'header'>, config: WorldConfig): boolean {
  const header = session.header;
  return header.agentPreset === config.agentPreset && header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0;
}
export function createSourceArchive(ctx: Context, config: WorldConfig, store: ArchiveStore) {
  async function replay(sessionId: string): Promise<void> {
    const id = SessionId(sessionId);
    const live = ctx.sessions.get(id);
    if (live) await ctx.sessions.flush(live);
    const handle = await ctx.sessionPersistence.open(id, 'read');
    try {
      if (!belongsToWorld(handle, config)) throw new Error(`dsh-world: source ${id} no longer matches world identity`);
      let { nextSeq, turn } = store.progress(id);
      while (true) {
        const { events } = await handle.read(nextSeq, pageSize);
        if (!events.length) break;
        const records = events.flatMap(event => {
          if (event.type === 'turn/start') turn = event.data.turn;
          return extractConversationRecords(event, { ...config, header: handle.header, inheritedEventCount: handle.inheritedEventCount, turn });
        });
        nextSeq = events.at(-1)!.seq + 1;
        await store.commitRecords(records, { sessionId: id, nextSeq, turn });
      }
    } finally { await handle.close(); }
  }
  return { replay };
}
