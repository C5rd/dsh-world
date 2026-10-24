import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createHistory, renderHistory } from '../history.ts';
import { createDiaryReader } from '../life/diary.ts';
import type { LifeStore } from '../life/lifeStore.ts';
import type { LifeRuntime } from '../life/runtime.ts';
import type { ArchiveStore } from '../store.ts';
import type { WorldConfig } from '../types.ts';
import { worldNames } from '../worldPrompt.ts';
import type { ConsoleSources } from './routes.ts';

const SNAPSHOT_TTL_MS = 5000;
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  return Math.round(cjk * 0.6 + (text.length - cjk) / 3.5);
}
/** Repeated polling within a few seconds reuses one computation; a failed one is not cached. */
function cachedSnapshot(compute: () => Promise<unknown>): () => Promise<unknown> {
  let cached: { at: number; value: Promise<unknown> } | undefined;
  return () => {
    if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.value;
    const entry = { at: Date.now(), value: compute() };
    cached = entry;
    entry.value.catch(() => { if (cached === entry) cached = undefined; });
    return entry.value;
  };
}
async function memoryOf(config: WorldConfig, archive: ArchiveStore, history: ReturnType<typeof createHistory>) {
  const turns = await history.loadRecentTurns(config.worldId, 200);
  return { turns: turns.length, windowTurns: 200, approxTokens: estimateTokens(renderHistory(turns, config.timeZone, worldNames(config))), oldest: turns.at(-1)?.messages[0]?.occurredAt, ...archive.stats() };
}
export function consoleSources(ctx: Context, config: WorldConfig, archive: ArchiveStore, store: LifeStore, life: LifeRuntime, diaryDir: string, moreFaults: () => string[] = () => []): ConsoleSources {
  const history = createHistory(archive);
  const diary = createDiaryReader(diaryDir);
  return {
    snapshot: cachedSnapshot(async () => {
      const life_ = life.snapshot();
      const homeAgent = life_.homeSessionId ? ctx.agents.get(SessionId(life_.homeSessionId)) : undefined;
      return {
        worldId: config.worldId, timeZone: config.timeZone, now: new Date().toISOString(),
        life: { homeSessionId: life_.homeSessionId, status: homeAgent ? homeAgent.status : 'cold', alarm: life_.alarm, recentWakes: store.wakes().slice(-5).reverse() },
        health: [...life_.faults, ...moreFaults()],
        memory: await memoryOf(config, archive, history),
        compactions: store.compactions().slice(-5).reverse(),
        diaryDates: diary.dates(), activityDays: store.activityDays(),
      };
    }),
    activity: (day, outsideOnly) => store.activity(day).filter(record => !outsideOnly || record.outside).reverse(),
    diary: date => diary.read(date),
  };
}
/** The life line failed to start: the console still shows why, with memory and the diary, and no life state. */
export function degradedSources(config: WorldConfig, archive: ArchiveStore, diaryDir: string, fault: string): ConsoleSources {
  const history = createHistory(archive);
  const diary = createDiaryReader(diaryDir);
  return {
    snapshot: cachedSnapshot(async () => ({
      worldId: config.worldId, timeZone: config.timeZone, now: new Date().toISOString(),
      life: null, health: [fault], memory: await memoryOf(config, archive, history),
      compactions: [], diaryDates: diary.dates(), activityDays: [],
    })),
    activity: () => [],
    diary: date => diary.read(date),
  };
}
