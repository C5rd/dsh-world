import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { speakerIdentity, conversationKey, type SpeakerIdentity } from '../shared/identity.ts';
import type { ChannelContextMessage } from '../shared/context.ts';
import { createBridge } from './snowluma.ts';
import { createQqHome } from './home.ts';
import { createQqProactive, DEFAULT_QQ_PROACTIVE_POLICY, type QqProactive, type QqProactivePolicy, type QqProactiveStatus } from './proactive.ts';

/** The largest single message we accept from QQ; anything longer is cut before it reaches her. */
const MAX_INCOMING = 2_000;
/** How many distinct messages we remember to drop repeats of. */
const SEEN_LIMIT = 500;
/**
 * 问她要不要先开口时说的那段话。
 *
 * 她自己决定说什么 —— 想说的那句就是原话；不想说话，回 [SILENT] 就行（和旧桥一样的约定，
 * 但这边不再有候选表、分数和重试：一次问一句，说不说都算一次调用）。
 */
const NUDGE_PROMPT = [
  '现在没有人在跟你说话。',
  '如果想对他说点什么，就直接写下来 —— 那就是要发出去的原话：不要解释、不要加引号、不要自称发了消息。',
  '这一刻不想说话，就只回 [SILENT]。',
].join('\n');

/**
 * What we actually read off an incoming message.
 *
 * The transport (`snowluma.ts`) hands over its own normalized shape; this is the part of it the
 * module depends on, written out here so the wiring does not lean on that file's type names.
 */
interface QqIncoming {
  kind: 'group' | 'private';
  groupId: string | null;
  userId: string;
  messageId: string;
  selfId: string;
  text: string;
  sender?: { nickname?: string; card?: string | null } | undefined;
}

export interface QqNativeConfig {
  enabled: boolean;
  wsUrl: string;
  accessToken: string;
  /** QQ numbers allowed to talk to her at all; empty means nobody. */
  allowPrivate: readonly string[];
  allowGroups: readonly string[];
  /** Only these conversations get an answer; empty means every allowed one. */
  autoReply: boolean;
  /** How many earlier messages of the same conversation are shown to her with each new one. */
  contextMessages: number;
  /** Who shares her home session: `owner` keeps it for the owner's private chat, `none` gives every
   *  conversation its own, empty follows whatever the bridge's own setting says. */
  bindHomeSession: 'owner' | 'all' | 'none' | '';
  /** 她会不会自己先开口。`enabled` 关着时 policy 里的数字都不看。 */
  proactive: { enabled: boolean; dryRun: boolean; policy: Partial<QqProactivePolicy> };
}

export interface QqNativeStatus {
  enabled: boolean;
  connected: boolean;
  url: string;
  allowPrivate: number;
  allowGroups: number;
  autoReply: boolean;
  conversations: number;
  answering: number;
  lastEventAt: string | null;
  lastError: string | null;
  sent: number;
  failed: number;
  bindHomeSession: 'owner' | 'all' | 'none' | '';
  /** 主动开口那块自己的账；没开就是 null。 */
  proactive: QqProactiveStatus | null;
}

/**
 * QQ as another way into the same home, without a bridge process in between.
 *
 * One OneBot connection in, the same `home` the WeChat channel uses in the middle, and a reply sent
 * back out. There is no separate session store: a conversation's identity key is the whole mapping,
 * so a group keeps talking to the same conversation she already has for it.
 */
export function createQqNativeModule(deps: {
  ctx: Context;
  home(identity: SpeakerIdentity): Promise<Agent>;
  config(): QqNativeConfig;
  /** 面板拨的开关存这儿；不给就只在内存里活到下一次重载。 */
  stateFile?: string;
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
}) {
  const home = createQqHome({ ctx: deps.ctx, home: deps.home });
  const seen = new Set<string>();
  const contexts = new Map<string, ChannelContextMessage[]>();
  const answering = new Set<string>();
  // 她自己的那条线：最后一次见到的账号，和「要不要先开口」的引擎。
  let lastSelfId = '';
  let proactive: QqProactive | undefined;
  let client: ReturnType<typeof createBridge> | undefined;
  let stopped = false;
  // 面板要的那几个数自己记：传输层只交出一个 getState()，不带计数。
  const stats: { sent: number; failed: number; lastEventAt: string | null; lastError: string | null } = {
    sent: 0, failed: 0, lastEventAt: null, lastError: null,
  };

  // 拨过的开关写在 stateFile 里，重载不丢；配置里那个是出厂默认。
  let overrides: { autoReply?: boolean } = {};
  let overridesRead = false;
  function readOverrides(): void {
    if (overridesRead) return;
    overridesRead = true;
    const file = deps.stateFile;
    if (!file) return;
    try { overrides = JSON.parse(readFileSync(file, 'utf8')) as { autoReply?: boolean }; } catch { overrides = {}; }
  }
  function writeOverrides(): void {
    const file = deps.stateFile;
    if (!file) return;
    try { writeFileSync(file, JSON.stringify(overrides, null, 2) + '\n', 'utf8'); } catch (error) { deps.logger.warn('QQ 原生通道：开关没存下来', error); }
  }
  const settings = (): QqNativeConfig => {
    readOverrides();
    const base = deps.config();
    return overrides.autoReply === undefined ? base : { ...base, autoReply: overrides.autoReply };
  };

  function remember(messageId: string): boolean {
    if (!messageId) return true;
    if (seen.has(messageId)) return false;
    seen.add(messageId);
    if (seen.size > SEEN_LIMIT) { const first = seen.values().next().value; if (first !== undefined) seen.delete(first); }
    return true;
  }

  function allowed(identity: SpeakerIdentity): boolean {
    const config = settings();
    return identity.conversationType === 'group'
      ? config.allowGroups.includes(identity.conversationId)
      : config.allowPrivate.includes(identity.speakerId.slice('qq:'.length));
  }

  function pushContext(key: string, message: ChannelContextMessage, limit: number) {
    const list = contexts.get(key) ?? [];
    list.push(message);
    while (list.length > Math.max(1, Math.min(limit, 20))) list.shift();
    contexts.set(key, list);
  }

  async function deliver(message: QqIncoming) {
    if (stopped) return;
    const config = settings();
    if (!config.enabled) return;
    const messageId = message.messageId;
    if (!remember(messageId)) return;
    const selfId = message.selfId;
    const userId = message.userId;
    // Her own words come back through the same socket; answering them would be talking to herself.
    if (!userId || userId === selfId) return;
    const text = message.text.trim().slice(0, MAX_INCOMING);
    if (!text) return;
    const isGroup = message.kind === 'group';
    const conversationId = isGroup ? message.groupId ?? '' : userId;
    if (!conversationId) return;
    stats.lastEventAt = new Date().toISOString();
    // 有人说话了：房间安静了多久她得记得，顺带记住自己这个号是哪个。
    lastSelfId = selfId || lastSelfId;
    proactive?.noteActivity(Date.now(), lastSelfId);
    const speakerName = message.sender?.card || message.sender?.nickname || '';
    let identity: SpeakerIdentity;
    try {
      identity = speakerIdentity({
        channel: 'qq',
        accountId: selfId || '0',
        speakerId: `qq:${userId}`,
        ...(speakerName ? { speakerName } : {}),
        conversationId,
        conversationType: isGroup ? 'group' : 'private',
        ...(isGroup ? { conversationName: `群 ${conversationId}` } : {}),
        ...(messageId ? { platformMessageId: messageId } : {}),
      });
    } catch (error) { deps.logger.warn('QQ 消息身份不合法:', error); return; }
    if (!allowed(identity)) return;
    const key = conversationKey(identity);
    const context = contexts.get(key) ?? [];
    answering.add(key);
    try {
      const answer = await home.ask(text, identity, context);
      pushContext(key, { id: answer.id, occurredAt: new Date().toISOString(), text, identity }, config.contextMessages);
      if (!config.autoReply || stopped) return;
      const reply = answer.text.trim();
      if (!reply) return;
      if (isGroup) await client?.sendGroup(conversationId, reply);
      else await client?.sendPrivate(conversationId, reply);
      stats.sent += 1;
    } catch (error) {
      stats.failed += 1;
      stats.lastError = error instanceof Error ? error.message : String(error);
      deps.logger.warn(`QQ 回复 ${key} 失败: ${stats.lastError}`);
    } finally { answering.delete(key); }
  }

    /**
     * 她会不会先开口。
     *
     * 策略从配置来，剩下的交给 proactive.ts；这里只管两件它不会做的事：
     * 问她要说什么（走同一条 home 线），以及把话发出去（走同一条传输）。
     */
    function startProactive(config: QqNativeConfig): void {
      if (!deps.stateFile) return;
      if (config.proactive.enabled !== true) return;
      proactive = createQqProactive({
        policy: { ...DEFAULT_QQ_PROACTIVE_POLICY, ...config.proactive.policy },
        file: join(dirname(deps.stateFile), 'qq-proactive.json'),
        log: (message: string) => deps.logger.info(`QQ 主动联系：${message}`),
        target: () => settings().allowPrivate[0] ?? '',
        selfId: () => lastSelfId,
        dryRun: () => settings().proactive?.dryRun === true,
        generate: (hint: string) => nudge(hint),
        deliver: async (text: string) => {
          const target = settings().allowPrivate[0] ?? '';
          if (!target) throw new Error('私聊白名单是空的，没处发');
          await client?.sendPrivate(target, text);
        },
      });
      proactive.start();
    }

    /** 问她要说什么。走同一条 home 线，只是这条消息不是谁发来的。 */
    async function nudge(hint: string): Promise<string> {
      const target = settings().allowPrivate[0] ?? '';
      if (!target) throw new Error('私聊白名单是空的，没处问');
      if (settings().proactive?.dryRun === true) throw new Error('演练模式，不问她');
      const account = lastSelfId || proactive?.knownSelfId() || '0';
      const identity = speakerIdentity({
        channel: 'qq',
        accountId: account,
        speakerId: `qq:${target}`,
        conversationId: target,
        conversationType: 'private',
      });
      const answer = await home.ask(`${NUDGE_PROMPT}${hint ? `\n（此刻的情况：${hint}）` : ''}`, identity, [], { nudge: true });
      return answer.text;
    }

  return {
    status(): QqNativeStatus {
      const config = settings();
      return {
        enabled: config.enabled,
        connected: client?.getState() === 'online',
        url: config.wsUrl,
        allowPrivate: config.allowPrivate.length,
        allowGroups: config.allowGroups.length,
        autoReply: config.autoReply,
        bindHomeSession: config.bindHomeSession,
        conversations: contexts.size,
        answering: answering.size,
        lastEventAt: stats.lastEventAt,
        lastError: stats.lastError,
        sent: stats.sent,
        failed: stats.failed,
        proactive: proactive ? proactive.status() : null,
      };
    },
    /** 面板上那个「会不会自己回」的开关。 */
    setAutoReply(value: boolean) {
      readOverrides();
      overrides.autoReply = value;
      writeOverrides();
      return this.status();
    },
    start() {
      if (stopped) return;
      const config = settings();
      if (!config.enabled) return;
      const bridge = createBridge({
        wsUrl: config.wsUrl,
        ...(config.accessToken ? { accessToken: config.accessToken } : {}),
        log: (level: string, message: string) => {
          const line = `QQ 原生通道：${message}`;
          if (level === 'info') deps.logger.info(line);
          else if (level === 'warn') deps.logger.warn(line);
          else { stats.lastError = message; deps.logger.error(line); }
        },
        // 传输层只交出一条归一化过的消息，形状见 QqIncoming；两边对不上的字段这里本来也不用。
        onGroupMessage: (message: unknown) => { void deliver(message as QqIncoming); },
        onPrivateMessage: (message: unknown) => { void deliver(message as QqIncoming); },
        // bot_status 是 SnowLuma 的自有扩展：账号掉线时让它显示成「QQ 账号离线」，别和「桥挂了」混在一起。
        onNotice: (type: string) => {
          if (type === 'bot_offline') stats.lastError = 'QQ 账号离线';
          if (type === 'bot_online') stats.lastError = null;
        },
      });
      client = bridge;
      startProactive(config);
      bridge.start().catch((error: unknown) => {
        stats.lastError = error instanceof Error ? error.message : String(error);
        deps.logger.warn('QQ 原生通道首次连接失败：', stats.lastError);
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      home.stop();
      proactive?.stop();
      proactive = undefined;
      void client?.stop();
      client = undefined;
      contexts.clear();
      seen.clear();
    },
  };
}

export type QqNativeModule = ReturnType<typeof createQqNativeModule>;