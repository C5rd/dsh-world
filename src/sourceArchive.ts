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

/**
 * Copies her conversations from the host's session logs into the archive. Each session is replayed from where
 * the archive left off; replays run one at a time, and a session already queued is not queued twice. Sessions
 * outside `archived` are left alone.
 */
export function createSourceArchive(ctx: Context, config: WorldConfig, store: ArchiveStore, archived: (sessionId: string) => boolean = () => true) {
  const dirty = new Set<string>();
  const jobs = new Map<string, Promise<void>>();
  const failures = new Map<string, unknown>();
  let tail = Promise.resolve();

  async function replay(sessionId: string): Promise<void> {
    const id = SessionId(sessionId);
    const live = ctx.sessions.get(id);
    if (live) await ctx.sessions.flush(live);
    const handle = await ctx.sessionPersistence.open(id, 'read');
    try {
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
  function schedule(sessionId: string): Promise<void> {
    // Not archived itself, it still waits for the replays already queued, so its memory block is current.
    if (!archived(sessionId)) return tail;
    dirty.add(sessionId);
    const pending = jobs.get(sessionId);
    if (pending) return pending;
    const job = tail.then(async () => {
      while (dirty.delete(sessionId)) await replay(sessionId);
      failures.delete(sessionId);
    });
    jobs.set(sessionId, job);
    tail = job.catch(error => { failures.set(sessionId, error); ctx.logger.error(error); }).finally(() => { jobs.delete(sessionId); });
    return job;
  }
  return {
    schedule,
    /** Every session the archive has seen, replayed again so nothing written while the plugin was off is missed. */
    async catchUp(): Promise<void> {
      let after = '';
      for (let ids = store.sourcePage(after); ids.length; ids = store.sourcePage(after)) for (const id of ids) { await schedule(id); after = id; }
    },
    /** Waits for every queued replay; rejects while any session still has an unresolved failure. */
    async flush(): Promise<void> {
      let current: Promise<void>;
      do { current = tail; await current; } while (current !== tail);
      if (failures.size) throw new AggregateError([...failures.values()], 'dsh-world: source archive has unresolved failures');
    },
  };
}
