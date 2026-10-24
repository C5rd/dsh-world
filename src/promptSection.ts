import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { renderSelf } from './self.ts';
import { belongsToWorld } from './sourceArchive.ts';
import type { WorldConfig } from './types.ts';
import { readTemplate, renderWorldPrompt, type WorldPrompt } from './worldPrompt.ts';

export interface WorldPromptSource { prompt: WorldPrompt; isHome(sessionId: string): boolean }
interface PromptText { template: string; self?: { file: string; text: string } }

/**
 * The world prompt, a section of every world session's system prompt so she sees it on every request. Its
 * template and 我是谁 are read when the session opens and again after each successful compaction (the host
 * assembles the system prompt before pre-step, so the refresh happens on compaction/end), never in between,
 * so the prompt stays in the provider-cached prefix. Whether the session is her home is asked per request.
 */
export function createPromptSections(config: WorldConfig, world: WorldPromptSource, logger: { warn(...args: unknown[]): void }) {
  const texts = new WeakMap<Session, PromptText>();
  const sections = new Map<Agent, () => void>();
  function read(): PromptText {
    const template = readTemplate(world.prompt.file);
    if (template.error) logger.warn(`dsh-world: ${template.error}`);
    return { template: template.text, ...(config.selfFile ? { self: { file: config.selfFile, text: renderSelf(config.selfFile) } } : {}) };
  }
  return {
    add(agent: Agent): void {
      if (sections.has(agent) || !belongsToWorld(agent.session, config)) return;
      const text = read();
      texts.set(agent.session, text);
      sections.set(agent, agent.ctx.systemPrompt.section({ name: 'dsh-world', order: 50, interpolate: false, text: () => renderWorldPrompt(world.prompt, text.template, text.self, world.isHome(agent.id)) }));
    },
    refresh(session: Session): void {
      const text = texts.get(session);
      if (text) Object.assign(text, read());
    },
    clear(): void {
      for (const dispose of sections.values()) { try { dispose(); } catch { /* agent scope already gone */ } }
      sections.clear();
    },
  };
}
