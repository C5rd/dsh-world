import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

/**
 * Her world reaches only the sessions of her room's workspace (plus her persona, which follows the preset). A
 * session can join or leave the workspace at any time, so every way in checks again where it matters: before an
 * injection, after every wait, and when a tool runs.
 */
export type InWorld = (session: Session) => boolean;

export class OutsideWorldError extends Error {
  constructor() { super('会话不在世界工作区内'); this.name = 'OutsideWorldError'; }
}

/** The agent, if it is (still) in her world; without a predicate every agent is. */
export function admit(inWorld: InWorld | undefined, agent: Agent): Agent {
  if (inWorld && !inWorld(agent.session)) throw new OutsideWorldError();
  return agent;
}

/** The tool, refusing to run once its agent has left her world; `left` lets the owner take it away. */
export function scopedTool(tool: ToolDefinition, inside: () => boolean, left?: () => void): ToolDefinition {
  return { ...tool, execute: (args, exec) => {
    if (!inside()) { left?.(); throw new OutsideWorldError(); }
    return tool.execute(args, exec);
  } };
}

/**
 * Membership can change after `agent/created`, so whatever a session's world providers depend on is synced as its
 * system prompt is assembled; when `sync` changed something, the prompt is assembled again to include it.
 */
export function reassembleOnChange(ctx: Context, sync: (agent: Agent) => boolean): () => void {
  return ctx.on('system-prompt/assemble', (_assembly, context, next) => context.agent && sync(context.agent) ? context.agent.ctx.systemPrompt.assemble(context) : next());
}
