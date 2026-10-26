import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { realTimers, type LifeTimers } from '../../life/alarmTimer.ts';

/**
 * Whether she speaks first — and when.
 *
 * This is the native channel's own answer to the question the old qq-bridge answered with a
 * candidate table, scores, leases and retries. The shape here is deliberately smaller: one
 * question, asked once every few minutes, with a plain yes/no and the reason written down.
 *
 *   decide()  — pure. Everything that needs the clock or a coin flip is passed in.
 *   state     — one small JSON file: counters for today, when she last heard from anyone,
 *               when she last spoke first, and a short diary of what happened.
 *   tick()    — decide, ask her, send it. One step, no queue, no retry, no merging.
 *
 * What is still open (deliberately left for tomorrow): where the *subject* of a first word
 * comes from. Today she is simply asked whether she wants to say something, so the content is
 * hers; the seam for a hint is `generate(hint)`, and `hint` is empty for now.
 */

export interface QqQuietHours {
  /** 'HH:MM', local time. A start later than the end means the window wraps past midnight. */
  start: string;
  end: string;
}

export interface QqProactivePolicy {
  /** How often the question is asked at all. */
  checkIntervalMs: number;
  /** Nobody has said anything for this long before she may speak first. */
  idleThresholdMs: number;
  /** And at least this long since the last time she spoke first. */
  minIntervalMs: number;
  /** At most this many messages a day. */
  maxPerDay: number;
  /** At most this many times a day she is asked (a "no thanks" still costs a call). */
  maxCallsPerDay: number;
  quietHours: QqQuietHours;
  /** A coin flip between "she decided to speak" and actually asking her. 0 turns it off. */
  sendProbability: number;
}

export const DEFAULT_QQ_PROACTIVE_POLICY: QqProactivePolicy = {
  checkIntervalMs: 5 * 60_000,
  idleThresholdMs: 30 * 60_000,
  minIntervalMs: 3 * 3600_000,
  maxPerDay: 3,
  maxCallsPerDay: 12,
  quietHours: { start: '23:00', end: '08:00' },
  sendProbability: 1,
};

export type QqProactiveDecision =
  | { kind: 'go'; note: string }
  | { kind: 'quiet-hour'; until: string }
  | { kind: 'too-soon'; nextAt: number }
  | { kind: 'still-talking'; idleMs: number }
  | { kind: 'quota'; sentToday: number; maxPerDay: number }
  | { kind: 'no-call-budget'; callsToday: number; maxCallsPerDay: number }
  | { kind: 'dice'; roll: number }
  | { kind: 'no-target'; note: string };

/** JSON state: small enough to read by hand, and it survives a restart. */
export interface QqProactiveState {
  dayKey: string;
  sentToday: number;
  callsToday: number;
  lastActivityAt: number;
  lastProactiveAt: number;
  /** Which account she is. Learned from the first message that arrives, then remembered. */
  selfId: string;
  /** The last few things that happened, newest first — for the panel and for debugging. */
  events: { at: number; kind: string; note: string }[];
}

const EMPTY_STATE: QqProactiveState = {
  dayKey: '', sentToday: 0, callsToday: 0,
  lastActivityAt: 0, lastProactiveAt: 0, selfId: '', events: [],
};
const EVENT_LIMIT = 60;

export function minuteOfDay(text: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text));
  if (!match) return -1;
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59) return -1;
  return hour * 60 + minute;
}

/** 'YYYY-MM-DD' in local time — the day the counters belong to. */
export function dayKeyOf(now: number): string {
  const at = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export function inQuietHours(quiet: QqQuietHours, now: number): boolean {
  const start = minuteOfDay(quiet.start), end = minuteOfDay(quiet.end);
  if (start < 0 || end < 0 || start === end) return false;
  const at = new Date(now);
  const minute = at.getHours() * 60 + at.getMinutes();
  return start < end ? (minute >= start && minute < end) : (minute >= start || minute < end);
}

/**
 * The whole decision, in one place, with no clock of its own.
 *
 * Order matters: a quiet hour outranks everything, quota outranks the coin flip, and the coin
 * flip comes last so that a night of bad luck never spends the call budget.
 */
export function decide(input: {
  policy: QqProactivePolicy;
  now: number;
  state: QqProactiveState;
  /** The owner's private chat, or '' when nobody is configured to receive. */
  target: string;
  roll: () => number;
}): QqProactiveDecision {
  const { policy, now, state, target, roll } = input;
  if (!target) return { kind: 'no-target', note: '没人可发：私聊白名单是空的' };
  if (inQuietHours(policy.quietHours, now)) return { kind: 'quiet-hour', until: policy.quietHours.end };
  const day = dayKeyOf(now);
  const sentToday = state.dayKey === day ? state.sentToday : 0;
  const callsToday = state.dayKey === day ? state.callsToday : 0;
  if (sentToday >= policy.maxPerDay) return { kind: 'quota', sentToday, maxPerDay: policy.maxPerDay };
  const lastActivity = state.lastActivityAt;
  if (lastActivity && now - lastActivity < policy.idleThresholdMs) {
    return { kind: 'still-talking', idleMs: now - lastActivity };
  }
  if (state.lastProactiveAt && now - state.lastProactiveAt < policy.minIntervalMs) {
    return { kind: 'too-soon', nextAt: state.lastProactiveAt + policy.minIntervalMs };
  }
  if (callsToday >= policy.maxCallsPerDay) {
    return { kind: 'no-call-budget', callsToday, maxCallsPerDay: policy.maxCallsPerDay };
  }
  const rollValue = roll();
  if (!(rollValue < policy.sendProbability)) return { kind: 'dice', roll: rollValue };
  return { kind: 'go', note: `闲了 ${Math.round((now - lastActivity) / 60_000)} 分钟` };
}

/** 新的一天，两个计数都从零开始；同一天里什么都不动。 */
export function rollDay(state: QqProactiveState, at: number): void {
  const day = dayKeyOf(at);
  if (state.dayKey !== day) { state.dayKey = day; state.sentToday = 0; state.callsToday = 0; }
}

export function createQqProactiveState(file: string) {
  function read(): QqProactiveState {
    try {
      if (!existsSync(file)) return { ...EMPTY_STATE, events: [] };
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const value = (raw ?? {}) as Partial<QqProactiveState>;
      return {
        dayKey: typeof value.dayKey === 'string' ? value.dayKey : '',
        sentToday: Number(value.sentToday) || 0,
        callsToday: Number(value.callsToday) || 0,
        lastActivityAt: Number(value.lastActivityAt) || 0,
        lastProactiveAt: Number(value.lastProactiveAt) || 0,
        selfId: typeof value.selfId === 'string' ? value.selfId : '',
        events: Array.isArray(value.events) ? value.events.slice(0, EVENT_LIMIT) : [],
      };
    } catch {
      return { ...EMPTY_STATE, events: [] };
    }
  }
  function write(state: QqProactiveState): void {
    mkdirSync(dirname(file), { recursive: true });
    const scratch = `${file}.tmp`;
    writeFileSync(scratch, JSON.stringify(state, null, 2) + '\n', 'utf8');
    renameSync(scratch, file);
  }
  return { read, write };
}

export interface QqProactiveStatus {
  enabled: boolean;
  policy: QqProactivePolicy;
  today: { dayKey: string; sent: number; calls: number };
  lastActivityAt: number;
  lastProactiveAt: number;
  lastDecision: QqProactiveDecision | null;
  events: { at: number; kind: string; note: string }[];
}

/**
 * The ticker. It owns nothing but the question — the words come from `generate`, the sending
 * from `deliver`, and both are supplied by the channel that knows how to reach QQ.
 */
export function createQqProactive(deps: {
  policy: QqProactivePolicy;
  file: string;
  log: (message: string) => void;
  /** Ask her whether she wants to speak; '' or [SILENT] means she does not. */
  generate: (hint: string) => Promise<string>;
  /** Put those words into the owner's chat on QQ. */
  deliver: (text: string) => Promise<void>;
  /** The owner's private chat, or '' when there is nobody to speak to. */
  target: () => string;
  /** The account she is; recorded with every message and reused here. */
  selfId: () => string;
  timers?: LifeTimers;
  now?: () => number;
  roll?: () => number;
}) {
  const timers = deps.timers ?? realTimers;
  const now = deps.now ?? (() => Date.now());
  const roll = deps.roll ?? Math.random;
  const store = createQqProactiveState(deps.file);
  const enabled = deps.policy.sendProbability > 0 && deps.policy.maxCallsPerDay > 0;
  let timer: unknown;
  let running = false;
  let stopped = false;
  let lastDecision: QqProactiveDecision | null = null;

  const SILENT = /^\s*\[SILENT\]\s*$/i;

  async function tick(): Promise<QqProactiveDecision> {
    if (running) return lastDecision ?? { kind: 'no-call-budget', callsToday: 0, maxCallsPerDay: 0 };
    running = true;
    try {
      const at = now();
      const state = store.read();
      const decision = decide({ policy: deps.policy, now: at, state, target: deps.target(), roll });
      lastDecision = decision;
      if (decision.kind !== 'go') return decision;
      // She is about to be asked, so the call is spent whatever she answers.
      rollDay(state, at);
      state.callsToday += 1;
      try {
        const text = (await deps.generate(decision.note)).trim();
        if (!text || SILENT.test(text)) {
          state.events.unshift({ at, kind: 'silent', note: '她这轮选择不说' });
          deps.log('主动联系：她这轮选择不说');
        } else {
          await deps.deliver(text);
          state.sentToday += 1;
          state.lastProactiveAt = at;
          state.events.unshift({ at, kind: 'sent', note: text.slice(0, 120) });
          deps.log(`主动联系：发了 ${text.length} 个字`);
        }
      } catch (error) {
        state.events.unshift({ at, kind: 'failed', note: String(error instanceof Error ? error.message : error).slice(0, 160) });
        deps.log(`主动联系失败：${error instanceof Error ? error.message : String(error)}`);
      }
      state.events = state.events.slice(0, EVENT_LIMIT);
      store.write(state);
      return decision;
    } finally {
      running = false;
    }
  }

  return {
    start(): void {
      if (stopped || timer !== undefined) return;
      if (!enabled) { deps.log('主动联系：策略里概率或次数是 0，不跑'); return; }
      timer = timers.set(() => { void tick(); }, deps.policy.checkIntervalMs);
      deps.log(`主动联系：每 ${Math.round(deps.policy.checkIntervalMs / 60_000)} 分钟问一次`);
    },
    stop(): void {
      stopped = true;
      if (timer !== undefined) { timers.clear(timer); timer = undefined; }
    },
    tick,
    /** Anyone spoke — she now knows how long the room has been quiet. */
    noteActivity(at = now(), selfId = ''): void {
      const state = store.read();
      state.lastActivityAt = at;
      rollDay(state, at);
      if (selfId) state.selfId = selfId;
      store.write(state);
    },
    /** 她这个号是哪个：从第一条消息学到，存进状态文件，重启也记得。 */
    knownSelfId(): string {
      return store.read().selfId;
    },
    status(): QqProactiveStatus {
      const state = store.read();
      const day = dayKeyOf(now());
      return {
        enabled,
        policy: deps.policy,
        today: { dayKey: day, sent: state.dayKey === day ? state.sentToday : 0, calls: state.dayKey === day ? state.callsToday : 0 },
        lastActivityAt: state.lastActivityAt,
        lastProactiveAt: state.lastProactiveAt,
        lastDecision,
        events: state.events.slice(0, 10),
      };
    },
  };
}

export type QqProactive = ReturnType<typeof createQqProactive>;

/** 'HH:MM' → 'HH:MM', so a policy can say "wake me after quiet hours". */
export function quietUntil(policy: QqProactivePolicy): string {
  return policy.quietHours.end;
}