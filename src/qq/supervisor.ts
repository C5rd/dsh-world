import { readConsoleToken } from './bridge.ts';
import type { QqBridge, QqIntent, QqLogger } from './bridge.ts';

/**
 * QQ：看着那个外部进程，别让它悄悄死掉。
 *
 * 为什么需要一层巡检：桥是独立进程（`spawn` 出去的、detached），插件这边除了启动时的一次
 * `ensureRunning()` 之外对它一无所知。它崩了、被任务管理器结束、DSH 换端口后它连不上——
 * 三种情况在界面上长得一模一样：QQ 不说话了。2026-10-26 那次「链路死了四小时」就是这么来的。
 *
 * 这层只做三件事：探测、判断该不该拉、拉的时候别把自己拉爆。它不碰桥的业务逻辑，
 * 也不接管桥的启停实现（那是 `bridge.ts` 的事）。
 */

export type SupervisorState = 'stopped' | 'starting' | 'healthy' | 'degraded' | 'recovering' | 'failed';

export interface SupervisorSnapshot {
  state: SupervisorState;
  /** 连续探测失败次数；成功一次清零。 */
  consecutiveFailures: number;
  /** 最近 10 分钟内真正发起的自动拉起次数。 */
  restartsInWindow: number;
  /** 下次探测的间隔（恢复失败后会变长）。 */
  backoffMs: number;
  /** 桥在线且 `dshReady`——false 时桥在跑但连不上 DSH，那是端点问题，重启桥治不了。 */
  dshReady?: boolean;
  lastError?: string;
  lastProbeAt?: number;
  lastRestartAt?: number;
}

export interface SupervisorOptions {
  /** qq-bridge 目录；`state/bridge.intent.json` 也从这里读。 */
  dir: string;
  port?: number;
  /** 只用到 start / halt / intent 三个动作，方便测试塞假桥。 */
  bridge: Pick<QqBridge, 'start' | 'halt' | 'intent'>;
  logger?: QqLogger;
  /** 探测间隔，默认 5s。 */
  intervalMs?: number;
  /** 单次探测超时，默认 1.5s。 */
  probeTimeoutMs?: number;
  /** 连续失败到几次才尝试恢复，默认 3。 */
  failuresBeforeRestart?: number;
  /** 10 分钟内最多自动拉起几次，默认 5。 */
  maxRestartsPerWindow?: number;
  /** 退避基数，默认 2s；第 n 次失败后等 base * 2^(n-1)，上限 60s。 */
  backoffBaseMs?: number;
  /** 注入时钟与随机源，测试用。 */
  now?: () => number;
  random?: () => number;
}

export interface QqSupervisor {
  /** 开始巡检。不会立刻拉起桥——「该不该跑」是调用方先决定的事。 */
  start(): void;
  /** 停止巡检。不影响桥本身。 */
  stop(): void;
  /** 立刻探一次，可用于控制台刷新或测试。 */
  probeOnce(): Promise<SupervisorSnapshot>;
  snapshot(): SupervisorSnapshot;
}

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const DEFAULT_FAILURES_BEFORE_RESTART = 3;
const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_BACKOFF_BASE_MS = 2000;
const MAX_BACKOFF_MS = 60000;
const RESTART_WINDOW_MS = 10 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

type ProbeResult = { ok: true; body: Record<string, any> } | { ok: false; error: string };

export function createQqSupervisor(options: SupervisorOptions): QqSupervisor {
  const {
    dir,
    bridge,
    logger,
    port = 3100,
    intervalMs = DEFAULT_INTERVAL_MS,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    failuresBeforeRestart = DEFAULT_FAILURES_BEFORE_RESTART,
    maxRestartsPerWindow = DEFAULT_MAX_RESTARTS,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
    now = () => Date.now(),
    random = () => Math.random(),
  } = options;

  const base = `http://127.0.0.1:${port}`;
  let state: SupervisorState = 'stopped';
  let consecutiveFailures = 0;
  /** 本轮连续发起恢复的次数；成功或被探到桥好了就清零。退避按它算。 */
  let recoverAttempts = 0;
  let backoffMs = 0;
  let restartsInWindow = 0;
  let lastError: string | undefined;
  let lastProbeAt: number | undefined;
  let lastRestartAt: number | undefined;
  let dshReady: boolean | undefined;
  const restartTimes: number[] = [];
  /** 单飞：探测和恢复共用这把锁，避免慢探测叠在恢复上。 */
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function pruneWindow(at: number): void {
    const cutoff = at - RESTART_WINDOW_MS;
    while (restartTimes.length > 0 && restartTimes[0]! < cutoff) restartTimes.shift();
    restartsInWindow = restartTimes.length;
  }

  function nextBackoff(): number {
    // 按「第几次发起恢复」算，不按「连续探测失败几次」算：
    // 阈值是 3，用探测次数会让第一次恢复就先等 4 倍基数。
    const raw = backoffBaseMs * 2 ** Math.min(Math.max(0, recoverAttempts - 1), 5);
    // ±20% 抖动：几个实例同时恢复时不至于踩着同一个节奏互相抢锁。
    const jitter = 0.8 + random() * 0.4;
    return Math.min(MAX_BACKOFF_MS, Math.round(raw * jitter));
  }

  async function probe(): Promise<ProbeResult> {
    const token = readConsoleToken(dir);
    const url = `${base}/api/status${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(probeTimeoutMs) });
      if (response.status !== 200) return { ok: false, error: `status ${response.status}` };
      const body = await response.json() as Record<string, any>;
      return { ok: true, body: body ?? {} };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  function intent(): QqIntent {
    try {
      return bridge.intent();
    } catch {
      // 读意图失败按「想跑」处理：未知状态不该变成永久不启动。
      return { desired: 'running', at: 0, by: '' };
    }
  }

  async function attemptRecovery(at: number): Promise<void> {
    const wanted = intent();
    if (wanted.desired === 'stopped') {
      // 用户主动停的：报状态就够了，别把手伸回去。
      state = 'stopped';
      logger?.info?.('[qq] 桥是用户主动停止的（desired=stopped），巡检不自动拉起');
      return;
    }
    pruneWindow(at);
    if (restartsInWindow >= maxRestartsPerWindow) {
      state = 'failed';
      lastError = `${RESTART_WINDOW_MS / 60000} 分钟内已自动拉起 ${restartsInWindow} 次，停止重试（修好再手动启动）`;
      logger?.warn?.(`[qq] ${lastError}`);
      return;
    }
    state = 'starting';
    logger?.warn?.(`[qq] 桥连续 ${consecutiveFailures} 次探测失败，尝试拉起`);
    try {
      const result = await bridge.start();
      if (result.started) {
        restartTimes.push(now());
        restartsInWindow = restartTimes.length;
        lastRestartAt = now();
        state = 'healthy';
        consecutiveFailures = 0;
        recoverAttempts = 0;
        backoffMs = 0;
        lastError = undefined;
        logger?.info?.('[qq] 桥已拉起');
        return;
      }
      lastError = `拉起没成功：${result.reason ?? '未知原因'}`;
    } catch (error) {
      lastError = `拉起失败：${messageOf(error)}`;
    }
    // 失败：进入退避等待，期间不再尝试；等待结束才回到 degraded 让下一轮重新判定。
    // 计数必须清零——否则「连续失败 3 次」这个闸门永远开着，退避等待一结束，
    // 下一次探测就直接又拉一遍，退避等于没做。
    state = 'recovering';
    consecutiveFailures = 0;
    recoverAttempts += 1;
    backoffMs = nextBackoff();
    logger?.warn?.(`[qq] ${lastError}；${Math.round(backoffMs / 1000)}s 后再试`);
    await sleep(backoffMs);
    if (state === 'recovering') state = 'degraded';
  }

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const at = now();
      lastProbeAt = at;
      const result = await probe();
      if (result.ok) {
        consecutiveFailures = 0;
        recoverAttempts = 0;
        backoffMs = 0;
        lastError = undefined;
        dshReady = result.body.dshReady === true;
        // 桥在跑但连不上 DSH：那是 baseUrl 过期，重启桥解决不了，交给 syncEndpoint。
        // 这里只把它标成 degraded，让人在界面上看得出来。
        state = dshReady ? 'healthy' : 'degraded';
        if (!dshReady) lastError = '桥在线，但 dshReady=false（多半是 DSH 换了端口，跑一次 syncEndpoint）';
        return;
      }
      dshReady = undefined;
      // 用户主动停的桥不在线是**预期状态**，不该算故障：否则界面上先跳十几秒的
      // 「degraded / 连续失败 2 次」才变回 stopped，看着像巡检在犹豫要不要动手。
      if (intent().desired === 'stopped') {
        state = 'stopped';
        consecutiveFailures = 0;
        recoverAttempts = 0;
        lastError = undefined;
        return;
      }
      consecutiveFailures += 1;
      lastError = result.error;
      state = 'degraded';
      if (consecutiveFailures >= failuresBeforeRestart) await attemptRecovery(at);
    } finally {
      inFlight = false;
    }
  }

  return {
    start(): void {
      if (timer) return;
      // 先探一次，别让界面在头 5 秒里显示「未知」。
      void tick();
      timer = setInterval(() => { void tick(); }, intervalMs);
      // 巡检不该成为进程退出的阻碍。
      (timer as { unref?: () => void }).unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
      state = 'stopped';
    },
    async probeOnce(): Promise<SupervisorSnapshot> {
      await tick();
      return this.snapshot();
    },
    snapshot(): SupervisorSnapshot {
      pruneWindow(now());
      return {
        state,
        consecutiveFailures,
        restartsInWindow,
        backoffMs,
        ...(dshReady === undefined ? {} : { dshReady }),
        ...(lastError ? { lastError } : {}),
        ...(lastProbeAt === undefined ? {} : { lastProbeAt }),
        ...(lastRestartAt === undefined ? {} : { lastRestartAt }),
      };
    },
  };
}