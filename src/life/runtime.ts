import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-loop';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-system-prompt';
import '../hostContract.ts';
import { errorText, Faults } from '../faults.ts';
import { belongsToWorld } from '../sourceArchive.ts';
import type { WorldConfig } from '../types.ts';
import { homeTitle, worldNames } from '../worldPrompt.ts';
import { cancelReply, checkReply, earlyStopText, nextLocalTime, planReply, resolveAlarmTime, wakeText } from './alarm.ts';
import { createAlarmTimer, realTimers, type LifeTimers } from './alarmTimer.ts';
import { createEarlyStopWatch } from './earlyStop.ts';
import { createHome } from './home.ts';
import type { LifeHost } from './host.ts';
import { createJournal } from './journal.ts';
import type { LifeStore } from './lifeStore.ts';
import { exampleTime, readAlarmMessages } from './messages.ts';
import type { Notifier } from './notify.ts';
import { createToolRegistry } from './toolRegistry.ts';
import { alarmDescriptions, lifeTools } from './tools.ts';
import type { Alarm, LifeOptions } from './types.ts';

export interface LifeDeps { ctx: Context; config: WorldConfig; options: LifeOptions; store: LifeStore; host: LifeHost; notifier: Notifier; clock?: () => Date; timers?: LifeTimers }

/**
 * Her life line: one pending alarm, kept in life.json and delivered into her home with `agent.steer`, the
 * tools she sets it with, and the home itself. The parts live in their own modules; this wires them.
 */
export function createLifeRuntime(deps: LifeDeps) {
  const { ctx, config, options, store, host } = deps;
  const { timeZone } = options;
  const names = worldNames(config);
  const clock = deps.clock ?? (() => new Date());
  const faults = new Faults();
  const disposers: (() => void)[] = [];
  const state = store.read();
  let stopped = false;
  let delivery: Promise<void> | undefined;

  /** Bookkeeping after the fact: a failure is a fault, never a broken turn. */
  function record(work: () => void): void {
    try { work(); faults.clear('state'); }
    catch (error) { faults.set('state', `生活状态没能保存：${errorText(error)}`); ctx.logger.error(error); }
  }
  /** Her alarm wording, read when it is used; an unreadable template is a fault and the shipped one is used. */
  function alarmMessages() {
    const messages = readAlarmMessages(options.alarmFile);
    if (messages.error) faults.set('alarm-template', messages.error); else faults.clear('alarm-template');
    return messages;
  }
  const templateValues = () => ({ name: names.companion, partner: names.partner, homeTitle: homeTitle(names), timeZone, fallbackWakeTime: options.fallbackWakeTime, example: exampleTime(timeZone) });
  const say = (agent: Agent, text: string) => {
    agent.steer(createUserMessage({ source: { kind: 'dsh-world-life' }, content: [{ type: 'text', text }] }));
    return ctx.sessions.flush(agent.session);
  };

  // Her alarm.
  const timer = createAlarmTimer({ clock, timers: deps.timers ?? realTimers, dueAlarm: () => state.alarm?.at, fire: () => void deliver() });
  const morning = (now: Date): Alarm => ({ at: nextLocalTime(now, options.fallbackWakeTime, timeZone).toISOString(), note: '', setAt: now.toISOString(), source: 'fallback' });
  /** A new alarm replaces a failing one, so its backoff and fault go with it. Saved or not, it is armed. */
  function setAlarm(alarm: Alarm): void {
    if (stopped) return;
    state.alarm = alarm; faults.clear('delivery', 'alarm');
    try { store.write(state); }
    catch (error) { faults.set('alarm', `闹钟没能保存：${errorText(error)}`); throw error; }
    finally { timer.reset(); }
  }
  /** Nothing pending means resting until the next morning. Unsaved, it still rings while the app keeps running. */
  function fallbackAlarm(): void {
    if (state.alarm || stopped) return;
    try { setAlarm(morning(clock())); }
    catch (error) { faults.set('alarm', `断线保护闹钟没能保存：${errorText(error)}`); ctx.logger.error(error); }
  }
  function planNext(input: { at?: string; after_minutes?: number }, note: string): string {
    if (stopped) throw new Error('生活线已停止');
    const now = clock();
    const at = resolveAlarmTime(input, now, timeZone);
    const replaced = state.alarm;
    setAlarm({ at: at.toISOString(), note: note.trim(), setAt: now.toISOString(), source: 'plan' });
    return planReply(at, replaced, timeZone);
  }
  const checkAlarm = () => checkReply(state.alarm, clock(), timeZone);
  /** Back to the morning fallback, exactly as if she had set nothing. */
  function cancelAlarm(): string {
    if (stopped) throw new Error('生活线已停止');
    const cancelled = state.alarm;
    if (cancelled?.source === 'plan') setAlarm(morning(clock())); else fallbackAlarm();
    return cancelReply(cancelled, state.alarm, timeZone);
  }

  // Delivery: one at a time; a failure backs off, and a newer alarm keeps its own time.
  function deliver(): Promise<void> {
    if (stopped || !state.alarm) return delivery ?? Promise.resolve();
    return delivery ??= send(state.alarm).finally(() => { delivery = undefined; });
  }
  async function send(alarm: Alarm): Promise<void> {
    let now = clock();
    try {
      // Resolve (or rebuild) the home first: a rebuilt home must still see this alarm as pending.
      const agent = await home.open();
      if (stopped) return;
      if (state.alarm !== alarm) { timer.arm(); return; }
      // Cleared before steering, so a turn that ends quickly already sees "no alarm" and gets the fallback.
      delete state.alarm;
      now = clock();
      await say(agent, wakeText(alarm, now, timeZone, options.fallbackWakeTime, alarmMessages(), templateValues()));
    } catch (error) {
      ctx.logger.error(error);
      if (stopped) return;
      if (state.alarm && state.alarm !== alarm) { faults.set('delivery', `闹钟送达失败：${errorText(error)}`); timer.arm(); return; }
      state.alarm = alarm;
      faults.set('delivery', `闹钟送达失败，${timer.failed()} 分钟后重试：${errorText(error)}`);
      return;
    }
    if (stopped) return;
    // Steered and durable: the alarm is delivered. Recording it may fail, but it is never sent again.
    faults.clear('delivery', 'home');
    record(() => {
      store.write(state);
      store.appendWake({ scheduledAt: alarm.at, deliveredAt: now.toISOString(), source: alarm.source, lateMs: Math.max(0, now.getTime() - Date.parse(alarm.at)) });
    });
    timer.reset();
  }

  // Stopping early: asked once per alarm whether she is done.
  const earlyStop = createEarlyStopWatch();
  function askIfDoneEarly(completed: boolean): void {
    const now = clock(); const alarm = state.alarm;
    if (!earlyStop.turnEnded(completed, alarm, now) || stopped) return;
    alarm.nudged = true;
    record(() => store.write(state));
    earlyStop.asking();
    const text = earlyStopText(alarm, now, timeZone, alarmMessages(), templateValues());
    void home.open().then(agent => stopped ? undefined : say(agent, text)).catch(error => { earlyStop.notAsked(); ctx.logger.error(error); });
  }

  // Her tools and her home.
  const notifier: Notifier = {
    ...(deps.notifier.toast ? { toast: (title: string, body: string) => faults.track('toast', '系统通知没送到', () => deps.notifier.toast!(title, body)) } : {}),
    outlets: deps.notifier.outlets.map(outlet => ({ ...outlet, send: push => faults.track(`outlet:${outlet.name}`, `${outlet.name}没送到`, () => outlet.send(push)) })),
  };
  const tools = createToolRegistry({
    faults, logger: ctx.logger,
    isHome: agent => agent.id === state.homeSessionId,
    tools: () => lifeTools({ planNext, checkAlarm, cancelAlarm, notifier, names, origin: () => { try { return host.origin(); } catch { return undefined; } }, descriptions: alarmDescriptions(alarmMessages(), templateValues()) }),
  });
  const attach = (agent: Agent) => { if (!stopped && belongsToWorld(agent.session, config)) tools.attach(agent); };
  const home = createHome({
    host, roomDir: options.roomDir, agentPreset: config.agentPreset, title: homeTitle(names), faults, logger: ctx.logger,
    current: () => state.homeSessionId,
    moveIn(sessionId) {
      state.homeSessionId = sessionId;
      // A new home with nothing pending starts with a first wake.
      state.alarm ??= { at: clock().toISOString(), note: '', setAt: clock().toISOString(), source: 'first' };
      tools.releaseOldHomes();
      store.write(state);
    },
    opened: attach,
    stopped: () => stopped,
  });
  const journal = createJournal({ store, faults, roomDir: options.roomDir, logger: ctx.logger });

  async function start(): Promise<void> {
    disposers.push(
      ctx.on('agent/created', ({ agent }) => { attach(agent); return undefined; }),
      ctx.on('agent/disposed', ({ agent }) => tools.forget(agent)),
      ctx.on('agent/inbox/inserted', ({ agent, message: inserted }) => {
        // Her partner's words reach her at the next step, like being called while busy.
        if (agent.id !== state.homeSessionId || inserted.source.kind !== 'user' || agent.status !== 'running') return;
        if (!agent.inbox.nextTurn.some(queued => queued.id === inserted.id)) return;
        agent.inbox.remove(inserted.id); agent.steer(inserted);
      }),
      ctx.on('session/event', (session, event) => {
        if (!belongsToWorld(session, config)) return;
        journal.world(session, event);
        if (session.id !== state.homeSessionId) return;
        journal.home(session, event);
        if (event.type === 'user/message' && event.data.source.kind === 'user') earlyStop.partnerSpoke();
        if (event.type !== 'turn/end') return;
        home.turnEnded(session.id);
        fallbackAlarm();
        // A stopped or failed turn is not her deciding she is done.
        askIfDoneEarly(event.data.reason.kind === 'completed');
      }),
    );
    for (const agent of ctx.agents.list()) attach(agent);
    try {
      const agent = await home.open(); faults.clear('home');
      // A restart with nothing scheduled and no turn to end would otherwise never wake her again.
      if (agent.status !== 'running') fallbackAlarm();
    } catch (error) { if (!stopped) { faults.set('home', `家打不开：${errorText(error)}`); ctx.logger.error(error); } }
    timer.arm();
  }
  function stop(): void {
    if (stopped) return;
    stopped = true;
    timer.stop();
    for (const dispose of disposers.splice(0).reverse()) dispose();
    tools.clear();
  }
  return {
    start, stop, planNext, checkAlarm, cancelAlarm, deliver,
    snapshot: () => ({ homeSessionId: state.homeSessionId, alarm: state.alarm, faults: faults.list() }),
    /** Resolves once no alarm delivery is in flight (its durability flush can outlast the turn it starts). */
    settled: async () => { while (delivery) await delivery; },
    home: () => home.open(),
    /** Whether this session is her home now; the world prompt gives the home its world line. */
    isHome: (sessionId: string) => !stopped && sessionId === state.homeSessionId,
  };
}
export type LifeRuntime = ReturnType<typeof createLifeRuntime>;
