import { spawn } from 'node:child_process';
import type { Outlet } from '../outlets.ts';

/** reach_out's channels: the system notification where there is one, then every outlet that takes `reach`. */
export interface Notifier {
  toast?(title: string, body: string): Promise<void>;
  outlets: readonly Outlet[];
}
/** System notifications exist on Windows only (WinRT through PowerShell); elsewhere the channel is simply absent. */
export const toastSupported = () => process.platform === 'win32';
const xmlEscapes: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
const xml = (text: string) => text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[<>&'"]/g, char => xmlEscapes[char]!);
const cap = (text: string, max: number) => { const chars = [...text]; return chars.length > max ? `${chars.slice(0, max).join('')}…` : text; };
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/**
 * The host runs as plain Node (no Electron Notification), so toasts go through WinRT from PowerShell.
 * PowerShell treats U+2018/2019/201A/201B as single quotes, so no text is ever interpolated: it travels as base64.
 */
export function toastScript(appId: string, title: string, body: string): string {
  const payload = `<toast><visual><binding template="ToastGeneric"><text>${xml(cap(title, 64))}</text><text>${xml(cap(body, 500))}</text></binding></visual></toast>`;
  const decode = (text: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(text)}'))`;
  return [
    "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8",
    'try {',
    '$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
    `$appId = ${decode(appId)}`,
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml(${decode(payload)})`,
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
    '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
  ].join('\n');
}
export function windowsToast(appId = 'electron.app.DeepSeek Harness', spawnImpl: typeof spawn = spawn, timeoutMs = 10_000) {
  return (title: string, body: string) => new Promise<void>((resolvePromise, reject) => {
    if (process.platform !== 'win32') { reject(new Error('系统通知只支持 Windows')); return; }
    const encoded = Buffer.from(toastScript(appId, title, body), 'utf16le').toString('base64');
    const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const settle = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolvePromise(); };
    const timer = setTimeout(() => { child.kill(); settle(new Error('系统通知超时（10 秒）')); }, timeoutMs);
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => settle(error));
    child.on('close', code => settle(code === 0 ? undefined : new Error(`powershell 退出码 ${code}：${stderr.trim().slice(0, 200)}`)));
  });
}
