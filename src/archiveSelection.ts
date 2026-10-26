import { existsSync, realpathSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';

export type MemoryArchiveScope = 'home' | 'workspace';
export const validArchiveScope = (value: unknown): value is MemoryArchiveScope => value === 'home' || value === 'workspace';

/** Workspace membership comes from the host, never a preset or a display name. */
export function createArchiveSelection(ctx: Context, scope: MemoryArchiveScope, isHome: (id: string) => boolean, roomDir: string): (id: string) => boolean {
  return id => {
    if (scope === 'home') return isHome(id);
    const registry = ctx.get('workspaceRegistry') as { list(): { path: string; sessionIds: readonly string[] }[] } | undefined;
    if (!registry) throw new Error('工作区归档需要宿主工作区服务');
    const workspaces = registry.list();
    const room = workspaces.find(workspace => workspace.sessionIds.some(isHome))
      ?? workspaces.find(workspace => workspace.path === (existsSync(roomDir) ? realpathSync(roomDir) : roomDir));
    return room?.sessionIds.includes(id) ?? false;
  };
}
