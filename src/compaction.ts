import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type {} from '@deepseek-ai/dsh-agent-loop';
import { CompactionEngine, ManualCompactionError, isCompactCheckpointSource, type CompactionAgentContext, type CompactionResult, type CompactionTrigger, type ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import { BlockAssembler, CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, contentHasImage, createUserMessage, type ContentBlock, type Message } from '@deepseek-ai/dsh-llm';
import { appendPluginRecord, type Session, type SessionSeq } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-token-meter';
import { visibleText } from './archive.ts';
import { assertNoActiveCompaction, compactSurfaceRegion, selectWholeRange, type RegionAgent, type RegionDependencies, type SummaryResult } from './compactionRegion.ts';
import { formatTimeContext } from './timeContext.ts';
import './hostContract.ts';

const summaryInstruction = [
  '现在暂停对话，改为执行上下文压缩：把上面这段会话中双方的交流整理成一段精炼的中文摘要，供你之后接着对话使用。',
  '保留用户的意图、情绪与关系进展、明确要求、重要事实、已作决定、未完成事项和最近进展；最后一条用户发言尽量按原意完整保留。以“以下是此前交流的摘要”开头的消息是更早的摘要，请与新内容合并为同一段。',
  '以【你的时间】开头的消息是你自己定的闹钟和留给自己的话，不是用户说的话；把它们当作你自己的安排来记，不要算作用户发言。',
  '开头写着“最近的聊天记忆”的记忆资料、系统提示里的世界提示词（含「我是谁」）和“Time sampled”开头的时间块会在压缩后重新提供，不要写进摘要。工具调用过程已从会话中删除，不要提及工具。',
  '保留准确的姓名、日期、数字和标识，分清每件事是谁说的、谁做的。不要标题、列表或分段，不要开头语，不要补写原文没有的事实，不要调用任何工具，直接输出摘要正文。',
].join('\n');
// The model tends to echo the checkpoint lead it saw on earlier summaries; the frame adds it once.
const leadEcho = /^以下是此前交流的摘要[^：:]{0,40}[：:]\s*/;
const checkpointLead ='以下是此前交流的摘要，工具调用过程已省略；请把它当作已知背景，直接接着当前对话继续：';
// Re-injected after every successful compaction by the memory runtime; replayed only as cacheable prefix.
const injectedSources = new Set(['time-context', 'dsh-world-history', 'dsh-world-self']);
const policyKeys = ['thresholdRatio', 'headroomTokens', 'summarizationProvider', 'summarizationModel', 'maxTokens', 'maxOverflowRetries'] as const;

interface SummaryAudit { policyVersion: 2; provider: string; model: string; maxTokens: number; instruction: string; timeContext: string; replayedMessageIds: string[] }
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:dsh-world/compaction-request': SummaryAudit }
}
interface Policy { thresholdRatio: number; headroomTokens: number; summarizationProvider: string; summarizationModel: string; maxTokens: number; maxOverflowRetries: number }
export interface ToolFreeCompactionConfig extends Partial<Policy> { timeZone?: string; auto?: boolean; modelPolicies?: (Partial<Policy> & { provider: string; model: string })[] }
interface Target { provider: string; model: string }

/**
 * The compacted span exactly as the conversation request sent it, minus every
 * tool call and tool result, so the summary request shares the longest possible
 * provider-cached prefix. Assistant text split around a removed call is rejoined.
 */
export function toolFreeMessages(messages: readonly Message[]): Message[] {
  const kept: Message[] = [];
  for (const message of messages) {
    if (message.role === 'tool') continue;
    if (message.role !== 'assistant') { kept.push(message); continue; }
    const content = message.content.filter(block => block.type !== 'tool-call');
    // A step that only reasoned before calling a tool has nothing left to say.
    if (!content.some(block => block.type !== 'reasoning')) continue;
    const previous = kept.at(-1);
    if (previous?.role === 'assistant') kept[kept.length - 1] = { ...previous, content: [...previous.content, ...content] };
    else kept.push(content.length === message.content.length ? message : { ...message, content });
  }
  return kept;
}

function hasConversation(messages: readonly Message[]): boolean {
  return messages.some(message => (message.role === 'user' || message.role === 'assistant') && !injectedSources.has(message.source.kind) && !(message.role === 'user' && isCompactCheckpointSource(message.source)) && visibleText(message.content).trim());
}

function routedTarget(session: Session): Target | undefined {
  const config = session.requestHeader()?.config;
  return config?.provider && config.model ? { provider: config.provider, model: config.model } : undefined;
}

function resolvePolicy(config: ToolFreeCompactionConfig, label = 'dsh-world/compaction'): Policy {
  const policy = {
    thresholdRatio: config.thresholdRatio ?? 0.9, headroomTokens: config.headroomTokens ?? 65536,
    summarizationProvider: config.summarizationProvider ?? '', summarizationModel: config.summarizationModel ?? '',
    maxTokens: config.maxTokens ?? config.headroomTokens ?? 65536, maxOverflowRetries: config.maxOverflowRetries ?? 1,
  };
  if (!(policy.thresholdRatio > 0 && policy.thresholdRatio <= 1)) throw new Error(`${label}: thresholdRatio must be in (0, 1]`);
  for (const key of ['headroomTokens', 'maxOverflowRetries'] as const) if (!Number.isInteger(policy[key]) || policy[key] < 0) throw new Error(`${label}: ${key} must be a non-negative integer`);
  if (!Number.isInteger(policy.maxTokens) || policy.maxTokens <= 0) throw new Error(`${label}: maxTokens must be a positive integer`);
  if (!policy.summarizationProvider !== !policy.summarizationModel) throw new Error(`${label}: summarizationProvider and summarizationModel must be set together`);
  return policy;
}

function rejectRetention(source: Record<string, unknown>, label: string, allowed: readonly string[]): void {
  if (source.retainRatio !== undefined || (source.retainTokens !== undefined && source.retainTokens !== 0)) throw new Error(`${label}: tool-free paragraph compaction summarizes the whole conversation; remove retainRatio/retainTokens`);
  for (const key of Object.keys(source)) if (!allowed.includes(key) && key !== 'retainTokens') throw new Error(`${label}: unknown key "${key}"`);
}

/** Pressure failures specific to one routed model; warned once per target. */
class TargetConfigError extends Error {
  readonly targetKey: string;
  constructor(targetKey: string, message: string) { super(message); this.targetKey = targetKey; }
}

/**
 * Replacement for `@deepseek-ai/dsh-compaction-basic`: drops every tool call,
 * tool result, tool schema and reasoning block from the compacted span, then
 * replaces the whole conversation with one summary paragraph.
 */
export default class ToolFreeCompaction extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions'];
  static Config = z.object({
    timeZone: z.string(), auto: z.boolean(),
    thresholdRatio: z.number(), headroomTokens: z.natural(), summarizationProvider: z.string(), summarizationModel: z.string(),
    maxTokens: z.natural(), maxOverflowRetries: z.natural(), retainTokens: z.natural(), retainRatio: z.number(),
    modelPolicies: z.array(z.object({ provider: z.string().required(), model: z.string().required(), thresholdRatio: z.number(), headroomTokens: z.natural(), summarizationProvider: z.string(), summarizationModel: z.string(), maxTokens: z.natural(), maxOverflowRetries: z.natural(), retainTokens: z.natural(), retainRatio: z.number() })),
  });
  private readonly policy: Policy;
  private readonly overrides: (Policy & Target)[];
  private readonly timeZone: string;
  private readonly warnedTargets = new Set<string>();
  private readonly overflowRetries = new WeakMap<object, number>();
  private readonly overflowAgents = new WeakMap<Session, object>();

  constructor(ctx: Context, config: ToolFreeCompactionConfig = {}) {
    super(ctx);
    const source = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)) as ToolFreeCompactionConfig & Record<string, unknown>;
    rejectRetention(source, 'dsh-world/compaction', [...policyKeys, 'timeZone', 'auto', 'modelPolicies']);
    this.timeZone = source.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    formatTimeContext(new Date(), this.timeZone);
    this.policy = resolvePolicy(source);
    const seen = new Set<string>();
    this.overrides = (source.modelPolicies ?? []).map((override, index) => {
      const label = `dsh-world/compaction: modelPolicies[${index}]`;
      const entry = Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined)) as typeof override & Record<string, unknown>;
      rejectRetention(entry, label, [...policyKeys, 'provider', 'model']);
      if (!entry.provider || !entry.model) throw new Error(`${label}: provider and model are required`);
      const key = `${entry.provider}\u0000${entry.model}`;
      if (seen.has(key)) throw new Error(`${label}: duplicate policy for ${entry.provider}/${entry.model}`);
      seen.add(key);
      const merged: ToolFreeCompactionConfig = { ...this.policy, ...entry };
      if (entry.maxTokens === undefined && entry.headroomTokens !== undefined && source.maxTokens === undefined) merged.maxTokens = entry.headroomTokens;
      return { ...resolvePolicy(merged, label), provider: entry.provider, model: entry.model };
    });
    if (source.auto ?? true) this.registerAutomaticCompaction();
  }

  private policyFor(target: Target | undefined): Policy {
    return (target && this.overrides.find(policy => policy.provider === target.provider && policy.model === target.model)) || this.policy;
  }

  private registerAutomaticCompaction(): void {
    const { ctx } = this;
    const log = (result: CompactionResult, trigger: string) => ctx.logger.info(`compaction (${trigger}): replaced ${result.shadowedSeqs.length} surface nodes with one tool-free summary (~${result.shadowedTokenCount} tokens)`);
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (!signal.aborted) try {
        const result = await this.compactIfNeeded(agent, 'pressure', signal);
        if (result) log(result, 'step pressure');
      } catch (error) {
        if (error instanceof TargetConfigError) {
          if (this.warnedTargets.has(error.targetKey)) return next();
          this.warnedTargets.add(error.targetKey);
        }
        ctx.logger.warn(`step compaction failed: ${error instanceof Error ? error.message : String(error)}; continuing the turn`);
      }
      return next();
    });
    ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') this.overflowRetries.delete(agent); });
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return;
      const agent = this.overflowAgents.get(session);
      if (agent) this.overflowRetries.delete(agent);
    });
    ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();
      this.overflowAgents.set(agent.session, agent);
      const target = routedTarget(agent.session);
      if (!target) return next();
      const retries = this.overflowRetries.get(agent) ?? 0;
      if (retries >= this.policyFor(target).maxOverflowRetries) return next();
      const generation = agent.session.surface.replaceGeneration;
      let result: CompactionResult | null;
      try { result = await this.compactIfNeeded(agent, 'context-overflow', signal); } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(`context-overflow compaction failed after durable surface progress: ${message}; retrying from the replacement surface`);
          this.overflowRetries.set(agent, retries + 1);
          return { kind: 'retry' };
        }
        ctx.logger.warn(`context-overflow compaction failed: ${message}; ${signal.aborted ? 'cancellation prevents retry' : 'preserving the original request error'}`);
        return next();
      }
      if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next();
      if (result) log(result, 'context overflow recovery');
      this.overflowRetries.set(agent, retries + 1);
      return { kind: 'retry' };
    });
  }

  async compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session);
    if (!target) return null;
    const meter = this.ctx.tokenMeter;
    if (trigger === 'context-overflow') {
      const range = selectWholeRange(agent.session, meter.measure(agent.session));
      return range && this.compactRegion(range.start, range.end, agent, signal);
    }
    const policy = this.policyFor(target);
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction');
    const key = `${target.provider}/${target.model}`;
    if (!info.context) throw new TargetConfigError(key, `dsh-world/compaction: no context capacity for ${key}; configure contextWindow on that adapter model`);
    const { contextWindow } = info.context;
    const reserved = agent.session.requestHeader()?.config.maxTokens ?? info.defaultMaxTokens ?? 0;
    const pressureBudget = contextWindow - reserved - policy.headroomTokens;
    if (pressureBudget <= 0) throw new TargetConfigError(key, `dsh-world/compaction: ${key} reserves ${reserved} completion and ${policy.headroomTokens} headroom tokens of its ${contextWindow}-token window, leaving no pressure budget`);
    const threshold = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudget));
    if (meter.measure(agent.session).totalTokens < threshold) return null;
    const range = selectWholeRange(agent.session, meter.measure(agent.session));
    if (!range) return null;
    const result = await this.compactRegion(range.start, range.end, agent, signal);
    const after = meter.measure(agent.session).totalTokens;
    if (after >= threshold) throw new Error(`compaction still above threshold after summarizing the whole conversation (${after} estimated tokens >= threshold ${threshold})`);
    return result;
  }

  compactRegion(start: SessionSeq, end: SessionSeq, agent: CompactionAgentContext, signal?: AbortSignal): Promise<CompactionResult> {
    return compactSurfaceRegion(this.dependencies(), agent, start, end, { owner: 'current-turn', stability: 'whole-surface' }, signal);
  }

  compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null> {
    signal.throwIfAborted();
    try {
      return agent.runMaintenance(async agentSignal => {
        const operationSignal = AbortSignal.any([agentSignal, signal]);
        try {
          operationSignal.throwIfAborted();
          const range = selectWholeRange(agent.session, this.ctx.tokenMeter.measure(agent.session));
          if (!range) return null;
          return await compactSurfaceRegion(this.dependencies(), agent, range.start, range.end, {
            owner: null, stability: 'selected-span', ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
            flush: async () => { await this.ctx.sessions.flush(agent.session); },
          }, operationSignal);
        } catch (error) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) throw new ManualCompactionError('cancelled', 'manual compaction was cancelled', { cause: error });
          operationSignal.throwIfAborted();
          throw error;
        }
      });
    } catch (error) {
      throw new ManualCompactionError('busy', 'manual compaction requires an idle agent with no waking queued work', { cause: error });
    }
  }

  private dependencies(): RegionDependencies {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (messages, agent, signal) => this.summarize(messages, agent, signal),
      frame: summary => [{ type: 'text', text: `${checkpointLead}${summary.map(block => block.type === 'text' ? block.text : '').join('')}` }],
      recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall('compaction/summary-error', { session: agent.session, sourceEventSeqs, error, ...(signal === undefined ? {} : { signal }) }, () => false),
    };
  }

  protected async summarize(messages: Message[], agent: RegionAgent, signal?: AbortSignal): Promise<SummaryResult> {
    try {
      signal?.throwIfAborted();
      const routed = routedTarget(agent.session) ?? (agent.options.provider && agent.options.model ? { provider: agent.options.provider, model: agent.options.model } : undefined);
      const policy = this.policyFor(routed);
      const provider = policy.summarizationProvider || routed?.provider;
      const model = policy.summarizationModel || routed?.model;
      const { maxTokens } = policy;
      if (!provider || !model) throw new Error('dsh-world: no provider/model configured for compaction');
      const replayed = toolFreeMessages(messages);
      if (!hasConversation(replayed)) throw new Error('dsh-world: no visible conversation remains to summarize');
      const { session } = agent;
      const head = session.surface.nodes[0] === undefined ? undefined : session.eventAt(session.surface.nodes[0]);
      const system = head?.type === 'system/message' ? session.deriveEventMessage(head) : null;
      const header = session.requestHeader();
      const timeContext = formatTimeContext(new Date(), this.timeZone);
      appendPluginRecord(session, 'plugin:dsh-world/compaction-request', { policyVersion: 2, provider, model, maxTokens, instruction: summaryInstruction, timeContext, replayedMessageIds: replayed.map(message => message.id) });
      await this.ctx.sessions.flush(session);
      const request = [
        ...(system ? [system] : []), ...replayed,
        createUserMessage({ source: { kind: 'dsh-world-summary-input' }, content: [{ type: 'text', text: `${summaryInstruction}\n\n${timeContext}` }] }),
      ];
      const assembler = new BlockAssembler();
      for await (const chunk of this.ctx.llm.stream({ provider, model, maxTokens, messages: request, ...(header?.tools === undefined ? {} : { tools: [...header.tools] }), toolHistory: session.toolHistory(), sessionId: session.id, purpose: 'compaction', ...(signal === undefined ? {} : { signal }) })) assembler.push(chunk);
      signal?.throwIfAborted();
      const finish = assembler.finish;
      if (finish.kind === 'error' || finish.kind === 'aborted') throw new LlmError(finish.failure.message, finish.failure.code, finish.failure);
      if (finish.kind !== 'stop') throw new Error(`dsh-world: compaction summary truncated or invalid (${finish.kind})`);
      const rawOutput: ContentBlock[] = assembler.blocks();
      if (rawOutput.some(block => block.type === 'tool-call')) throw new Error('dsh-world: summarizer returned an unexpected tool call');
      if (contentHasImage(rawOutput)) throw new Error('dsh-world: summarizer returned image output');
      const text = rawOutput.flatMap(block => block.type === 'text' ? [block.text.trim()] : []).join(' ').replace(/\s*\r?\n\s*/g, ' ').trim().replace(leadEcho, '').trim();
      if (!text) throw new Error('dsh-world: summarizer returned no paragraph');
      return { summary: [{ type: 'text', text }], rawOutput, provider, model, maxTokens, ...(assembler.usage ? { usage: assembler.usage } : {}) };
    } catch (error) { this.ctx.logger.error(error); throw error; }
  }
}
