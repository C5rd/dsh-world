import { isAbsolute, relative, resolve } from 'node:path';

const shells = new Set(['pwsh', 'bash', 'powershell', 'shell']);
const pathKeys = new Set(['path', 'file_path', 'filePath', 'paths', 'cwd', 'directory', 'dir', 'target', 'source', 'destination', 'root', 'folder']);
const clip = (text: string) => Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, 160).join('');

/** Path strings under pathKeys at any depth, so nested operation arrays are covered. */
function collectPaths(value: unknown, keyed: boolean, out: string[]): string[] {
  if (typeof value === 'string') { if (keyed) out.push(value); }
  else if (Array.isArray(value)) for (const item of value) collectPaths(item, keyed, out);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) collectPaths(item, keyed || pathKeys.has(key), out);
  return out;
}

/** Shell commands cannot be reliably scoped, so they always count as outside the room. The path check is lexical: symlinks/junctions, `~` and `%VAR%` are not resolved. */
export function summarizeCall(tool: string, argumentsJson: string, roomDir: string): { summary: string; outside: boolean } {
  let parsed: unknown;
  try { parsed = JSON.parse(argumentsJson); } catch { parsed = undefined; }
  const args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  if (shells.has(tool.toLowerCase())) return { summary: clip(typeof args.command === 'string' ? args.command : argumentsJson), outside: true };
  const paths = collectPaths(args, false, []);
  const inside = (path: string) => { const rel = relative(roomDir, resolve(roomDir, path)); return rel === '' || (!/^\.\.(?:[\\/]|$)/.test(rel) && !isAbsolute(rel)); };
  return { summary: clip(paths.length ? paths.join(', ') : argumentsJson), outside: paths.some(path => !inside(path)) };
}
