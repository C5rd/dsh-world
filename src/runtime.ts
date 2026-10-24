import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createSystemMessage, createUserMessage, isAgentLoopRequest, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-compaction';
import './hostContract.ts';
import { createHistory, excludePresentMessages, renderHistory } from './history.ts';
import { createPromptSections, type WorldPromptSource } from './promptSection.ts';
import { belongsToWorld, createSourceArchive } from './sourceArchive.ts';
import type { ArchiveStore } from './store.ts';
import type { WorldConfig } from './types.ts';
import { worldNames } from './worldPrompt.ts';

export type { WorldPromptSource } from './promptSection.ts';
const memorySource = 'dsh-world-history';
/** The newest turns the memory block carries. */
const MEMORY_TURNS = 200;

/**
 * Per session: whether the memory block must be (re)built at the next step, and where the injected blocks
 * still on the surface sit, so they can be retired.
 */
interface MemoryState { reload: boolean; injected: Map<string, SessionSeq>; pendingId?: string }

/**
 * The memory line: her conversations are archived as they happen, and every world session gets a memory
 * block of the newest turns at its start and after each successful compaction, never in between, so it stays
 * inside the provider-cached prefix. `archiveScope: 'home'` archives her home alone; the memory block still
 * goes to every world session. With a world prompt source, the world prompt joins every world session.
 */
export function createWorldRuntime(ctx: Context, config: WorldConfig, store: ArchiveStore, world?: WorldPromptSource) {
  const archived = (sessionId: string) => config.archiveScope !== 'home' || !!world?.isHome(sessionId);
  const archive = createSourceArchive(ctx, config, store, archived);
  const history = createHistory(store);
  const names = world?.prompt.names ?? worldNames(config);
  const prompts = world && createPromptSections(config, world, ctx.logger);
  const memory = new WeakMap<Session, MemoryState>();
  const attaching = new WeakMap<Session, Promise<void>>();
  const disposers: (() => void)[] = [];
  let stopping: Promise<void> | undefined;

  /** Reads the session once to learn where earlier memory blocks sit and whether a compaction came after the last one. */
  async function readMemoryState(session: Session): Promise<MemoryState> {
    const injected = new Map<string, SessionSeq>();
    const surface = new Set(session.surface.nodes);
    const handle = await ctx.sessionPersistence.open(session.id, 'read');
    let lastBlock = -1, lastCompaction = -1;
    try {
      for (let offset = 0; ; offset += 128) {
        const { events } = await handle.read(offset, 128);
        if (!events.length) break;
        for (const event of events) {
          const block = event.type === 'user/message' && event.data.source.kind === memorySource;
          if (block && surface.has(event.seq)) injected.set(event.data.id, event.seq);
          if (event.seq < session.inheritedEventCount) continue;
          if (block) lastBlock = event.seq;
          if (event.type === 'compaction/end' && event.data.error === undefined) lastCompaction = event.seq;
        }
      }
    } finally { await handle.close(); }
    return { reload: lastBlock < 0 || lastCompaction > lastBlock, injected };
  }
  async function attach(agent: Agent): Promise<void> {
    const { session } = agent;
    if (!belongsToWorld(session, config) || memory.has(session)) return;
    const pending = attaching.get(session);
    if (pending) return pending;
    const job = (async () => {
      if (archived(session.id)) await store.commitRecords([], store.progress(session.id));
      await archive.schedule(session.id);
      memory.set(session, await readMemoryState(session));
    })();
    attaching.set(session, job);
    try { await job; } finally { attaching.delete(session); }
  }
  /** Retires the blocks still on the surface (they must be found, or the session would carry two) and builds a fresh one without the messages already present. */
  async function freshBlock(session: Session, state: MemoryState, turn: number, step: number): Promise<UserMessage | undefined> {
    const messages = session.deriveMessages();
    const turns = await history.loadRecentTurns(config.worldId, MEMORY_TURNS);
    const present = new Set(messages.filter(message => message.role === 'assistant' || message.source.kind === 'user').map(message => message.id));
    for (const message of messages.filter(message => message.source.kind === memorySource)) {
      const seq = state.injected.get(message.id);
      if (seq === undefined || !session.surface.nodes.includes(seq)) throw new Error('dsh-world: cannot locate retained injected context in the host surface');
      session.append('system/message', { turn, step, message: createSystemMessage('') }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
      state.injected.delete(message.id);
    }
    const text = renderHistory(excludePresentMessages(turns, present), config.timeZone, names);
    return text ? createUserMessage({ content: [{ type: 'text', text }], source: { kind: memorySource, form: 'recall' } }) : undefined;
  }

  async function start(): Promise<void> {
    try {
      disposers.push(ctx.on('session/event', (session, event) => {
        if (!belongsToWorld(session, config)) return;
        const state = memory.get(session);
        const compacted = event.type === 'compaction/end' && event.data.error === undefined;
        if (state && event.type === 'user/message' && event.data.source.kind === memorySource) state.injected.set(event.data.id, event.seq);
        if (state && event.type === 'user/message' && event.data.id === state.pendingId) { state.reload = false; state.pendingId = undefined; }
        if (state && compacted) state.reload = true;
        if (compacted) prompts?.refresh(session);
        if (event.type === 'assistant/message' || event.type === 'turn/end' || event.type === 'turn/start' || event.type === 'compaction/end' || (event.type === 'user/message' && event.data.source.kind === 'user')) void archive.schedule(session.id).catch(() => {});
      }));
      disposers.push(ctx.on('agent/created', async ({ agent }) => { prompts?.add(agent); await attach(agent); return undefined; }));
      // Admitted ahead of the step's new input; the host's own admission order (contexts, time-context last) is kept.
      disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        const { agent, turn, step, signal } = payload;
        // An empty first step ends the turn; any later step runs anyway, so adding to it is safe.
        if (decision.kind !== 'enter' || (step === 1 && !decision.messages.length) || signal.aborted || !belongsToWorld(agent.session, config)) return decision;
        await attach(agent); await archive.schedule(agent.id); signal.throwIfAborted();
        const state = memory.get(agent.session)!;
        if (!state.reload) return decision;
        const block = await freshBlock(agent.session, state, turn, step);
        if (!block) { state.reload = false; return decision; }
        state.pendingId = block.id;
        return { ...decision, messages: [block, ...decision.messages] };
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
      await archive.catchUp();
      for (const agent of ctx.agents.list()) { prompts?.add(agent); await attach(agent); }
    } catch (error) { await stop(); throw error; }
  }
  function stop(): Promise<void> {
    return stopping ??= (async () => {
      prompts?.clear();
      for (const dispose of disposers.splice(0).reverse()) dispose();
      try { await archive.flush(); } finally { store.close(); }
    })();
  }
  return { start, flush: archive.flush, stop };
}
