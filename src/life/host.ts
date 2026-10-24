import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';

export interface LifeHost {
  createSession(cwd: string, agentPreset: string): Promise<string>;
  /** The live or resumed Agent, or `undefined` when the session no longer exists; other failures throw. */
  resolveAgent(sessionId: string): Promise<Agent | undefined>;
  isArchived(sessionId: string): boolean;
  setFullAccess(session: Session): void;
  rename(sessionId: string, title: string): Promise<void>;
  origin(): string;
}
interface HostServices {
  sessionController: {
    create(request: { cwd: string; agentPreset: string }): Promise<{ sessionId: string }>;
    resolveAgent(sessionId: string): Promise<{ agent: Agent } | { error: { code: string; message: string } }>;
    rename(request: { sessionId: string; title: string }): Promise<unknown>;
  };
  permissionPresets: { set(session: Session, name: string): void };
  webServer: { getOrigin(): string };
  workspaceRegistry?: { archivedSessionIds: Iterable<string> };
}
export function hostLife(ctx: Context): LifeHost {
  const host = ctx as unknown as HostServices;
  return {
    createSession: async (cwd, agentPreset) => (await host.sessionController.create({ cwd, agentPreset })).sessionId,
    async resolveAgent(sessionId) {
      const found = await host.sessionController.resolveAgent(sessionId);
      if ('agent' in found) return found.agent;
      if (found.error.code === 'session/not-found') return undefined;
      throw new Error(`dsh-world: home ${sessionId} cannot be resolved: ${found.error.message}`);
    },
    // Optional, so read without injecting it: Cordis throws on an un-injected property access.
    isArchived: sessionId => Array.from((ctx.get('workspaceRegistry') as HostServices['workspaceRegistry'])?.archivedSessionIds ?? []).includes(sessionId),
    setFullAccess: session => host.permissionPresets.set(session, 'danger-full-access'),
    rename: async (sessionId, title) => { await host.sessionController.rename({ sessionId, title }); },
    origin: () => host.webServer.getOrigin(),
  };
}
