import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Notifier } from './notify.ts';
import type { WorldNames } from '../worldPrompt.ts';
import { exampleTime, fillMessage, readAlarmMessages } from './messages.ts';
import { pushOf } from '../outlets.ts';
import type { KeepInput } from './album.ts';

export interface AlarmDescriptions { plan: string; check: string; cancel: string }
export interface LifeToolHost {
  planNext(input: { at?: string; after_minutes?: number }, note: string): string;
  /** With both, check_alarm and cancel_alarm are offered too. */
  checkAlarm?(): string;
  cancelAlarm?(): string;
  /** With it, keep_photo is offered: a copy of a picture she was shown goes into her album. */
  keepPhoto?(input: KeepInput): Promise<string>;
  notifier: Notifier;
  names?: WorldNames;
  /** The DSH origin, for sticker URLs in her words. */
  origin?(): string | undefined;
  /** From the alarm template; the shipped wording otherwise. */
  descriptions?: AlarmDescriptions;
}
export function alarmDescriptions(messages = readAlarmMessages(undefined), values: Record<string, string> = { example: exampleTime('UTC'), fallbackWakeTime: '09:00' }): AlarmDescriptions {
  return { plan: fillMessage(messages, 'plan_next 说明', values), check: fillMessage(messages, 'check_alarm 说明', values), cancel: fillMessage(messages, 'cancel_alarm 说明', values) };
}
const text = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };

export function lifeTools(host: LifeToolHost) {
  const { companion, partner } = host.names ?? { companion: 'TA', partner: '伙伴' };
  const descriptions = host.descriptions ?? alarmDescriptions();
  const planNext = defineTool({
    name: 'plan_next',
    description: descriptions.plan,
    parameters: { at: { type: 'string' }, after_minutes: { type: 'number' }, note: { type: 'string', required: true } },
    output: text,
    execute: async ({ at, after_minutes, note }) => host.planNext({ ...(at === undefined ? {} : { at }), ...(after_minutes === undefined ? {} : { after_minutes }) }, note),
  });
  const { toast, outlets } = host.notifier;
  const reaching = outlets.filter(outlet => outlet.kinds.includes('reach'));
  const channelNames = [...(toast ? ['系统通知'] : []), ...reaching.map(outlet => outlet.name)];
  const reachOut = defineTool({
    name: 'reach_out',
    description: `想找${partner}时用：先在家里正常把话说出来，再用它把这句话送到${partner}面前（${channelNames.length ? channelNames.join(' + ') : '现在还没有配置任何通道'}）。image 可选，是一个表情的名字，接收的一方认得才会显示。找${partner}时说一两句就好，细节留在家里，${partner}来了自己会看。`,
    parameters: { text: { type: 'string', required: true }, image: { type: 'string' } },
    output: text,
    execute: async ({ text: message, image }) => {
      if (!channelNames.length) throw new Error('现在还没有配置任何通道，话留在家里了。');
      const push = pushOf(message, 'reach', companion, host.origin?.(), image);
      const channels: [string, string, Promise<void>][] = [
        ...(toast ? [['系统通知', '已发出', toast.call(host.notifier, companion, message)] as [string, string, Promise<void>]] : []),
        ...reaching.map(outlet => [outlet.name, '已送到', outlet.send(push)] as [string, string, Promise<void>]),
      ];
      const results = await Promise.allSettled(channels.map(([, , sent]) => sent));
      const summary = `${results.map((result, index) => { const [name, done] = channels[index]!; return result.status === 'fulfilled' ? `${name}${done}` : `${name}没送到：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`; }).join('；')}。`;
      if (results.every(result => result.status === 'rejected')) throw new Error(summary);
      return summary;
    },
  });
  const keepPhoto = host.keepPhoto && defineTool({
    name: 'keep_photo',
    description: `${partner}给你看的图里，若有让你觉得值得留下来的（好看的、有意义的、想以后再翻出来的），当场用它留进你的相册（房间里的「相册」文件夹，旁边有相册.md 记着日期和你写的话）。caption 写你为什么想留它，用你自己的话；title 可选，给它起个名字；which 默认 1，是最近看到的那张，2 是再往前一张。留下的是一份副本，会话以后被压缩或删掉也还在。同一张图只会留一次。`,
    parameters: { caption: { type: 'string', required: true }, title: { type: 'string' }, which: { type: 'number' } },
    output: text,
    execute: async ({ caption, title, which }) => host.keepPhoto!({ caption, ...(title === undefined ? {} : { title }), ...(which === undefined ? {} : { which }) }),
  });
  const { checkAlarm, cancelAlarm } = host;
  if (!checkAlarm || !cancelAlarm) return keepPhoto ? [planNext, reachOut, keepPhoto] as const : [planNext, reachOut] as const;
  const check = defineTool({ name: 'check_alarm', description: descriptions.check, parameters: {}, output: text, execute: async () => checkAlarm.call(host) });
  const cancel = defineTool({ name: 'cancel_alarm', description: descriptions.cancel, parameters: {}, output: text, execute: async () => cancelAlarm.call(host) });
  return keepPhoto ? [planNext, reachOut, check, cancel, keepPhoto] as const : [planNext, reachOut, check, cancel] as const;
}
