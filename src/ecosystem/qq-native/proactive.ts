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
  /** 连着失败到这个数，当天就不再问了（免得账户没钱时每 5 分钟撞一次）。0 表示不管。 */
  failureLimit: number;
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
  failureLimit: 3,
  quietHours: { start: '23:00', end: '08:00' },
  sendProbability: 1,
};

export type QqProactiveDecision =
  | { kind: 'go'; note: string }
  /** 上一次 tick 还没跑完，这一次没排上 —— 「没轮到」，不是「不能发」。 */
  | { kind: 'busy' }
  | { kind: 'quiet-hour'; until: string }
  | { kind: 'too-soon'; nextAt: number }
  | { kind: 'still-talking'; idleMs: number }
  | { kind: 'quota'; sentToday: number; maxPerDay: number }
  | { kind: 'no-call-budget'; callsToday: number; maxCallsPerDay: number }
  | { kind: 'failed-too-often'; failures: number; limit: number }
  | { kind: 'dice'; roll: number }
  | { kind: 'no-target'; note: string };

/** JSON state: small enough to read by hand, and it survives a restart. */
export interface QqProactiveState {
  dayKey: string;
  sentToday: number;
  callsToday: number;
  /** 连续问了没问通几次（她那边答不出来 / 发不出去）。同一天里累加，换天清零。 */
  failures: number;
  lastActivityAt: number;
  lastProactiveAt: number;
  /** Which account she is. Learned from the first message that arrives, then remembered. */
  selfId: string;
  /** The last few things that happened, newest first — for the panel and for debugging. */
  events: { at: number; kind: string; note: string }[];
}

const EMPTY_STATE: QqProactiveState = {
  dayKey: '', sentToday: 0, callsToday: 0, failures: 0,
  lastActivityAt: 0, lastProactiveAt: 0, selfId: '', events: [],
};
const EVENT_LIMIT = 60;
/** 「谁在说话」这件事一分钟落一次盘就够了：静默门槛是几十分钟，秒级的差别没有意义。 */
const ACTIVITY_WRITE_MS = 60_000;

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
  // 连着撞了几次墙就别再撞：白天剩下的时间里安静待着，第二天照常。
  // 和 sent/calls 一样按天算 —— 不然跨过零点它还停着（rollDay 在 decide 之后才跑）。
  const failures = state.dayKey === day ? (state.failures ?? 0) : 0;
  if (policy.failureLimit > 0 && failures >= policy.failureLimit) {
    return { kind: 'failed-too-often', failures, limit: policy.failureLimit };
  }
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
  // 「闲了多久」是写给她看的一句话。从来没收到过消息时别报天文数字；
  // 账本里要是留着个明显不可能是「最近」的时间戳（清账留下的零头之类），也当没说过话。
  const idleMs = lastActivity > 0 && now - lastActivity < 365 * 24 * 3600_000 ? now - lastActivity : 0;
  const idleNote = idleMs === 0
    ? '一直没人说过话'
    : idleMs < 3600_000
      ? `闲了 ${Math.round(idleMs / 60_000)} 分钟`
      : idleMs < 24 * 3600_000
        ? `闲了 ${Math.round(idleMs / 3600_000)} 小时`
        : `闲了 ${Math.round(idleMs / (24 * 3600_000))} 天`;
  return { kind: 'go', note: idleNote };
}

/** 新的一天，两个计数都从零开始；同一天里什么都不动。 */
export function rollDay(state: QqProactiveState, at: number): void {
  const day = dayKeyOf(at);
  if (state.dayKey !== day) { state.dayKey = day; state.sentToday = 0; state.callsToday = 0; state.failures = 0; }
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
        failures: Number(value.failures) || 0,
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
  /** 演练中：判而不做。 */
  dryRun: boolean;
  policy: QqProactivePolicy;
  today: { dayKey: string; sent: number; calls: number; failures: number };
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
  /** 演练：只判不做 —— 决定照记，但不问她也不发消息。 */
  dryRun?: () => boolean;
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
    // 重入（上一轮还没跑完）时别再拿上一轮的决定冒充这一轮：`lastDecision` 是上一次问出来的答案，
    // 而这里真正发生的事只有一件 —— 这一次没排上。旧写法两种情况都返回 lastDecision，兜底那句
    // `no-call-budget` 更是编的（真实原因是「在忙」，不是「今天的额度用完了」）；谁以后拿这个返回值
    // 做判断，就会把「没跑」读成「跑了但没资格」。想看上一轮判了什么，读 status().lastDecision。
    if (running) return { kind: 'busy' };
    running = true;
    try {
      const at = now();
      const state = store.read();
      const decision = decide({ policy: deps.policy, now: at, state, target: deps.target(), roll });
      lastDecision = decision;
      if (decision.kind !== 'go') return decision;
      rollDay(state, at);
      if (deps.dryRun?.()) {
        state.events.unshift({ at, kind: 'dry-run', note: "演练：本该问她一次（" + decision.note + "），没问" });
        state.events = state.events.slice(0, EVENT_LIMIT);
        store.write(state);
        deps.log("主动联系：演练模式，没问她（" + decision.note + "）");
        return decision;
      }
      // She is about to be asked, so the call is spent whatever she answers.
      state.callsToday += 1;
      try {
        const text = (await deps.generate(decision.note)).trim();
        state.failures = 0;   // 问通了就算连上，哪怕她这轮选择不说
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
        state.failures = (state.failures ?? 0) + 1;
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
      // 群里一热闹就是几十条消息，每条都重写一遍这个文件没必要。一分钟内只落一次；
      // 换天（配额要归零）和第一次学到 selfId 要立刻落，时钟往回跳也照落不误。
      const worthWriting = state.dayKey !== dayKeyOf(at)
        || (selfId !== '' && selfId !== state.selfId)
        || at < state.lastActivityAt
        || at - state.lastActivityAt >= ACTIVITY_WRITE_MS;
      state.lastActivityAt = at;
      rollDay(state, at);
      if (selfId) state.selfId = selfId;
      if (worthWriting) store.write(state);
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
        dryRun: deps.dryRun?.() === true,
        policy: deps.policy,
        today: {
          dayKey: day,
          sent: state.dayKey === day ? state.sentToday : 0,
          calls: state.dayKey === day ? state.callsToday : 0,
          failures: state.dayKey === day ? (state.failures ?? 0) : 0,
        },
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