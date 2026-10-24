import { formatLocalTime } from '../timeContext.ts';
import type { Alarm } from './types.ts';
import { ALARM_MARK, exampleTime, fillMessage, readAlarmMessages, type AlarmMessages } from './messages.ts';

export const MIN_ALARM_MS = 60_000;
/** setTimeout's ceiling; longer alarms are re-armed in segments. */
export const MAX_TIMER_MS = 2_147_483_647;
const LATE_NOTICE_MS = 2 * 60_000;

export function resolveAlarmTime(input: { at?: string; after_minutes?: number }, now: Date, timeZone = 'UTC'): Date {
  if ((input.at === undefined) === (input.after_minutes === undefined)) throw new Error('请只给 at 或 after_minutes 其中一个');
  let target: Date;
  if (input.at !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.at)) throw new Error(`at 需要 ISO 8601 格式并带时区，例如 ${exampleTime(timeZone)}`);
    target = new Date(input.at);
  } else {
    const minutes = input.after_minutes!;
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('after_minutes 必须是正数');
    target = new Date(now.getTime() + minutes * 60_000);
  }
  if (!Number.isFinite(target.getTime())) throw new Error(`无法识别的时间：${input.at ?? input.after_minutes}`);
  if (target.getTime() - now.getTime() < MIN_ALARM_MS) throw new Error('闹钟至少要定在 1 分钟之后');
  return target;
}
const offsetMs = (at: number, timeZone: string) => {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(formatLocalTime(new Date(at), timeZone))!;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
};
/** The first instant strictly after `now` whose local time in `timeZone` is hhmm:00; a time skipped by a DST gap lands on the first instant after the gap. */
export function nextLocalTime(now: Date, hhmm: string, timeZone: string): Date {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) throw new Error(`无效的时间 ${hhmm}，需要 HH:MM`);
  const [hour, minute] = [Number(match[1]), Number(match[2])];
  const today = formatLocalTime(now, timeZone);
  const [y, mo, d] = [Number(today.slice(0, 4)), Number(today.slice(5, 7)), Number(today.slice(8, 10))];
  for (let k = 0; k < 3; k++) {
    const wall = Date.UTC(y, mo - 1, d + k, hour, minute);
    const date = new Date(wall).toISOString().slice(0, 10);
    const want = `${date}T${match[1]}:${match[2]}:00`;
    const around = [offsetMs(wall - 86_400_000, timeZone), offsetMs(wall + 86_400_000, timeZone)];
    const hits = [...new Set(around)].map(offset => wall - offset).filter(at => formatLocalTime(new Date(at), timeZone).slice(0, 19) === want);
    let at = hits.length ? Math.min(...hits.filter(h => h > now.getTime()), Infinity) : NaN;
    if (!hits.length) {
      // Skipped by a gap: the first instant from which the local clock reads at least the wanted time.
      let [lo, hi] = [wall - Math.max(...around), wall - Math.min(...around)].sort((a, b) => a - b) as [number, number];
      while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (formatLocalTime(new Date(mid), timeZone).slice(0, 19) >= want) hi = mid; else lo = mid; }
      at = hi;
    }
    if (at > now.getTime() && Number.isFinite(at)) return new Date(at);
  }
  throw new Error(`找不到 ${hhmm} 之后的下一个时间`);
}
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440); const hours = Math.floor((minutes % 1440) / 60); const rest = minutes % 60;
  const parts = [days ? `${days} 天` : '', hours ? `${hours} 小时` : '', rest || (!days && !hours) ? `${rest} 分` : ''];
  return parts.filter(Boolean).join(' ');
}
/**
 * What she hears when an alarm rings. The wording comes from the alarm template (`extra` carries her
 * names for templates that use them); the 【你的时间】 mark is always the plugin's own.
 */
export function wakeText(alarm: Alarm, now: Date, timeZone: string, fallbackWakeTime: string, messages: AlarmMessages = readAlarmMessages(undefined), extra: Record<string, string> = {}): string {
  const late = now.getTime() - Date.parse(alarm.at);
  const base = { ...extra, timeZone, fallbackWakeTime };
  const lateText = late >= LATE_NOTICE_MS ? fillMessage(messages, '晚到说明', { ...base, lateBy: formatDuration(late) }) : '';
  const body = alarm.source === 'first' ? fillMessage(messages, '第一次到家', base)
    : alarm.source === 'fallback' ? fillMessage(messages, '早上兜底', { ...base, late: lateText })
    : fillMessage(messages, '闹钟响了', { ...base, time: formatLocalTime(new Date(alarm.at), timeZone), note: alarm.note, late: lateText }, { note: Boolean(alarm.note) });
  const tail = fillMessage(messages, '结尾提醒', base);
  return `${ALARM_MARK}${body}${tail ? `\n${tail}` : ''}`;
}
