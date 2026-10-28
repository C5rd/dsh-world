import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { speakerIdentity, conversationKey, type SpeakerIdentity } from '../shared/identity.ts';
import type { ChannelContextMessage } from '../shared/context.ts';
import { createBridge } from './snowluma.ts';
import { createQqHome } from './home.ts';
import type { InWorld } from '../../worldScope.ts';
import { createNativeBridge, type BridgeStatus, type NativeBridge } from './native-bridge.ts';

/** The largest single message we accept from QQ; anything longer is cut before it reaches her. */
const MAX_INCOMING = 2_000;
/** How many distinct messages we remember to drop repeats of. */
const SEEN_LIMIT = 500;

/** The newest `limit` ids, oldest dropped first. */
function recentIds(limit: number) {
  const ids = new Set<string>();
  return {
    has: (id: string) => ids.has(id),
    /** False when the id was already there. */
    add(id: string): boolean {
      if (ids.has(id)) return false;
      ids.add(id);
      if (ids.size > limit) ids.delete(ids.values().next().value!);
      return true;
    },
    clear: () => ids.clear(),
  };
}

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
  /** 原始段数组（OneBot 的 message）。群里那句是不是在叫她，看的就是它。 */
  segments?: Array<{ type?: string; data?: Record<string, unknown> }> | undefined;
}

export interface QqNativeConfig {
  enabled: boolean;
  wsUrl: string;
  accessToken: string;
  /** QQ numbers allowed to talk to her at all; empty means nobody. */
  allowPrivate: readonly string[];
  allowGroups: readonly string[];
  /** 她会不会回。关掉是「收到但不理」——连问都不问，不花调用。 */
  autoReply: boolean;
  /** How many earlier messages of the same conversation are shown to her with each new one. */
  contextMessages: number;
  /** 群里什么时候接话：mention 只接被叫到的（被 @ / 被引用她的消息 / 命中关键词），all 每句都接。 */
  groupTrigger: 'mention' | 'all';
  /** 群里命中这些词也算在叫她。 */
  groupKeywords: readonly string[];
  /** Who shares her home session: `owner` keeps it for the owner's private chat, `none` gives every
   *  conversation its own, empty follows whatever the bridge's own setting says. */
  bindHomeSession: 'owner' | 'all' | 'none' | '';
  /** 阳台：让这台机器上别的程序能跟家里说话的那条线。`port` 为 0 就整块不开。 */
  bridge: { port: number; token: string; title: string; contextMessages: number };
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
  /** 阳台那条线现在什么样（没开就是 null）。 */
  bridge: BridgeStatus | null;
  /** 到了通道、但不在白名单里被挡下的条数。 */
  blocked: number;
  /** 最近一次被白名单挡下的时刻。 */
  lastBlockedAt: string | null;
  bindHomeSession: 'owner' | 'all' | 'none' | '';
  /** 群里接话的规矩。 */
  groupTrigger: 'mention' | 'all';
}

/** 传输层交给通道的那几件（真身上是 snowluma.js 的 createBridge，测试可以换掉）。 */
export interface QqTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): string;
  sendGroup(groupId: string, text: string): Promise<{ messageId: string }>;
  sendPrivate(userId: string, text: string): Promise<{ messageId: string }>;
}

/** createBridge 认的那几个选项，通道只用到这几个。 */
export interface QqTransportOptions {
  wsUrl: string;
  accessToken?: string;
  log(level: string, message: string): void;
  onGroupMessage?(message: unknown): void;
  onPrivateMessage?(message: unknown): void;
  onNotice?(type: string, notice?: unknown): void;
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
  inWorld?: InWorld;
  config(): QqNativeConfig;
  /** 面板拨的开关存这儿；不给就只在内存里活到下一次重载。 */
  stateFile?: string;
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
  /** 传输层；不给就用真身（snowluma.js 那条线）。测试靠它把合成事件灌进来。 */
  transport?(options: QqTransportOptions): QqTransport;
}) {
  const home = createQqHome({ ctx: deps.ctx, home: deps.home, inWorld: deps.inWorld });
  const seen = recentIds(SEEN_LIMIT);
  // 她说出去的消息 id。有人引用她的话，引用的就是这个 id。
  const sentIds = recentIds(SEEN_LIMIT);
  const contexts = new Map<string, ChannelContextMessage[]>();
  const answering = new Set<string>();
  let client: QqTransport | undefined;
  let nativeBridge: NativeBridge | undefined;
  let stopped = false;
  // 面板要的那几个数自己记：传输层只交出一个 getState()，不带计数。
  const stats: { sent: number; failed: number; blocked: number; lastEventAt: string | null; lastBlockedAt: string | null; lastError: string | null } = {
    sent: 0, failed: 0, blocked: 0, lastEventAt: null, lastBlockedAt: null, lastError: null,
  };

  // 拨过的开关写在 stateFile 里，重载不丢；配置里那个是出厂默认。
  const overrides = ((): { autoReply?: boolean; bridge?: { port?: number } } => {
    try { return deps.stateFile ? JSON.parse(readFileSync(deps.stateFile, 'utf8')) : {}; } catch { return {}; }
  })();
  function writeOverrides(): void {
    const file = deps.stateFile;
    if (!file) return;
    try { writeFileSync(file, JSON.stringify(overrides, null, 2) + '\n', 'utf8'); } catch (error) { deps.logger.warn('QQ 原生通道：开关没存下来', error); }
  }
  const settings = (): QqNativeConfig => {
    const base = deps.config();
    // 面板上改过端口就以面板为准；其余字段还是配置里那套。
    const bridge = overrides.bridge?.port === undefined ? base.bridge : { ...base.bridge, port: overrides.bridge.port };
    return {
      ...base,
      ...(overrides.autoReply === undefined ? {} : { autoReply: overrides.autoReply }),
      bridge,
    };
  };

  /**
   * 群里这句是不是在叫她。
   *
   * 量过：不做这个判断时，群里没被叫到的每一句都会让她跑完一整轮、还往群里冒一条——哪怕她自己在话里
   * 写的是「这句不接」，钱和噪声都已经花了。所以只有被 @ 到、有人引用过她的话、或者命中配的关键词，
   * 才把话递到她跟前；其余只记进那个群的上下文，等她真被叫到时知道刚才在说什么。
   */
  function directedAtHer(message: QqIncoming, config: QqNativeConfig): boolean {
    if (config.groupTrigger === 'all') return true;
    for (const segment of message.segments ?? []) {
      const data = segment?.data ?? {};
      if (segment?.type === 'at' && (data.qq === 'all' || String(data.qq ?? '') === message.selfId)) return true;
      if (segment?.type === 'reply' && data.id != null && sentIds.has(String(data.id))) return true;
    }
    return config.groupKeywords.some(word => word !== '' && message.text.includes(word));
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
    if (messageId && !seen.add(messageId)) return;
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
    // 不在白名单也算「到过」：不然分不清「消息根本没送到」和「送到了但被白名单挡下」——
    // 明天拿手机发一条时，这两件事的区别就是全部的意义。
    if (!allowed(identity)) {
      stats.blocked += 1;
      stats.lastBlockedAt = new Date().toISOString();
      return;
    }
    const key = conversationKey(identity);
    // 群里没叫她的话、自动回复关着时的话，都只进上下文：不开口、也不花一轮（关掉自动回复就是「别理它」，
    // 连问都不问）。等她真被叫到，就知道刚才在说什么。私聊不看叫没叫她。
    if ((isGroup && !directedAtHer(message, config)) || !config.autoReply || stopped) {
      pushContext(key, { id: messageId || String(Date.now()), occurredAt: new Date().toISOString(), text, identity }, config.contextMessages);
      return;
    }
    const context = contexts.get(key) ?? [];
    answering.add(key);
    try {
      const answer = await home.ask(text, identity, context);
      // 她那句话记成她自己说的：不然后面拿这段上下文问她「刚才聊到哪了」时，
      // 她说过的会被当成对方说的（home.ts 里按 speakerId 判 role 为 assistant）。
      const herIdentity = speakerIdentity({
        channel: 'qq',
        accountId: identity.accountId,
        speakerId: `qq:${identity.accountId}`,
        conversationId: identity.conversationId,
        conversationType: identity.conversationType,
      });
      pushContext(key, { id: answer.id, occurredAt: new Date().toISOString(), text: answer.text, identity: herIdentity }, config.contextMessages);
      const reply = answer.text.trim();
      if (!reply) return;
      const sent = await (isGroup ? client?.sendGroup(conversationId, reply) : client?.sendPrivate(conversationId, reply));
      if (sent?.messageId) sentIds.add(String(sent.messageId));
      stats.sent += 1;
    } catch (error) {
      stats.failed += 1;
      stats.lastError = error instanceof Error ? error.message : String(error);
      deps.logger.warn(`QQ 回复 ${key} 失败: ${stats.lastError}`);
    } finally { answering.delete(key); }
  }

  /**
   * 阳台：给机器上别的程序留的一条线。
   *
   * 和 QQ 那条完全分开 —— 它是外面递话进来，不是 QQ 消息。一条线一间屋子（会话键里带着
   * `qq-bridge`），所以它跟她别的会话互不打扰。口令落在世界目录（qq-bridge.json），
   * 重启 DSH 对面那份配置不用改。
   */
  function startBridge(config: QqNativeConfig): void {
    if (nativeBridge || !config.bridge.port) return;
    nativeBridge = createNativeBridge({
      ctx: deps.ctx,
      session: identity => deps.home(identity),
      inWorld: deps.inWorld,
      config: () => {
        const live = settings().bridge;
        return { port: live.port, token: live.token, title: live.title, contextMessages: live.contextMessages };
      },
      worldDir: deps.stateFile ? dirname(deps.stateFile) : process.cwd(),
      script: join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'qq-line.js'),
      log: (message: string) => deps.logger.info(message),
    });
    void nativeBridge.start().catch((error: unknown) => deps.logger.error('阳台没能开起来', error));
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
        bridge: nativeBridge?.status() ?? null,
        groupTrigger: config.groupTrigger,
        conversations: contexts.size,
        answering: answering.size,
        lastEventAt: stats.lastEventAt,
        blocked: stats.blocked,
        lastBlockedAt: stats.lastBlockedAt,
        lastError: stats.lastError,
        sent: stats.sent,
        failed: stats.failed,
      };
    },
    /** 面板上改阳台的端口：当场关掉重开那条线（0 就是关）。 */
    setBridge(patch: { port?: number }): QqNativeStatus {
      if (patch.port !== undefined) { overrides.bridge = { port: patch.port }; writeOverrides(); }
      nativeBridge?.stop();
      nativeBridge = undefined;
      startBridge(settings());
      return this.status();
    },
    /** 面板上那个「会不会自己回」的开关。 */
    setAutoReply(value: boolean) {
      overrides.autoReply = value;
      writeOverrides();
      return this.status();
    },
    start() {
      if (stopped) return;
      const config = settings();
      if (!config.enabled) return;
      const bridge = (deps.transport ?? createBridge)({
        wsUrl: config.wsUrl,
        ...(config.accessToken ? { accessToken: config.accessToken } : {}),
        log: (level: string, message: string) => {
          const line = `QQ 原生通道：${message}`;
          // 连回来就把上次的报错擦掉（不然面板上挂着一句昨天的错，会让人以为现在还坏着）。
          // 「QQ 账号离线」不是这一层的事，留着。
          if (level === 'info') {
            if (message.startsWith('WS 已连接') && stats.lastError !== 'QQ 账号离线') stats.lastError = null;
            deps.logger.info(line);
          } else if (level === 'warn') deps.logger.warn(line);
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
      startBridge(config);
      bridge.start().catch((error: unknown) => {
        stats.lastError = error instanceof Error ? error.message : String(error);
        deps.logger.warn('QQ 原生通道首次连接失败：', stats.lastError);
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      home.stop();
      nativeBridge?.stop(); nativeBridge = undefined;
      void client?.stop();
      client = undefined;
      contexts.clear();
      seen.clear(); sentIds.clear();
    },
  };
}

export type QqNativeModule = ReturnType<typeof createQqNativeModule>;
