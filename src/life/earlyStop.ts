import type { Alarm } from './types.ts';

/** A home turn that stops more than this before her own alarm stopped early. */
export const EARLY_STOP_MS = 5 * 60_000;

/**
 * Decides when a home turn that ends counts as her stopping early: a completed turn, well before her own
 * alarm, not yet asked about for that alarm. A turn in which her partner spoke is a conversation pausing,
 * and the turn the question itself started is never asked about again, so nothing loops.
 */
export function createEarlyStopWatch() {
  let partnerSpoke = false;
  let asking = false;
  return {
    partnerSpoke(): void { partnerSpoke = true; },
    /** Ends the turn's marks; true when this ending should be asked about. */
    turnEnded(completed: boolean, alarm: Alarm | undefined, now: Date): alarm is Alarm & { source: 'plan' } {
      const quiet = completed && !partnerSpoke && !asking;
      partnerSpoke = false; asking = false;
      return quiet && alarm?.source === 'plan' && !alarm.nudged && Date.parse(alarm.at) - now.getTime() > EARLY_STOP_MS;
    },
    /** The question is on its way; the turn it starts is not asked about. */
    asking(): void { asking = true; },
    /** The question never arrived, so no turn of its own will follow. */
    notAsked(): void { asking = false; },
  };
}
