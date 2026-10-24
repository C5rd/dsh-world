export type AlarmSource = 'first' | 'plan' | 'fallback';
/** `nudged`: she was already asked once, when a home turn stopped well before this alarm, whether she is done. */
export interface Alarm { at: string; note: string; setAt: string; source: AlarmSource; nudged?: true }
export interface LifeState { version: 1; homeSessionId?: string; alarm?: Alarm }
export interface WakeRecord { scheduledAt: string; deliveredAt: string; source: AlarmSource; lateMs: number }
export interface ActivityRecord { time: string; sessionId: string; callId: string; tool: string; summary: string; outside: boolean; gapBefore?: true; status?: 'ok' | 'error' }
export interface CompactionRecord { time: string; sessionId: string; ok: boolean; shadowedTokens?: number; error?: string }
export interface LifeOptions {
  roomDir: string; diaryDir: string; fallbackWakeTime: string; timeZone: string;
  /** Her alarm wording; the shipped `templates/alarm.md` when absent or missing. */
  alarmFile?: string;
}
