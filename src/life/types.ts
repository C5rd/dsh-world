export type AlarmSource = 'plan' | 'fallback';
/** `nudged`: she was already asked once, when a home turn stopped well before this alarm, whether she is done. */
export interface Alarm { at: string; note: string; setAt: string; source: AlarmSource; nudged?: true }
/** `arrival`: when a new home was built that has not greeted her yet. */
export interface LifeState { version: 1; homeSessionId?: string; alarm?: Alarm; arrival?: string }
/** `first` is a new home's first wake, sent the moment it is built. */
export interface WakeRecord { scheduledAt: string; deliveredAt: string; source: AlarmSource | 'first'; lateMs: number }
export interface ActivityRecord { time: string; sessionId: string; callId: string; tool: string; summary: string; outside: boolean; gapBefore?: true; status?: 'ok' | 'error' }
export interface CompactionRecord { time: string; sessionId: string; ok: boolean; shadowedTokens?: number; error?: string }
export interface LifeOptions {
  roomDir: string; diaryDir: string; fallbackWakeTime: string; timeZone: string;
  /** Her alarm wording; the shipped `templates/alarm.md` when absent or missing. */
  alarmFile?: string;
}
