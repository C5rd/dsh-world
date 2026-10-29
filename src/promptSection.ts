import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { errorText, type Faults } from './faults.ts';
import { readPersona, renderPersona } from './persona.ts';
import { renderSelf } from './self.ts';
import { belongsToWorld, inWorld } from './sourceArchive.ts';
import type { WorldConfig } from './types.ts';
import { readTemplate, renderWorldPrompt, type WorldNames, type WorldPrompt } from './worldPrompt.ts';
import { reassembleOnChange } from './worldScope.ts';

export interface WorldPromptSource {
  prompt: WorldPrompt; isHome(sessionId: string): boolean; archiveSession?(sessionId: string): boolean;
  /** Resolved with the saved prompt text, so renaming does not change an existing cached prefix. */
  names?(): WorldNames;
  /** Her room's workspace; her world (all but the persona) reaches only its sessions. Absent, every session of hers. */
  inWorkspace?(sessionId: string): boolean;
}
interface PromptText { template: string; self?: { file: string; text: string }; persona: string; names: WorldNames }
/** `active`: the world prompt is placed (the session is in her workspace); the persona is placed either way. */
interface Entry { text: PromptText; active: boolean; dispose: () => void; persona?: () => void }
/** The host's persona section; a preset may also register it for its own agents. */
const HOST_PERSONA = 'deployment:persona-prefix';

/**
 * Her persona follows the configured preset; the world prompt is limited to the world's workspace.
 * Both are sections of the session's system prompt so she sees them on every
 * request. They are read when the session opens and again after each successful compaction (the host assembles
 * the system prompt before pre-step, so the refresh happens on compaction/end) or explicit console application, so the prompt
 * stays in the provider-cached prefix. Whether the session is her home is asked per request.
 *
 * Her persona takes the place of the host's: registered under the host persona's name for her agent, it shadows
 * the deployment default. Where her preset already gave her agent a persona, that name is taken, so hers follows
 * it under its own name and the console says so.
 */
export function createPromptSections(config: WorldConfig, world: WorldPromptSource, deps: { faults: Faults; logger: { warn(...args: unknown[]): void } }) {
  const entries = new Map<Agent, Entry>();
  const agents = new WeakMap<Session, Agent>();
  function read(includeWorld: boolean): PromptText {
    const persona = world.prompt.persona ? renderPersona(readPersona(world.prompt.persona)) : '';
    const names = world.names?.() ?? world.prompt.names;
    if (!includeWorld) return { template: '', persona, names };
    const template = readTemplate(world.prompt.file);
    if (template.error) deps.logger.warn(`dsh-world: ${template.error}`);
    return {
      template: template.text,
      ...(config.selfFile ? { self: { file: config.selfFile, text: renderSelf(config.selfFile) } } : {}),
      persona, names,
    };
  }
  /** Registers her persona when she has one and drops it when she has none. */
  function placePersona(agent: Agent, entry: Entry): void {
    if (!entry.text.persona) { entry.persona?.(); delete entry.persona; return; }
    if (entry.persona) return;
    const prompt = agent.ctx.systemPrompt;
    const order = prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') ?? 0;
    const text = () => entry.text.persona;
    try { entry.persona = prompt.section({ name: HOST_PERSONA, order, interpolate: false, text }); deps.faults.clear('persona'); }
    catch (error) {
      entry.persona = prompt.section({ name: 'dsh-world-persona', order: order + 1, interpolate: false, text });
      deps.faults.set('persona', `她的预设自带人设，你写的人设排在它后面（${errorText(error)}）`);
    }
  }
  return {
    add(agent: Agent): void {
      if (entries.has(agent) || !belongsToWorld(agent.session, config)) return;
      let disposeWorld: (() => void) | undefined;
      /** Places or removes the world prompt as the session enters or leaves her workspace; true when it did. */
      const sync = (): boolean => {
        if (inWorld(agent.session, config, world.inWorkspace) === entry.active) return false;
        entry.active = !entry.active;
        if (!entry.active) { disposeWorld?.(); disposeWorld = undefined; return true; }
        entry.text = read(true);
        disposeWorld = agent.ctx.systemPrompt.section({ name: 'dsh-world', order: 50, interpolate: false, text: () => renderWorldPrompt({ ...world.prompt, names: entry.text.names }, entry.text.template, entry.text.self, world.isHome(agent.id)) });
        placePersona(agent, entry);
        return true;
      };
      const disposeSync = reassembleOnChange(agent.ctx, sync);
      const entry: Entry = { text: read(false), active: false, dispose: () => { disposeSync(); disposeWorld?.(); } };
      entries.set(agent, entry); agents.set(agent.session, agent);
      sync();
      placePersona(agent, entry);
    },
    active(session: Session): boolean {
      const agent = agents.get(session);
      return !!(agent && entries.get(agent)?.active);
    },
    refresh(session: Session): void {
      const agent = agents.get(session); const entry = agent && entries.get(agent);
      if (!agent || !entry) return;
      entry.text = read(entry.active);
      placePersona(agent, entry);
    },
    clear(): void {
      for (const entry of entries.values()) for (const dispose of [entry.dispose, entry.persona]) { try { dispose?.(); } catch { /* agent scope already gone */ } }
      entries.clear();
    },
  };
}
