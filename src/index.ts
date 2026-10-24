import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { createBridge } from './bridge/bridge.ts';
import { createOutlet } from './outlets.ts';
import { bridgeRoute } from './bridge/route.ts';
import { consoleRoute } from './console/routes.ts';
import { consoleSources, degradedSources } from './console/snapshot.ts';
import { hostLife } from './life/host.ts';
import { createLifeStore } from './life/lifeStore.ts';
import { toastSupported, windowsToast, type Notifier } from './life/notify.ts';
import { createLifeRuntime } from './life/runtime.ts';
import type { LifeOptions } from './life/types.ts';
import { createArchiveStore } from './store.ts';
import { worldNames } from './worldPrompt.ts';
import { createWorldRuntime } from './runtime.ts';
import type { WorldConfig } from './types.ts';

export { createWorldRuntime } from './runtime.ts';
export type { WorldConfig, ConversationRecord, ConversationTurn, ArchiveCursor } from './types.ts';
export const name = 'dsh-world';
export const inject = ['agents', 'sessions', 'sessionPersistence', 'llm'];
/** What `apply` receives: the schema below fills these defaults. */
export type Config = WorldConfig & Required<Pick<WorldConfig, 'life' | 'fallbackWakeTime' | 'outlets' | 'bridge' | 'toast'>>;
// One companion per profile is the usual case, so it works as installed: the standard preset, a world named
// default and the system time zone, with the life line on (it needs the desktop host's services and stays off without them).
const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const Config = z.object({
  worldId: z.string().default('default'), agentPreset: z.string().default('standard'), timeZone: z.string().default(systemTimeZone),
  companionName: z.string(), partnerName: z.string(),
  archiveScope: z.union([z.const('world'), z.const('home')]).default('world'),
  life: z.boolean().default(true), diaryDir: z.string(), fallbackWakeTime: z.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
  selfFile: z.string(), worldPromptFile: z.string(), alarmTemplateFile: z.string(),
  // Where her words go outside DSH; no app is known by name (see README for the push body).
  outlets: z.array(z.object({ name: z.string().required(), url: z.string(), urlFile: z.string(), path: z.string(), kinds: z.array(z.union([z.const('reply'), z.const('busy'), z.const('reach')])) })).default([]),
  // A local app may hand her partner's words to her home through POST /dsh-world/bridge/say.
  bridge: z.boolean().default(false),
  toast: z.boolean().default(true),
});
interface WebServer { register(route: ReturnType<typeof consoleRoute> | ReturnType<typeof bridgeRoute>): () => void }

export async function apply(ctx: Context, config: Config): Promise<void> {
  const dshHome = resolveDshHome();
  const worldDir = join(dshHome, 'worlds', config.worldId);
  const store = createArchiveStore({ ...config, root: dshHome });
  const options: LifeOptions = { roomDir: join(worldDir, 'room'), diaryDir: config.diaryDir || join(worldDir, 'diary'), fallbackWakeTime: config.fallbackWakeTime, timeZone: config.timeZone, alarmFile: config.alarmTemplateFile || join(worldDir, 'alarm.md') };
  // Set once the life line runs; until then no session is her home.
  let isHome: (sessionId: string) => boolean = () => false;
  const names = worldNames(config);
  // Her own template in the world directory replaces the shipped one, with no config needed.
  const prompt = { file: config.worldPromptFile || join(worldDir, 'world-prompt.md'), names, ...(config.life ? { life: options } : {}) };
  // Her self-description lives in her room whether or not the life line runs; she writes it with her file tools.
  const runtime = createWorldRuntime(ctx, { ...config, selfFile: config.selfFile || join(worldDir, 'room', '我是谁.md') }, store, { prompt, isHome: id => isHome(id) });
  ctx.effect(() => () => runtime.stop(), 'dsh-world archive lifecycle');
  await runtime.start();
  if (!config.life) return;
  // The life line starts once the desktop host services exist and never takes the memory line down with it.
  ctx.inject(['sessionController', 'permissionPresets', 'webServer'], async lifeCtx => {
    const webServer = (lifeCtx as unknown as { webServer: WebServer }).webServer;
    const created = (() => {
      try {
        const host = hostLife(lifeCtx);
        const lifeStore = createLifeStore(worldDir, config.timeZone);
        const outlets = config.outlets.map(outlet => createOutlet(outlet, () => host.origin()));
        const notifier: Notifier = { ...(config.toast && toastSupported() ? { toast: windowsToast() } : {}), outlets };
        const life = createLifeRuntime({ ctx: lifeCtx, config, options, store: lifeStore, host, notifier });
        const bridge = config.bridge ? createBridge({ ctx: lifeCtx, home: () => life.home(), outlets, origin: () => host.origin(), file: join(worldDir, 'bridge.json'), name: names.companion }) : undefined;
        return { lifeStore, life, bridge };
      } catch (error) {
        lifeCtx.logger.error('dsh-world: the life line stays off:', error);
        // The console still opens and says why, instead of looking as if the life line were simply off.
        const fault = `生活线没能启动：${error instanceof Error ? error.message : String(error)}`;
        lifeCtx.effect(() => webServer.register(consoleRoute(degradedSources(config, store, options.diaryDir, fault))), 'dsh-world console routes');
      }
    })();
    if (!created) return;
    const { lifeStore, life, bridge } = created;
    lifeCtx.effect(() => { isHome = life.isHome; return () => { isHome = () => false; return life.stop(); }; }, 'dsh-world life line');
    if (bridge) {
      lifeCtx.effect(() => { bridge.start(); return () => bridge.stop(); }, 'dsh-world bridge');
      // The host matches exact routes before the longest prefix, so this path never reaches the console.
      lifeCtx.effect(() => webServer.register(bridgeRoute(bridge)), 'dsh-world bridge route');
    }
    const sources = consoleSources(lifeCtx, config, store, lifeStore, life, options.diaryDir, bridge?.faults);
    lifeCtx.effect(() => webServer.register(consoleRoute(sources)), 'dsh-world console routes');
    await life.start();
  });
}
