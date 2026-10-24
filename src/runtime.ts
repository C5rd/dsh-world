import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createSystemMessage, createUserMessage, isAgentLoopRequest, type Message, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-compaction';
import type {} from '@deepseek-ai/dsh-system-prompt';
import './hostContract.ts';
import { createHistory, excludePresentMessages, renderHistory } from './history.ts';
import { renderSelf } from './self.ts';
import { belongsToWorld, createSourceArchive } from './sourceArchive.ts';
import type { ArchiveStore } from './store.ts';
import type { WorldConfig } from './types.ts';
import { readTemplate, renderWorldPrompt, worldNames, type WorldPrompt } from './worldPrompt.ts';

const memorySource = 'dsh-world-history';
/** Before 0.3.6 her self-description came as its own message; old ones are retired with the memory block. */
const selfSource = 'dsh-world-self';
const injectedKinds = new Set<string>([memorySource, selfSource]);
interface SessionState { reloadHistory: boolean; contextSeqs: Map<string, SessionSeq>; pendingHistoryId?: string }
export interface WorldPromptSource { prompt: WorldPrompt; isHome(sessionId: string): boolean }
interface PromptEntry { template: string; self?: string }
export function createWorldRuntime(ctx: Context, config: WorldConfig, store: ArchiveStore, world?: WorldPromptSource) {
  const archive = createSourceArchive(ctx, config, store);
  const history = createHistory(store);
  const states = new WeakMap<Session, SessionState>();
  const attaching = new WeakMap<Session, Promise<void>>();
  const disposers: (() => void)[] = [];
  const dirty = new Set<string>();
  const jobs = new Map<string, Promise<void>>();
  const faults = new Map<string, unknown>();
  const prompts = new WeakMap<Session, PromptEntry>();
  const sections = new Map<Agent, () => void>();
  let tail = Promise.resolve();
  let started = false;
  let stopping: Promise<void> | undefined;

  function schedule(sessionId: string): Promise<void> {
    dirty.add(sessionId);
    const pending = jobs.get(sessionId);
    if (pending) return pending;
    const job = tail.then(async () => {
      while (dirty.delete(sessionId)) await archive.replay(sessionId);
      faults.delete(sessionId);
    });
    jobs.set(sessionId, job);
    tail = job.catch(error => { faults.set(sessionId, error); ctx.logger.error(error); }).finally(() => { jobs.delete(sessionId); });
    return job;
  }
  const names = world?.prompt.names ?? worldNames(config);
  /** Her template and 我是谁, read together at session start and after each successful compaction. */
  function refresh(entry: PromptEntry): void {
    const template = readTemplate(world?.prompt.file);
    if (template.error) ctx.logger.warn(`dsh-world: ${template.error}`);
    entry.template = template.text;
    entry.self = config.selfFile ? renderSelf(config.selfFile, names.partner) : undefined;
  }
  /**
   * The world prompt sits in the system prompt so she sees it on every request. Its 我是谁 part is read when
   * the session opens and again after each successful compaction (the host assembles the system prompt
   * before pre-step, so the refresh happens on compaction/end), never in between, so the prompt stays cached.
   */
  function addPrompt(agent: Agent): void {
    if (!world || sections.has(agent) || !belongsToWorld(agent.session, config)) return;
    const entry: PromptEntry = { template: '' }; refresh(entry);
    prompts.set(agent.session, entry);
    sections.set(agent, agent.ctx.systemPrompt.section({ name: 'dsh-world', order: 50, interpolate: false, text: () => renderWorldPrompt(world.prompt, entry.template, entry.self, world.isHome(agent.id)) }));
  }
  async function attach(agent: Agent): Promise<void> {
    const { session } = agent;
    if (!belongsToWorld(session, config) || states.has(session)) return;
    const pending = attaching.get(session);
    if (pending) return pending;
    const job = (async () => {
      await store.commitRecords([], store.progress(session.id));
      await schedule(session.id);
      const contextSeqs = new Map<string, SessionSeq>();
      const state: SessionState = { reloadHistory: true, contextSeqs };
      const nodes = new Set(session.surface.nodes);
      const handle = await ctx.sessionPersistence.open(session.id, 'read');
      let historySeq = -1;
      let compactionSeq = -1;
      try {
        for (let offset = 0; ; offset += 128) {
          const { events } = await handle.read(offset, 128);
          if (!events.length) break;
          for (const event of events) {
            if (nodes.has(event.seq) && event.type === 'user/message' && injectedKinds.has(event.data.source.kind)) contextSeqs.set(event.data.id, event.seq);
            if (event.seq < session.inheritedEventCount) continue;
            if (event.type === 'user/message' && injectedKinds.has(event.data.source.kind)) historySeq = event.seq;
            if (event.type === 'compaction/end' && event.data.error === undefined) compactionSeq = event.seq;
          }
        }
      } finally { await handle.close(); }
      state.reloadHistory = historySeq < 0 || compactionSeq > historySeq;
      states.set(session, state);
    })();
    attaching.set(session, job);
    try { await job; } finally { attaching.delete(session); }
  }
  function removeContext(session: Session, messages: readonly Message[], state: SessionState, turn: number, step: number): void {
    for (const message of messages) {
      const seq = state.contextSeqs.get(message.id);
      if (seq === undefined || !session.surface.nodes.includes(seq)) throw new Error('dsh-world: cannot locate retained injected context in the host surface');
      session.append('system/message', { turn, step, message: createSystemMessage('') }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
      state.contextSeqs.delete(message.id);
    }
  }
  /** Retire the previously injected context and build a fresh one: the newest 200 turns excluding messages already on the surface. */
  async function freshContext(session: Session, state: SessionState, turn: number, step: number): Promise<UserMessage[]> {
    const messages = session.deriveMessages();
    const turns = await history.loadRecentTurns(config.worldId, 200);
    const presentIds = new Set(messages.filter(message => message.role === 'assistant' || message.source.kind === 'user').map(message => message.id));
    const historyText = renderHistory(excludePresentMessages(turns, presentIds), config.timeZone, names);
    removeContext(session, messages.filter(message => injectedKinds.has(message.source.kind)), state, turn, step);
    const text = (body: string) => [{ type: 'text' as const, text: body }];
    return historyText ? [createUserMessage({ content: text(historyText), source: { kind: memorySource, form: 'recall' } })] : [];
  }
  async function flush(): Promise<void> {
    let current: Promise<void>;
    do { current = tail; await current; } while (current !== tail);
    if (faults.size) throw new AggregateError([...faults.values()], 'dsh-world: source archive has unresolved failures');
  }
  async function stop(): Promise<void> {
    return stopping ??= (async () => {
      for (const dispose of sections.values()) { try { dispose(); } catch { /* agent scope already gone */ } }
      sections.clear();
      for (const dispose of disposers.splice(0).reverse()) dispose(); try { await flush(); } finally { store.close(); } })();
  }
  async function start(): Promise<void> {
    if (started) throw new Error('dsh-world: runtime already started');
    started = true;
    try {
      disposers.push(ctx.on('session/event', (session, event) => {
        if (!belongsToWorld(session, config)) return;
        const state = states.get(session);
        if (state && event.type === 'user/message' && injectedKinds.has(event.data.source.kind)) state.contextSeqs.set(event.data.id, event.seq);
        if (state && event.type === 'user/message' && event.data.id === state.pendingHistoryId) { state.reloadHistory = false; state.pendingHistoryId = undefined; }
        if (state && event.type === 'compaction/end' && event.data.error === undefined) state.reloadHistory = true;
        if (event.type === 'compaction/end' && event.data.error === undefined) { const entry = prompts.get(session); if (entry) refresh(entry); }
        if (event.type === 'assistant/message' || event.type === 'turn/end' || event.type === 'turn/start' || event.type === 'compaction/end' || (event.type === 'user/message' && event.data.source.kind === 'user')) void schedule(session.id).catch(() => {});
      }));
      disposers.push(ctx.on('agent/created', async ({ agent }) => { addPrompt(agent); await attach(agent); return undefined; }));
      // The memory block is admitted at session start and after each successful
      // compaction, ahead of the step's new input; the host's own admission order (contexts, time-context
      // last) is kept. They are never rewritten in between, so they stay inside the provider-cached prefix.
      disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        const { agent, turn, step, signal } = payload;
        // An empty first step ends the turn; any later step runs anyway, so adding to it is safe.
        if (decision.kind !== 'enter' || (step === 1 && !decision.messages.length) || signal.aborted || !belongsToWorld(agent.session, config)) return decision;
        try {
          await attach(agent); await schedule(agent.id); signal.throwIfAborted();
          const state = states.get(agent.session)!;
          if (!state.reloadHistory) return decision;
          const injected = await freshContext(agent.session, state, turn, step);
          if (!injected.length) { state.reloadHistory = false; return decision; }
          state.pendingHistoryId = injected[0]!.id;
          return { ...decision, messages: [...injected, ...decision.messages] };
        } catch (error) { ctx.logger.error(error); throw error; }
      }));
      disposers.push(ctx.on('llm/stream', async function* (request, next) {
        const agent = isAgentLoopRequest(request) && request.sessionId ? ctx.agents.get(request.sessionId) : undefined;
        const owned = agent && belongsToWorld(agent.session, config);
        for await (const chunk of next()) {
          if (owned && chunk.type === 'finish' && chunk.reason.kind === 'error' && chunk.reason.failure.code === 'CONTEXT_WINDOW_EXCEEDED') yield {
            ...chunk, reason: { ...chunk.reason, failure: { ...chunk.reason.failure, message: `dsh-world: 模型总容量不足，完整近期记忆未被裁剪。${chunk.reason.failure.message}` } },
          } satisfies StreamChunk;
          else yield chunk;
        }
      }));
      let after = '';
      while (true) {
        const ids = store.sourcePage(after);
        if (!ids.length) break;
        for (const id of ids) { await schedule(id); after = id; }
      }
      for (const agent of ctx.agents.list()) { addPrompt(agent); await attach(agent); }
    } catch (error) { await stop(); throw error; }
  }
  return { start, flush, stop };
}
