import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createSystemMessage, createUserMessage, isAgentLoopRequest, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-compaction';
import './hostContract.ts';
import { Faults } from './faults.ts';
import { createHistory, excludePresentMessages, renderHistory } from './history.ts';
import { createPromptSections, type WorldPromptSource } from './promptSection.ts';
import { belongsToWorld, createSourceArchive, inWorld, isCorruptSessionLog } from './sourceArchive.ts';
import type { ArchiveStore } from './store.ts';
import type { WorldConfig } from './types.ts';
import { worldNames } from './worldPrompt.ts';
import { DEFAULT_MEMORY_TURNS } from './worldSwitch.ts';

export type { WorldPromptSource } from './promptSection.ts';
const memorySource = 'dsh-world-history';

/**
 * Per session: whether the memory block must be (re)built at the next step, and where the injected blocks
 * still on the surface sit, so they can be retired.
 */
interface MemoryState { reload: boolean; injected: Map<string, SessionSeq>; position: { turn: number; step: number }; inScope: boolean; restart: boolean; pendingId?: string }

/**
 * The memory line: her conversations are archived as they happen, and every world session gets a memory
 * block of the newest turns at its start and after each successful compaction, never in between, so it stays
 * inside the provider-cached prefix. `home` archives the current home; `workspace` uses host membership. The memory block still
 * goes to every world session in her workspace (`inWorkspace`), independently of the archive scope.
 * `memoryTurns` is read each time a block is built (default 200).
 */
export function createWorldRuntime(ctx: Context, config: WorldConfig, store: ArchiveStore, world?: WorldPromptSource, memoryTurns: () => number = () => DEFAULT_MEMORY_TURNS) {
  if (config.archiveScope === 'workspace' && !world?.archiveSession) throw new Error('Workspace archive requires the host workspace selection');
  const archivedByScope = world?.archiveSession ?? ((sessionId: string) => config.archiveScope !== 'home' || !!world?.isHome(sessionId));
  /** False while some session's workspace was unknown (the host's workspace service was not up yet); `retryCatchUp` reads those later. */
  let undecided = false;
  /** Archiving never fails on unknown membership: the session waits, and what it said is read in order later. */
  const archived = (sessionId: string) => { try { return archivedByScope(sessionId); } catch { undecided = true; return false; } };
  const archive = createSourceArchive(ctx, config, store, archived);
  const history = createHistory(store);
  const names = () => world?.names?.() ?? world?.prompt.names ?? worldNames(config);
  const included = (session: Session) => inWorld(session, config, world?.inWorkspace);
  const faults = new Faults();
  const prompts = world && createPromptSections(config, world, { faults, logger: ctx.logger });
  const memory = new WeakMap<Session, MemoryState>();
  const attaching = new WeakMap<Session, Promise<void>>();
  const disposers: (() => void)[] = [];
  let stopping: Promise<void> | undefined;
  /**
   * Whether the session may carry her world: her preset, or a memory block inherited onto its surface (a delegated
   * child of her session). Everything else is never read from disk or tracked. The check stays in memory.
   */
  const mayCarryWorld = (session: Session) => belongsToWorld(session, config) || memory.has(session) || session.surface.nodes.some(seq => {
    const event = session.eventAt(seq);
    return event?.type === 'user/message' && event.data.source.kind === memorySource;
  });

  /** Locate earlier memory blocks; every runtime start rebuilds from the active scope and real times. */
  async function readMemoryState(session: Session): Promise<MemoryState> {
    const injected = new Map<string, SessionSeq>();
    let position = { turn: 1, step: 1 };
    const surface = new Set(session.surface.nodes);
    const handle = await ctx.sessionPersistence.open(session.id, 'read');
    try {
      for (let offset = 0; ; offset += 128) {
        const { events } = await handle.read(offset, 128);
        if (!events.length) break;
        for (const event of events) {
          if (event.type === 'step/start') position = { turn: event.data.turn, step: event.data.step };
          const block = event.type === 'user/message' && event.data.source.kind === memorySource;
          if (block && surface.has(event.seq)) injected.set(event.data.id, event.seq);
        }
      }
    } finally { await handle.close(); }
    const inScope = included(session);
    return { reload: true, injected, position, inScope, restart: !inScope && belongsToWorld(session, config) };
  }
  /** Empty system nodes retire only our recalled blocks and derive no model message; original logs stay intact. */
  function retireMemory(session: Session, state: MemoryState): void {
    for (const [id, seq] of state.injected) {
      if (session.surface.nodes.includes(seq)) {
        session.append('system/message', { ...state.position, message: createSystemMessage('') }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
        state.restart = true;
      }
      state.injected.delete(id);
    }
    state.reload = true; state.pendingId = undefined;
  }
  async function attach(agent: Agent): Promise<void> {
    const { session } = agent;
    if (memory.has(session) || !mayCarryWorld(session)) return;
    const pending = attaching.get(session);
    if (pending) return pending;
    const job = faults.track(`memory:${session.id}`, `会话 ${session.id} 记忆初始化失败`, async () => {
      if (included(session)) {
        if (archived(session.id)) await store.commitRecords([], store.progress(session.id));
        await archive.schedule(session.id);
      }
      const state = await readMemoryState(session);
      memory.set(session, state);
      if (!included(session)) retireMemory(session, state);
    });
    attaching.set(session, job);
    try { await job; } finally { attaching.delete(session); }
  }
  /** Retires the blocks still on the surface (they must be found, or the session would carry two) and builds a fresh one without the messages already present. */
  async function freshBlock(session: Session, state: MemoryState): Promise<UserMessage | undefined> {
    const messages = session.deriveMessages();
    const turns = await history.loadRecentTurns(config.worldId, memoryTurns(), archivedByScope);
    if (!included(session)) { retireMemory(session, state); return undefined; }
    const present = new Set(messages.map(message => message.id));
    const text = renderHistory(excludePresentMessages(turns, present), config.timeZone, names(), config.archiveScope === 'home');
    const oldBlocks = messages.filter(message => message.source.kind === memorySource);
    for (const [index, message] of oldBlocks.entries()) {
      if (!included(session)) { retireMemory(session, state); return undefined; }
      const seq = state.injected.get(message.id);
      if (seq === undefined || !session.surface.nodes.includes(seq)) throw new Error('dsh-world: cannot locate retained injected context in the host surface');
      const replacement = createUserMessage({ content: [{ type: 'text', text: index === 0 ? text : '' }], source: { kind: memorySource, form: 'recall' } });
      session.append('user/message', replacement, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
      state.injected.delete(message.id);
    }
    if (oldBlocks.length) return undefined;
    return text ? createUserMessage({ content: [{ type: 'text', text }], source: { kind: memorySource, form: 'recall' } }) : undefined;
  }

  /** Reads what the first catch-up had to leave, once the host can say which sessions belong to her. */
  async function retryCatchUp(): Promise<void> {
    if (!undecided) return;
    undecided = false;
    await archive.catchUp();
  }

  /** `fresh`: her world was just started from the console, so what was said while it was stopped is not archived. */
  async function start(options: { fresh?: boolean } = {}): Promise<void> {
    try {
      disposers.push(ctx.on('session/event', (session, event) => {
        const state = memory.get(session);
        if (state && event.type === 'step/start') state.position = { turn: event.data.turn, step: event.data.step };
        const compacted = event.type === 'compaction/end' && event.data.error === undefined;
        if (state && event.type === 'user/message' && event.data.source.kind === memorySource) state.injected.set(event.data.id, event.seq);
        if (state && event.type === 'user/message' && event.data.id === state.pendingId) { state.reload = false; state.pendingId = undefined; }
        if (state && compacted) state.reload = true;
        if (compacted) prompts?.refresh(session);
        if (session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0 || (!config.archiveScope && !belongsToWorld(session, config))) return;
        if (event.type === 'assistant/message' || event.type === 'turn/end' || event.type === 'turn/start' || event.type === 'compaction/end' || (event.type === 'user/message' && event.data.source.kind === 'user')) void archive.schedule(session.id).catch(() => {});
      }));
      disposers.push(ctx.on('agent/created', async ({ agent }) => { prompts?.add(agent); await attach(agent); return undefined; }));
      // Admitted ahead of the step's new input; the host's own admission order (contexts, time-context last) is kept.
      disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        const { agent, step, signal } = payload;
        // An empty first step ends the turn; any later step runs anyway, so adding to it is safe.
        if (decision.kind !== 'enter' || (step === 1 && !decision.messages.length) || signal.aborted || !mayCarryWorld(agent.session)) return decision;
        await attach(agent);
        const state = memory.get(agent.session)!;
        const leave = () => {
          state.restart ||= state.inScope; state.inScope = false;
          retireMemory(agent.session, state);
          const restart = state.restart; state.restart = false;
          return restart ? { ...decision, startsRequestSeries: true as const } : decision;
        };
        if (!included(agent.session)) return leave();
        state.inScope = true;
        await archive.schedule(agent.id); signal.throwIfAborted();
        if (!included(agent.session)) return leave();
        if (!state.reload) return decision;
        let block: UserMessage | undefined;
        await faults.track(`memory:${agent.id}`, `会话 ${agent.id} 记忆刷新失败`, async () => { block = await freshBlock(agent.session, state); });
        if (!included(agent.session)) return leave();
        if (!block) { state.reload = false; return decision; }
        state.pendingId = block.id;
        return { ...decision, messages: [block, ...decision.messages] };
      }));
      disposers.push(ctx.on('llm/stream', async function* (request, next) {
        const agent = isAgentLoopRequest(request) && request.sessionId ? ctx.agents.get(request.sessionId) : undefined;
        const owned = agent && included(agent.session);
        if (agent && !owned && (prompts?.active(agent.session) || request.messages.some(message => message.source?.kind === memorySource))) {
          const state = memory.get(agent.session);
          if (state) { retireMemory(agent.session, state); state.restart = true; }
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'DSH_WORLD_SCOPE_CHANGED', message: 'dsh-world: 会话已离开世界工作区，已阻止携带世界上下文的请求，请重新发送。' } } } satisfies StreamChunk;
          return;
        }
        for await (const chunk of next()) {
          if (owned && chunk.type === 'finish' && chunk.reason.kind === 'error' && chunk.reason.failure.code === 'CONTEXT_WINDOW_EXCEEDED') yield {
            ...chunk, reason: { ...chunk.reason, failure: { ...chunk.reason.failure, message: `dsh-world: 模型总容量不足，完整近期记忆未被裁剪。${chunk.reason.failure.message}` } },
          } satisfies StreamChunk;
          else yield chunk;
        }
      }));
      await archive.catchUp(options.fresh);
      if (options.fresh) for (const agent of ctx.agents.list()) if (belongsToWorld(agent.session, config)) await archive.skip(agent.id);
      for (const agent of ctx.agents.list()) {
        prompts?.add(agent);
        try { await attach(agent); }
        catch (error) {
          if (!isCorruptSessionLog(error)) throw error;
          ctx.logger.warn(`dsh-world: 会话 ${agent.id} 记忆初始化失败，已隔离：`, error);
        }
      }
    } catch (error) { await stop(); throw error; }
  }
  function stop(): Promise<void> {
    return stopping ??= (async () => {
      prompts?.clear();
      for (const dispose of disposers.splice(0).reverse()) dispose();
      await archive.flush();
    })();
  }
  return { start, retryCatchUp, refreshPrompt: (session: Session) => prompts?.refresh(session), flush: archive.flush, stop, faults: () => [...faults.list(), ...archive.faults()] };
}
