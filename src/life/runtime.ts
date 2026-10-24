import { mkdirSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-loop';
import type {} from '@deepseek-ai/dsh-compaction';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-tools';
import '../hostContract.ts';
import { belongsToWorld } from '../sourceArchive.ts';
import { formatLocalTime } from '../timeContext.ts';
import type { WorldConfig } from '../types.ts';
import { summarizeCall } from './activity.ts';
import { formatDuration, MAX_TIMER_MS, nextLocalTime, resolveAlarmTime, wakeText } from './alarm.ts';
import { exampleTime, readAlarmMessages } from './messages.ts';
import { alarmDescriptions } from './tools.ts';
import type { LifeHost } from './host.ts';
import type { LifeStore } from './lifeStore.ts';
import type { Notifier } from './notify.ts';
import { lifeTools } from './tools.ts';
import type { Alarm, LifeOptions } from './types.ts';
import { homeTitle, worldNames } from '../worldPrompt.ts';

const retryMinutes = [1, 5, 15, 30, 60];
/** Timers wait at most this long before re-checking the wall clock, so suspend and clock changes cannot strand an alarm. */
const SEGMENT_MS = 5 * 60_000;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface LifeTimers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
export interface LifeDeps { ctx: Context; config: WorldConfig; options: LifeOptions; store: LifeStore; host: LifeHost; notifier: Notifier; clock?: () => Date; timers?: LifeTimers }
interface PendingCall { sessionId: string; name: string; arguments: string; time: string }

/** Disposes in reverse; a disposer whose agent scope is already gone may throw and is skipped. */
function undo(list: (() => void)[]): void {
  for (const dispose of list.splice(0).reverse()) { try { dispose(); } catch { /* scope already disposed */ } }
}
/** All or nothing: a failing step rolls back the ones before it. */
function registerAll(steps: (() => () => void)[]): (() => void)[] {
  const done: (() => void)[] = [];
  try { for (const step of steps) done.push(step()); } catch (error) { undo(done); throw error; }
  return done;
}

export function createLifeRuntime(deps: LifeDeps) {
  const { ctx, config, options, store, host } = deps;
  const names = worldNames(config);
  const clock = deps.clock ?? (() => new Date());
  const timers: LifeTimers = deps.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  const faults = new Map<string, string>();
  const disposers: (() => void)[] = [];
  /** reach_out, held by the current home only. */
  const registrations = new Map<Agent, (() => void)[]>();
  /** The alarm tools, held by every world session: she can set her alarm anywhere; it rings at home. */
  const alarmRegistrations = new Map<Agent, (() => void)[]>();
  const calls = new Map<string, PendingCall>();
  const shadowed = new Map<string, number>();
  let state = store.read();
  let timer: unknown;
  let retry = 0;
  /** A failed delivery waits until here before trying again. */
  let retryAt: number | undefined;
  let started = false;
  let stopped = false;
  let delivery: Promise<void> | undefined;
  let homing: Promise<Agent> | undefined;
  /** A new home whose title is not applied yet; retried on the same session. */
  let needsTitle: string | undefined;
  /** A new home before its first turn ends: the host's first-prompt titler renames it then, so the title is applied once more. */
  let awaitingFirstTurn: string | undefined;

  const save = () => store.write(state);
  const track = (key: string, label: string, run: () => Promise<void>) => run().then(() => { faults.delete(key); }, error => { faults.set(key, `${label}没送到：${message(error)}`); throw error; });
  // Each channel's last failure is a fault until it works again.
  const { toast } = deps.notifier;
  const notifier: Notifier = {
    ...(toast ? { toast: (title: string, body: string) => track('toast', '系统通知', () => toast(title, body)) } : {}),
    outlets: deps.notifier.outlets.map(outlet => ({ ...outlet, send: push => track(`outlet:${outlet.name}`, outlet.name, () => outlet.send(push)) })),
  };

  const dueAt = (alarm: Alarm) => Math.max(Date.parse(alarm.at), retryAt ?? 0);
  function arm(): void {
    if (timer !== undefined) { timers.clear(timer); timer = undefined; }
    if (stopped || !state.alarm) return;
    const wait = Math.max(0, dueAt(state.alarm) - clock().getTime());
    timer = timers.set(() => {
      timer = undefined;
      // Every timer, retries included, re-checks: an alarm is never delivered before it is due.
      if (state.alarm && dueAt(state.alarm) > clock().getTime()) arm(); else void deliver();
    }, Math.min(wait, SEGMENT_MS, MAX_TIMER_MS));
  }
  /** A new alarm replaces a failing one, so its retry state and fault go with it. Saved or not, it is armed. */
  function setAlarm(alarm: Alarm): void {
    if (stopped) return;
    state.alarm = alarm; retry = 0; retryAt = undefined; faults.delete('delivery'); faults.delete('alarm');
    try { save(); }
    catch (error) { faults.set('alarm', `闹钟没能保存：${message(error)}`); throw error; }
    finally { arm(); }
  }
  /** Keeps the life line from stopping when she has nothing scheduled. */
  function fallbackAlarm(): void {
    if (state.alarm || stopped) return;
    const now = clock();
    try { setAlarm({ at: nextLocalTime(now, options.fallbackWakeTime, options.timeZone).toISOString(), note: '', setAt: now.toISOString(), source: 'fallback' }); }
    // Unsaved, it still rings while the app keeps running (setAlarm arms it either way).
    catch (error) { faults.set('alarm', `断线保护闹钟没能保存：${message(error)}`); ctx.logger.error(error); }
  }
  function planNext(input: { at?: string; after_minutes?: number }, note: string): string {
    if (stopped) throw new Error('生活线已停止');
    const now = clock();
    const at = resolveAlarmTime(input, now, options.timeZone);
    const old = state.alarm;
    setAlarm({ at: at.toISOString(), note: note.trim(), setAt: now.toISOString(), source: 'plan' });
    // What her own old alarm carried is gone for good, so she is told while she can still copy it over.
    // The plugin's first/fallback alarms are not her plans and are replaced silently.
    const replaced = old?.source === 'plan' ? `（替换了原来 ${formatLocalTime(new Date(old.at), options.timeZone)} 的闹钟${old.note ? `，那条留言是：「${old.note}」。要保留里面的安排，就写进新留言` : ''}。）` : '';
    return `好，闹钟定在 ${formatLocalTime(at, options.timeZone)}。${replaced}`;
  }
  const local = (at: string | Date) => formatLocalTime(new Date(at), options.timeZone);
  /** Her alarm wording, read when it is used; an unreadable template is a fault and the shipped one is used. */
  function alarmMessages() {
    const messages = readAlarmMessages(options.alarmFile);
    if (messages.error) faults.set('alarm-template', messages.error); else faults.delete('alarm-template');
    return messages;
  }
  const templateValues = () => ({ name: names.companion, partner: names.partner, homeTitle: homeTitle(names), timeZone: options.timeZone, fallbackWakeTime: options.fallbackWakeTime, example: exampleTime(options.timeZone) });
  function checkAlarm(): string {
    const alarm = state.alarm;
    if (!alarm) return '现在没有闹钟。';
    const left = Date.parse(alarm.at) - clock().getTime();
    const when = `${local(alarm.at)}（${left > 0 ? `还有 ${formatDuration(left)}` : '已经到点，正在叫你'}）`;
    if (alarm.source === 'plan') return `下一次闹钟在 ${when}，是你自己定的，${alarm.note ? `留言是：「${alarm.note}」` : '没有留言'}。`;
    if (alarm.source === 'fallback') return `你现在没有自己定的闹钟。下一次会在 ${when}按平常的时间叫你。`;
    return `下一次是家里的第一次唤醒，在 ${when}。`;
  }
  /** Back to the morning fallback, exactly as if she had set nothing. */
  function cancelAlarm(): string {
    if (stopped) throw new Error('生活线已停止');
    const old = state.alarm;
    if (old?.source !== 'plan') {
      fallbackAlarm();
      return `现在没有你自己定的闹钟，不用取消。${state.alarm ? `下一次会在 ${local(state.alarm.at)} 按平常的时间叫你。` : ''}`;
    }
    const now = clock();
    const next = nextLocalTime(now, options.fallbackWakeTime, options.timeZone);
    setAlarm({ at: next.toISOString(), note: '', setAt: now.toISOString(), source: 'fallback' });
    return `好，取消了 ${local(old.at)} 的闹钟${old.note ? `，那条留言是：「${old.note}」` : ''}。不另定的话，会在 ${local(next)} 按平常的时间叫你。`;
  }
  function attach(agent: Agent): void {
    if (stopped || !belongsToWorld(agent.session, config)) return;
    const home = agent.id === state.homeSessionId;
    const needsAlarm = !alarmRegistrations.get(agent)?.length, needsHome = home && !registrations.get(agent)?.length;
    if (!needsAlarm && !needsHome) return;
    const tools = lifeTools({ planNext, checkAlarm, cancelAlarm, notifier, names, origin: () => { try { return host.origin(); } catch { return undefined; } }, descriptions: alarmDescriptions(alarmMessages(), templateValues()) });
    const register = (names: string[]) => registerAll(tools.filter(tool => names.includes(tool.name)).map(tool => () => agent.ctx.tools.register(tool)));
    if (needsAlarm) alarmRegistrations.set(agent, register(['plan_next', 'check_alarm', 'cancel_alarm']));
    if (needsHome) registrations.set(agent, register(['reach_out']));
  }
  /** Never lets a registration failure break agent creation. */
  function safeAttach(agent: Agent): void {
    try { attach(agent); faults.delete(`attach:${agent.id}`); }
    catch (error) { faults.set(`attach:${agent.id}`, `工具挂载失败：${message(error)}`); ctx.logger.error(error); }
  }
  /** Only the current home keeps reach_out; the alarm tools stay with every session. */
  function releaseOldHomes(): void {
    for (const [agent, list] of registrations) if (agent.id !== state.homeSessionId) undo(list);
  }
  /** Full access is granted on every resolve (selecting the preset in effect is a no-op), so no "still needs access" state has to survive a restart. */
  async function prepare(agent: Agent): Promise<void> {
    host.setFullAccess(agent.session);
    if (needsTitle === agent.id && await title(agent.id) && needsTitle === agent.id) needsTitle = undefined;
  }
  async function title(sessionId: string): Promise<boolean> {
    try { await host.rename(sessionId, homeTitle(names)); faults.delete('rename'); return true; }
    catch (error) { faults.set('rename', `家改名失败：${message(error)}`); ctx.logger.error(error); return false; }
  }
  /** The current home, resolving or rebuilding it; one attempt at a time. The bridge comes in through here too. */
  function home(): Promise<Agent> {
    return homing ??= openHome().finally(() => { homing = undefined; });
  }
  /** A rebuilt home without a pending alarm gets a first wake. */
  async function openHome(): Promise<Agent> {
    const current = state.homeSessionId;
    if (current && !host.isArchived(current)) {
      const agent = await host.resolveAgent(current);
      if (agent) { await prepare(agent); attach(agent); return agent; }
    }
    mkdirSync(options.roomDir, { recursive: true });
    const sessionId = await host.createSession(options.roomDir, config.agentPreset);
    if (stopped) throw new Error('生活线已停止');
    // Recorded before anything else can fail, so a retry reuses this session instead of creating another.
    state.homeSessionId = sessionId; needsTitle = sessionId; awaitingFirstTurn = sessionId;
    if (!state.alarm) state.alarm = { at: clock().toISOString(), note: '', setAt: clock().toISOString(), source: 'first' };
    releaseOldHomes();
    save();
    const agent = await host.resolveAgent(sessionId);
    if (!agent) throw new Error(`dsh-world: the new home ${sessionId} cannot be resolved`);
    await prepare(agent);
    attach(agent);
    return agent;
  }
  /** Joins an in-flight delivery instead of starting a second one. */
  function deliver(): Promise<void> {
    if (stopped || !state.alarm) return delivery ?? Promise.resolve();
    return delivery ??= send(state.alarm).finally(() => { delivery = undefined; });
  }
  async function send(alarm: Alarm): Promise<void> {
    let now = clock();
    try {
      // Resolve (or rebuild) the home first: a rebuilt home must still see this alarm as pending.
      const agent = await home();
      if (stopped) return;
      // A newer alarm (plan_next, fallback) replaced this one meanwhile: it keeps its own time.
      if (state.alarm !== alarm) { arm(); return; }
      // Cleared before steering so a turn that ends quickly already sees "no alarm" and gets the fallback.
      delete state.alarm;
      now = clock();
      agent.steer(createUserMessage({ source: { kind: 'dsh-world-life' }, content: [{ type: 'text', text: wakeText(alarm, now, options.timeZone, options.fallbackWakeTime, alarmMessages(), templateValues()) }] }));
      await ctx.sessions.flush(agent.session);
    } catch (error) {
      ctx.logger.error(error);
      if (stopped) return;
      if (state.alarm && state.alarm !== alarm) { faults.set('delivery', `闹钟送达失败：${message(error)}`); arm(); return; }
      state.alarm = alarm;
      const minutes = retryMinutes[Math.min(retry++, retryMinutes.length - 1)]!;
      retryAt = clock().getTime() + minutes * 60_000;
      faults.set('delivery', `闹钟送达失败，${minutes} 分钟后重试：${message(error)}`);
      arm();
      return;
    }
    if (stopped) return;
    // Steered and durable: the alarm is delivered. Recording it may fail, but it is never sent again.
    retry = 0; retryAt = undefined; faults.delete('delivery'); faults.delete('home');
    try {
      save();
      store.appendWake({ scheduledAt: alarm.at, deliveredAt: now.toISOString(), source: alarm.source, lateMs: Math.max(0, now.getTime() - Date.parse(alarm.at)) });
      faults.delete('state');
    } catch (error) { faults.set('state', `生活状态没能保存：${message(error)}`); ctx.logger.error(error); }
    arm();
  }
  function logActivity(callId: string, call: PendingCall, status?: 'ok' | 'error'): void {
    const { summary, outside } = summarizeCall(call.name, call.arguments, options.roomDir);
    if (store.appendActivity({ time: call.time, sessionId: call.sessionId, callId, tool: call.name, summary, outside, ...(status ? { status } : {}) })) faults.delete('activity');
    else { faults.set('activity', '活动记录写入失败，下一条会标记缺口'); ctx.logger.error('dsh-world: activity log write failed'); }
  }
  async function start(): Promise<void> {
    if (started) throw new Error('dsh-world: life line already started');
    started = true;
    disposers.push(ctx.on('agent/created', ({ agent }) => { safeAttach(agent); return undefined; }));
    disposers.push(ctx.on('agent/disposed', ({ agent }) => { registrations.delete(agent); alarmRegistrations.delete(agent); faults.delete(`attach:${agent.id}`); }));
    disposers.push(ctx.on('agent/inbox/inserted', ({ agent, message: inserted }) => {
      // Her partner's words reach her at the next step, like being called while busy.
      if (agent.id !== state.homeSessionId || inserted.source.kind !== 'user' || agent.status !== 'running') return;
      if (!agent.inbox.nextTurn.some(queued => queued.id === inserted.id)) return;
      agent.inbox.remove(inserted.id); agent.steer(inserted);
    }));
    disposers.push(ctx.on('session/event', (session, event) => {
      if (!belongsToWorld(session, config)) return;
      if (event.type === 'compaction/summary') shadowed.set(event.data.compactionId, event.data.shadowedTokenCount);
      if (event.type === 'compaction/end') {
        const tokens = shadowed.get(event.data.compactionId); shadowed.delete(event.data.compactionId);
        try {
          store.appendCompaction({ time: new Date(event.time).toISOString(), sessionId: session.id, ok: event.data.error === undefined, ...(tokens === undefined ? {} : { shadowedTokens: tokens }), ...(event.data.error === undefined ? {} : { error: event.data.error }) });
          faults.delete('compaction');
        } catch (error) { faults.set('compaction', `压缩记录写入失败：${message(error)}`); ctx.logger.error(error); }
      }
      if (session.id !== state.homeSessionId) return;
      // Logged at the result, so the console can show whether each action worked.
      if (event.type === 'tool/call') calls.set(event.data.callId, { sessionId: session.id, name: event.data.name, arguments: event.data.arguments, time: new Date(event.time).toISOString() });
      if (event.type === 'tool/result') {
        const callId = event.data.message.toolCallId; const call = calls.get(callId);
        if (call) { calls.delete(callId); logActivity(callId, call, event.data.message.isError ? 'error' : 'ok'); }
      }
      if (event.type === 'turn/end') {
        // A call that never got a result (cancelled, crashed) is still logged, outcome unknown.
        for (const [callId, call] of calls) if (call.sessionId === session.id) { calls.delete(callId); logActivity(callId, call); }
        if (awaitingFirstTurn === session.id && !stopped) {
          awaitingFirstTurn = undefined;
          // A failure is a fault and the next resolve of this home tries again.
          void title(session.id).then(ok => { if (!ok && state.homeSessionId === session.id) needsTitle = session.id; });
        }
        fallbackAlarm();
      }
    }));
    for (const agent of ctx.agents.list()) safeAttach(agent);
    try {
      const agent = await home(); faults.delete('home');
      // A restart with nothing scheduled and no turn to end would otherwise never wake her again.
      if (agent.status !== 'running') fallbackAlarm();
    } catch (error) { if (!stopped) { faults.set('home', `家打不开：${message(error)}`); ctx.logger.error(error); } }
    arm();
  }
  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) { timers.clear(timer); timer = undefined; }
    for (const dispose of disposers.splice(0).reverse()) dispose();
    for (const list of [...registrations.values(), ...alarmRegistrations.values()]) undo(list);
    registrations.clear(); alarmRegistrations.clear();
  }
  const snapshot = () => ({ homeSessionId: state.homeSessionId, alarm: state.alarm, faults: [...faults.values()] });
  /** Resolves once no alarm delivery is in flight (its durability flush can outlast the turn it starts). */
  const settled = async () => { while (delivery) await delivery; };
  /** Whether this session is her home now; the world prompt gives the home its world line. */
  const isHome = (sessionId: string) => !stopped && sessionId === state.homeSessionId;
  return { start, stop, snapshot, planNext, checkAlarm, cancelAlarm, deliver, settled, home, isHome };
}
export type LifeRuntime = ReturnType<typeof createLifeRuntime>;
