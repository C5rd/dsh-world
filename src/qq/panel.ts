import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { durableWrite } from '../life/lifeStore.ts';

/**
 * The two consoles her partner opens from the QQ card, both reached from this machine only.
 *
 * qq-bridge writes its console token into `<bridge>/state/console-token`, so that door needs nothing from him:
 * read the file, put the token in the URL, done.
 *
 * SnowLuma's console is different. Its session token lives in the bridge process's memory (a fresh 64-hex
 * string per login, dead on restart) and the only way to get one is `POST /api/login` with the panel password.
 * So he types that password exactly once; it is kept in `<world>/panel.json` with mode 600 and used from then
 * on to trade for a token behind his back. The page itself takes `?token=` and wipes it off the address bar.
 */

export const PANEL_FILE = 'panel.json';
/** Its console answers on loopback; the port comes from SnowLuma's own runtime.json, never a constant here. */
const LOOPBACK = '127.0.0.1';
const LOGIN_TIMEOUT_MS = 8000;
const DEFAULT_USERNAME = 'admin';

interface PanelFile { snowluma?: { username?: string; password?: string } }
interface RuntimeFile { webuiPort?: number; webuiHost?: string; webuiTls?: { enabled?: boolean } }

export interface PanelUrl { url: string }
export interface PanelNeeds { needs: 'password'; url?: string; username?: string }
export interface PanelError { error: string }
export type PanelResult = PanelUrl | PanelNeeds | PanelError;

/** Where SnowLuma's console listens, learned from its own config; undefined when it is not installed here. */
export function findSnowlumaConsole(homeDir: string): { base: string; username?: string } | undefined {
  if (!homeDir) return undefined;
  const runtime = join(homeDir, 'config', 'runtime.json');
  if (!existsSync(runtime)) return undefined;
  let parsed: RuntimeFile;
  try { parsed = JSON.parse(readFileSync(runtime, 'utf8')) as RuntimeFile; }
  catch { return undefined; }
  const port = Number(parsed.webuiPort);
  if (!Number.isInteger(port) || port <= 0) return undefined;
  const host = String(parsed.webuiHost ?? LOOPBACK);
  // A console bound to every interface is still reached from here by name.
  const named = host === '0.0.0.0' || host === '::' || host === '' ? LOOPBACK : host;
  const scheme = parsed.webuiTls?.enabled === true ? 'https' : 'http';
  return { base: `${scheme}://${named}:${port}`, username: undefined };
}

/** The panel password he typed once, kept beside her room rather than inside her world settings. */
export function createPanelSecrets(worldDir: string) {
  const file = join(worldDir, PANEL_FILE);
  let stored: PanelFile = {};
  try { if (existsSync(file)) stored = JSON.parse(readFileSync(file, 'utf8')) as PanelFile; }
  catch { stored = {}; }
  const read = (): { username: string; password: string } | undefined => {
    const password = stored.snowluma?.password;
    if (typeof password !== 'string' || password === '') return undefined;
    return { username: stored.snowluma?.username?.trim() || DEFAULT_USERNAME, password };
  };
  return {
    read,
    remember(username: string, password: string): void {
      stored = { ...stored, snowluma: { username: username.trim() || DEFAULT_USERNAME, password } };
      durableWrite(file, JSON.stringify(stored, null, 2));
    },
    forget(): void {
      stored = {};
      durableWrite(file, '{}');
    },
  };
}
export type PanelSecrets = ReturnType<typeof createPanelSecrets>;

/** Trades the panel password for a session token and hands back a URL that opens already logged in. */
export async function loginSnowluma(base: string, username: string, password: string, fetchImpl: typeof fetch = fetch): Promise<PanelResult> {
  const root = base.replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetchImpl(`${root}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
  } catch (error) {
    return { error: `连不上 SnowLuma 控制台（${root}）：${error instanceof Error ? error.message : String(error)}` };
  }
  let body: Record<string, unknown> = {};
  try { body = (await response.json()) as Record<string, unknown>; } catch { body = {}; }
  if (response.status === 429) return { error: '登录尝试太多，SnowLuma 让等一会儿再试' };
  const token = typeof body.token === 'string' ? body.token : '';
  if (!response.ok || body.success !== true || token === '') {
    const message = typeof body.message === 'string' ? body.message : `登录失败（HTTP ${response.status}）`;
    return { error: message };
  }
  return { url: `${root}/?token=${encodeURIComponent(token)}` };
}

/** qq-bridge's console token is a file next to its state; the page takes it in the URL too. */
export function readBridgeToken(bridgeDir: string): string {
  const file = join(bridgeDir, 'state', 'console-token');
  try { return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''; }
  catch { return ''; }
}

export function bridgeConsoleUrl(bridgeDir: string, port: number): PanelResult {
  const token = readBridgeToken(bridgeDir);
  if (token === '') return { error: 'qq-bridge 还没有控制台令牌（它没启动过？）' };
  return { url: `http://${LOOPBACK}:${port}/?token=${encodeURIComponent(token)}` };
}

/** The two doors the QQ card's buttons knock on. */
export interface ConsoleDoors {
  qq(): PanelResult;
  snowluma(): Promise<PanelResult>;
  remember(username: string, password: string): Promise<PanelResult>;
  /** Hand a console URL to the desktop's own browser; neither console allows being framed. */
  open(kind: 'qq' | 'snowluma'): Promise<{ opened: true } | { error: string }>;
}

/**
 * Both consoles send `X-Frame-Options: DENY` (SnowLuma also `frame-ancestors 'none'`), so no page of ours can
 * hold them in a frame. Opening the desktop's own browser is the honest way in: it is where these consoles were
 * meant to run, and the token rides in the URL so it lands already logged in.
 */
export function openInBrowser(url: string, spawnImpl: typeof spawn = spawn): { opened: true } | { error: string } {
  try {
    if (process.platform === 'win32') {
      // The empty argument is the window title; without it `start` eats the first quoted word.
      spawnImpl('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      spawnImpl(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return { opened: true };
  } catch (error) {
    return { error: `打不开浏览器：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Where SnowLuma itself lives, as the bridge already knows it (`snowluma.homeDir` in its config). */
export function readSnowlumaHome(bridgeDir: string): string {
  const file = join(bridgeDir, 'config.json');
  try {
    if (!existsSync(file)) return '';
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { snowluma?: { homeDir?: unknown }; dsh?: { snowluma?: { homeDir?: unknown } } };
    const home = parsed.snowluma?.homeDir ?? parsed.dsh?.snowluma?.homeDir;
    return typeof home === 'string' ? home : '';
  } catch { return ''; }
}

export function createConsoleDoors(options: { worldDir: string; bridgeDir: string; port: number; snowlumaHome?: string }): ConsoleDoors {
  const secrets = createPanelSecrets(options.worldDir);
  const home = options.snowlumaHome ?? readSnowlumaHome(options.bridgeDir);
  async function snowluma(): Promise<PanelResult> {
    const console = findSnowlumaConsole(home);
    if (!console) return { error: '没找到 SnowLuma 的控制台配置（它在哪？）' };
    const saved = secrets.read();
    if (!saved) return { needs: 'password', url: console.base, username: DEFAULT_USERNAME };
    return loginSnowluma(console.base, saved.username, saved.password);
  }
  return {
    qq: () => bridgeConsoleUrl(options.bridgeDir, options.port),
    snowluma,
    async remember(username: string, password: string): Promise<PanelResult> {
      const console = findSnowlumaConsole(home);
      if (!console) return { error: '没找到 SnowLuma 的控制台配置（它在哪？）' };
      const result = await loginSnowluma(console.base, username.trim() || DEFAULT_USERNAME, password);
      // Only keep a password that works; a typo should not be remembered as the truth.
      if ('url' in result) secrets.remember(username, password);
      return result;
    },
    async open(kind: 'qq' | 'snowluma') {
      const door = kind === 'qq' ? bridgeConsoleUrl(options.bridgeDir, options.port) : await snowluma();
      // A door that still wants a password carries its base URL too; that is not something to open.
      if ('needs' in door) return { error: 'SnowLuma 还差一次面板密码' };
      if ('error' in door) return { error: door.error };
      return openInBrowser(door.url);
    },
  };
}