import { mkdirSync } from 'node:fs';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { errorText, type Faults } from '../faults.ts';
import type { LifeHost } from './host.ts';

export interface HomeDeps {
  host: LifeHost;
  roomDir: string;
  agentPreset: string;
  title: string;
  faults: Faults;
  logger: { error(...args: unknown[]): void };
  /** The recorded home, if any. */
  current(): string | undefined;
  /** Records a newly built home before anything else can fail, so a retry reuses it instead of building another. */
  moveIn(sessionId: string): void;
  /** Called with the home every time it is opened. */
  opened(agent: Agent): void;
  stopped(): boolean;
}

/**
 * Her home session: the recorded one while it exists and is not archived, otherwise a new one. Full access is
 * granted on every open (selecting the preset in effect is a no-op), so no "still needs access" state has to
 * survive a restart. The title is applied when the home is built and again after its first turn, because the
 * host retitles a session from its first prompt.
 */
export function createHome(deps: HomeDeps) {
  const { host, faults } = deps;
  let opening: Promise<Agent> | undefined;
  /** A new home whose title is not applied yet; retried on the next open. */
  let untitled: string | undefined;
  /** A new home before its first turn ends. */
  let firstTurn: string | undefined;

  async function rename(sessionId: string): Promise<boolean> {
    try { await host.rename(sessionId, deps.title); faults.clear('rename'); return true; }
    catch (error) { faults.set('rename', `家改名失败：${errorText(error)}`); deps.logger.error(error); return false; }
  }
  async function ready(agent: Agent): Promise<Agent> {
    host.setFullAccess(agent.session);
    if (untitled === agent.id && await rename(agent.id) && untitled === agent.id) untitled = undefined;
    deps.opened(agent);
    return agent;
  }
  async function build(): Promise<Agent> {
    const current = deps.current();
    if (current && !host.isArchived(current)) {
      const agent = await host.resolveAgent(current);
      if (agent) return ready(agent);
    }
    mkdirSync(deps.roomDir, { recursive: true });
    const sessionId = await host.createSession(deps.roomDir, deps.agentPreset);
    if (deps.stopped()) throw new Error('生活线已停止');
    untitled = sessionId; firstTurn = sessionId;
    deps.moveIn(sessionId);
    const agent = await host.resolveAgent(sessionId);
    if (!agent) throw new Error(`dsh-world: the new home ${sessionId} cannot be resolved`);
    return ready(agent);
  }
  return {
    /** The current home, resolving or rebuilding it; one attempt at a time. */
    open(): Promise<Agent> { return opening ??= build().finally(() => { opening = undefined; }); },
    turnEnded(sessionId: string): void {
      if (firstTurn !== sessionId || deps.stopped()) return;
      firstTurn = undefined;
      void rename(sessionId).then(ok => { if (!ok && deps.current() === sessionId) untitled = sessionId; });
    },
  };
}
