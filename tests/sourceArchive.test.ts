import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { createSourceArchive } from '../src/sourceArchive.ts';
import type { ArchiveStore } from '../src/store.ts';

class SessionPersistenceNotFoundError extends Error { override name = 'SessionPersistenceNotFoundError'; }
const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'UTC' } as never;

/** Two archived sessions, "a" first; `open` decides how each one fares. */
function fixture(open: (id: string) => Promise<unknown>, stored: (id: string) => boolean = () => true) {
  const opened: string[] = []; const forgotten: string[] = []; const warned: string[] = []; const errored: unknown[] = [];
  let served = false;
  const store = {
    sourcePage: (after: string) => { if (after || served) return []; served = true; return ['a', 'b']; },
    progress: () => ({ nextSeq: 0, turn: 0 }),
    commitRecords: async () => {},
    forgetProgress: (id: string) => { forgotten.push(id); },
  } as unknown as ArchiveStore;
  const ctx = {
    sessions: { get: () => undefined, flush: async () => {} },
    sessionPersistence: { list: async () => [], stat: async (id: string) => (stored(id) ? {} : undefined), open: async (id: string) => { opened.push(id); return open(id); } },
    logger: { warn: (message: string) => warned.push(message), error: (error: unknown) => errored.push(error) },
  } as unknown as Context;
  return { archive: createSourceArchive(ctx, config, store), opened, forgotten, warned, errored };
}
const emptyLog = { header: {}, inheritedEventCount: 0, read: async () => ({ events: [] }), close: async () => {} };

test('a session whose log vanished is skipped with a warning and does not count as a failure', async () => {
  const { archive, warned, forgotten } = fixture(async id => { if (id === 'a') throw new SessionPersistenceNotFoundError('a'); return emptyLog; });
  await archive.catchUp();
  await archive.flush();
  assert.deepEqual(forgotten, ['a']);
  assert.equal(warned.length, 1); assert.match(warned[0], /session a is no longer stored/);
});
test('one session failing does not stop catch-up of the next, and flush still reports it', async () => {
  const { archive, opened } = fixture(async id => { if (id === 'a') throw new Error('disk error'); return emptyLog; });
  await archive.catchUp();
  assert.deepEqual(opened, ['a', 'b']);
  await assert.rejects(archive.flush(), /unresolved failures/);
});
test('catch-up forgets the resume point of a session the host no longer has, and reads the others', async () => {
  const { archive, opened, forgotten } = fixture(async () => emptyLog, id => id !== 'a');
  await archive.catchUp();
  await archive.flush();
  assert.deepEqual(forgotten, ['a']);
  assert.deepEqual(opened, ['b']);
});
