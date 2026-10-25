import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableWrite } from './life/lifeStore.ts';

interface WorldSettings { running: boolean; dailyBudget?: number; memoryTurns?: number }
/** How many of the newest turns the memory block carries when nothing else is set. */
export const DEFAULT_MEMORY_TURNS = 200;

/**
 * Her world's own settings, changed from the world console and kept in `<world>/world.json` so they outlast a
 * restart: whether it runs (memory block, prompts, archive and life line together), how much her home may
 * spend a day, and how many recent turns her memory block carries. A world that already has a life line from before the switch existed is running; a new one waits
 * for its partner to press start.
 */
export function createWorldSwitch(worldDir: string) {
  const file = join(worldDir, 'world.json');
  const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Partial<WorldSettings> : undefined;
  let settings: WorldSettings = {
    running: stored ? stored.running === true : existsSync(join(worldDir, 'life.json')),
    ...(typeof stored?.dailyBudget === 'number' ? { dailyBudget: stored.dailyBudget } : {}),
    ...(validTurns(stored?.memoryTurns) ? { memoryTurns: stored.memoryTurns } : {}),
  };
  function save(next: WorldSettings): void {
    durableWrite(file, JSON.stringify(next, null, 2));
    settings = next;
  }
  return {
    running: () => settings.running,
    set: (running: boolean) => save({ ...settings, running }),
    /** CNY a day for her home; undefined is no limit. */
    dailyBudget: () => settings.dailyBudget,
    setDailyBudget(yuan: number | undefined): void {
      const { dailyBudget: _old, ...rest } = settings;
      save(yuan === undefined ? rest : { ...rest, dailyBudget: yuan });
    },
    /** Turns in her memory block; read when a block is built, so a change shows from the next session start or compaction. */
    memoryTurns: () => settings.memoryTurns ?? DEFAULT_MEMORY_TURNS,
    setMemoryTurns(turns: number | undefined): void {
      const { memoryTurns: _old, ...rest } = settings;
      save(turns === undefined || turns === DEFAULT_MEMORY_TURNS ? rest : { ...rest, memoryTurns: turns });
    },
  };
}
export type WorldSwitch = ReturnType<typeof createWorldSwitch>;
export const validTurns = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;
