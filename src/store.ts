import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchiveCursor, ConversationRecord, PageQuery, RecordPage, WorldConfig } from './types.ts';
import { formatTimeContext } from './timeContext.ts';

export interface ExportProgress { sessionId: string; nextSeq: number; turn: number }
interface StoredRow { sequence: number; day: string; body: string; fileOffset: number | null; fileBytes: number | null }
const pageSize = 128;
const applicationId = 1146312535;

function positiveLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('dsh-world: page limit must be 1..1000');
}
function validateRecord(record: ConversationRecord, worldId: string): void {
  if (record.schemaVersion !== 1 || record.worldId !== worldId || !['user', 'assistant'].includes(record.role) || !['complete', 'interrupted'].includes(record.status) || typeof record.content !== 'string' || !record.content || !Number.isSafeInteger(record.sourceSeq) || record.sourceSeq < 0 || ['recordId', 'sourceSessionId', 'sourceMessageId', 'turnId'].some(key => typeof record[key as keyof ConversationRecord] !== 'string' || !record[key as keyof ConversationRecord])) throw new TypeError('dsh-world: invalid conversation record or world');
  if (new Date(record.occurredAt).toISOString() !== record.occurredAt) throw new TypeError('dsh-world: occurredAt must be an ISO UTC timestamp');
}

export function createArchiveStore(config: WorldConfig & { root: string }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(config.worldId)) throw new TypeError('dsh-world: invalid worldId');
  if (!config.agentPreset?.trim()) throw new TypeError('dsh-world: agentPreset is required');
  formatTimeContext(new Date(0), config.timeZone);
  const worldRoot = join(config.root, 'worlds', config.worldId);
  const directory = join(worldRoot, 'conversations');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(worldRoot, 'archive.sqlite'));
  let closed = false;
  try {
    db.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const currentId = db.prepare('PRAGMA application_id').get()?.application_id;
    if (currentId !== 0 && currentId !== applicationId) throw new Error('dsh-world: unrelated archive database');
    if (currentId === 0 && Number(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()?.n) > 0) throw new Error('dsh-world: unrelated archive schema');
    db.exec(`PRAGMA application_id=${applicationId};
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, recordId TEXT NOT NULL UNIQUE,
        day TEXT NOT NULL, occurredAt TEXT NOT NULL, turnId TEXT NOT NULL, sourceSeq INTEGER NOT NULL,
        body TEXT NOT NULL, fileOffset INTEGER, fileBytes INTEGER
      );
      CREATE INDEX IF NOT EXISTS recordOrder ON records(day DESC, occurredAt DESC, recordId DESC);
      CREATE INDEX IF NOT EXISTS turnOrder ON records(turnId, sourceSeq);
      CREATE INDEX IF NOT EXISTS pendingExports ON records(day, sequence) WHERE fileOffset IS NULL;
      CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, exportedBytes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS progress (sessionId TEXT PRIMARY KEY, nextSeq INTEGER NOT NULL, turn INTEGER NOT NULL);`);
    const binding = JSON.stringify({ schemaVersion: 1, worldId: config.worldId, agentPreset: config.agentPreset, timeZone: config.timeZone });
    db.prepare("INSERT OR IGNORE INTO metadata VALUES ('binding', ?)").run(binding);
    if (db.prepare("SELECT value FROM metadata WHERE key='binding'").get()?.value !== binding) throw new Error('dsh-world: world binding differs from its existing identity or time zone');
  } catch (error) {
    db.close();
    throw new Error(`dsh-world: cannot open ${worldRoot}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  function transaction<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function decode(row: StoredRow): ConversationRecord {
    const record = JSON.parse(row.body) as ConversationRecord;
    validateRecord(record, config.worldId);
    return record;
  }
  function dayOf(record: ConversationRecord): string {
    return formatTimeContext(new Date(record.occurredAt), config.timeZone).slice('当前时间：'.length, '当前时间：'.length + 10);
  }
  function flushDay(day: string): void {
    transaction(() => {
      const file = join(directory, `${day}.jsonl`);
      const missing = !existsSync(file);
      const fd = openSync(file, missing ? 'wx+' : 'r+', 0o600);
      try {
        let offset = Number(db.prepare('SELECT exportedBytes FROM days WHERE day=?').get(day)?.exportedBytes ?? 0);
        if (fstatSync(fd).size < offset) {
          db.prepare('UPDATE records SET fileOffset=NULL, fileBytes=NULL WHERE day=?').run(day);
          offset = 0;
        }
        let sequence = 0;
        while (true) {
          const pending = db.prepare('SELECT * FROM records WHERE day=? AND fileOffset IS NULL AND sequence>? ORDER BY sequence LIMIT ?').all(day, sequence, pageSize) as unknown as StoredRow[];
          if (!pending.length) break;
          for (const row of pending) {
            const bytes = Buffer.from(row.body + '\n');
            const remaining = fstatSync(fd).size - offset;
            const existing = Buffer.alloc(Math.min(bytes.length, remaining));
            readSync(fd, existing, 0, existing.length, offset);
            if (!bytes.subarray(0, existing.length).equals(existing)) throw new Error(`dsh-world: corrupt export ${file} at byte ${offset}; evidence preserved`);
            if (existing.length < bytes.length) {
              ftruncateSync(fd, offset);
              let written = 0;
              while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, offset + written);
            }
            db.prepare('UPDATE records SET fileOffset=?, fileBytes=? WHERE sequence=?').run(offset, bytes.length, row.sequence);
            offset += bytes.length;
            sequence = row.sequence;
          }
        }
        if (fstatSync(fd).size !== offset) throw new Error(`dsh-world: corrupt untracked export tail in ${file}; evidence preserved`);
        fsyncSync(fd);
        db.prepare('UPDATE days SET exportedBytes=? WHERE day=?').run(offset, day);
      } finally { closeSync(fd); }
    });
  }
  function flushExports(): void {
    let after = '';
    while (true) {
      const rows = db.prepare('SELECT DISTINCT day FROM records WHERE fileOffset IS NULL AND day>? ORDER BY day LIMIT ?').all(after, pageSize);
      if (!rows.length) break;
      for (const row of rows) { after = String(row.day); flushDay(after); }
    }
  }
  function verifyRows(rows: StoredRow[]): void {
    for (const day of new Set(rows.map(row => row.day))) {
      const file = join(directory, `${day}.jsonl`);
      const expected = Number(db.prepare('SELECT exportedBytes FROM days WHERE day=?').get(day)?.exportedBytes);
      if (!existsSync(file)) flushDay(day);
      else {
        const fd = openSync(file, 'r');
        let size: number;
        try { size = fstatSync(fd).size; } finally { closeSync(fd); }
        if (size !== expected) flushDay(day);
      }
      const fd = openSync(file, 'r');
      try {
        for (const row of rows.filter(row => row.day === day)) {
          const current = db.prepare('SELECT fileOffset, fileBytes FROM records WHERE sequence=?').get(row.sequence)!;
          const actual = Buffer.alloc(Number(current.fileBytes));
          readSync(fd, actual, 0, actual.length, Number(current.fileOffset));
          if (actual.toString('utf8') !== row.body + '\n') throw new Error(`dsh-world: corrupt export ${file} at byte ${current.fileOffset}; evidence preserved`);
        }
      } finally { closeSync(fd); }
    }
  }
  function checkWorld(worldId: string): void {
    if (worldId !== config.worldId) throw new Error('dsh-world: world scope mismatch');
  }
  async function commitRecords(records: readonly ConversationRecord[], progress?: ExportProgress): Promise<void> {
    try {
      for (const record of records) validateRecord(record, config.worldId);
      if (progress && (!progress.sessionId || !Number.isSafeInteger(progress.nextSeq) || progress.nextSeq < 0 || !Number.isSafeInteger(progress.turn) || progress.turn < 0)) throw new TypeError('dsh-world: invalid source progress');
      transaction(() => {
        for (const record of records) {
          const body = JSON.stringify(record);
          const previous = db.prepare('SELECT body FROM records WHERE recordId=?').get(record.recordId);
          if (previous && previous.body !== body) throw new Error(`dsh-world: replay conflict for ${record.recordId}`);
          const day = dayOf(record);
          db.prepare('INSERT OR IGNORE INTO records(recordId, day, occurredAt, turnId, sourceSeq, body) VALUES (?,?,?,?,?,?)').run(record.recordId, day, record.occurredAt, record.turnId, record.sourceSeq, body);
          db.prepare('INSERT OR IGNORE INTO days(day) VALUES (?)').run(day);
        }
        if (progress) db.prepare('INSERT INTO progress VALUES (?,?,?) ON CONFLICT(sessionId) DO UPDATE SET nextSeq=excluded.nextSeq, turn=excluded.turn WHERE excluded.nextSeq>=progress.nextSeq').run(progress.sessionId, progress.nextSeq, progress.turn);
      });
      // Canonical records and progress commit together; JSONL is a retryable export.
      try { flushExports(); }
      catch (error) { throw new Error('dsh-world: daily export failed; durable records await recovery', { cause: error }); }
    } catch (error) { throw new Error(`dsh-world: archive write failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  }
  async function readPage(query: PageQuery): Promise<RecordPage> {
    checkWorld(query.worldId); positiveLimit(query.limit); flushExports();
    const before = query.before;
    if (before && (!Number.isSafeInteger(before.maxSequence) || before.maxSequence < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(before.date))) throw new TypeError('dsh-world: invalid archive cursor');
    const maxSequence = before?.maxSequence ?? Number(db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM records').get()?.n);
    const rows = (before
      ? db.prepare('SELECT * FROM records WHERE sequence<=? AND (day, occurredAt, recordId)<(?,?,?) ORDER BY day DESC, occurredAt DESC, recordId DESC LIMIT ?').all(maxSequence, before.date, before.occurredAt, before.recordId, query.limit + 1)
      : db.prepare('SELECT * FROM records WHERE sequence<=? ORDER BY day DESC, occurredAt DESC, recordId DESC LIMIT ?').all(maxSequence, query.limit + 1)) as unknown as StoredRow[];
    const page = rows.slice(0, query.limit);
    verifyRows(page);
    const records = page.map(decode);
    const last = page.at(-1);
    const lastRecord = records.at(-1);
    const nextCursor: ArchiveCursor | undefined = rows.length > query.limit && last && lastRecord ? { date: last.day, occurredAt: lastRecord.occurredAt, recordId: lastRecord.recordId, maxSequence } : undefined;
    return { records, ...(nextCursor ? { nextCursor } : {}) };
  }
  async function readTurn(worldId: string, turnId: string, afterSeq = -1, limit = pageSize): Promise<ConversationRecord[]> {
    checkWorld(worldId); positiveLimit(limit); flushExports();
    const rows = db.prepare('SELECT * FROM records WHERE turnId=? AND sourceSeq>? ORDER BY sourceSeq LIMIT ?').all(turnId, afterSeq, limit) as unknown as StoredRow[];
    verifyRows(rows); return rows.map(decode);
  }
  function progress(sessionId: string): ExportProgress {
    const row = db.prepare('SELECT nextSeq, turn FROM progress WHERE sessionId=?').get(sessionId);
    return { sessionId, nextSeq: Number(row?.nextSeq ?? 0), turn: Number(row?.turn ?? 0) };
  }
  function sourcePage(afterId = '', limit = pageSize): string[] {
    positiveLimit(limit);
    return db.prepare('SELECT sessionId FROM progress WHERE sessionId>? ORDER BY sessionId LIMIT ?').all(afterId, limit).map(row => String(row.sessionId));
  }
  function stats(): { records: number; sessions: number } {
    const row = db.prepare("SELECT count(*) AS records, count(DISTINCT json_extract(body, '$.sourceSessionId')) AS sessions FROM records").get() as { records: number; sessions: number } | undefined;
    return { records: Number(row?.records ?? 0), sessions: Number(row?.sessions ?? 0) };
  }
  function close(): void { if (!closed) { closed = true; db.close(); } }
  return { appendRecords: (records: readonly ConversationRecord[]) => commitRecords(records), commitRecords, readPage, readTurn, progress, sourcePage, stats, close };
}
export type ArchiveStore = ReturnType<typeof createArchiveStore>;
