/**
 * Sweep schedule
 * ----------------------------------------------------------------------------
 * When the next automated sweep runs, computed the way the cron decides it.
 * Shared so Settings, Keywords and the Sidebar cannot each tell a different
 * story (the Sidebar printed the start time, which is wrong for a 6h or 12h
 * cadence and for any time after today's run).
 */

export type SweepCadence = '24h' | '12h' | '6h' | 'off';

/** Hours between automatic sweeps; 'off' has none. */
export const CADENCE_HOURS: Record<Exclude<SweepCadence, 'off'>, number> = { '24h': 24, '12h': 12, '6h': 6 };

export const CADENCE_LABELS: Record<SweepCadence, string> = {
  '24h': 'Daily',
  '12h': 'Twice a day',
  '6h': 'Every 6 hours',
  off: 'Off',
};

/** Automatic sweeps per day for a cadence (0 when off). */
export function sweepsPerDay(cadence: string): number {
  if (cadence === 'off') return 0;
  return 24 / (CADENCE_HOURS[cadence as Exclude<SweepCadence, 'off'>] ?? 24);
}

/** Mirrors isSweepDue() in supabase/functions/daily-sweep (hourly cron, UTC). */
export function isSweepDue(hourUtc: number, sweepHour: number, cadenceHours: number): boolean {
  if (cadenceHours >= 24) return hourUtc === sweepHour;
  return hourUtc % cadenceHours === sweepHour % cadenceHours;
}

/** The hour of a "HH:MM" UTC time. Minutes are ignored: the cron is hourly. */
export function sweepHourOf(sweepTime: string): number {
  const parsed = /^(\d{1,2})/.exec(sweepTime ?? '');
  const hour = parsed ? Number(parsed[1]) : 6;
  return hour >= 0 && hour <= 23 ? hour : 6;
}

/** The next top-of-the-hour, after `now`, at which the cron will sweep. */
export function nextSweepAt(sweepTime: string, cadence: string, now: Date = new Date()): Date | null {
  if (cadence === 'off') return null;
  const cadenceHours = CADENCE_HOURS[cadence as Exclude<SweepCadence, 'off'>] ?? 24;
  const sweepHour = sweepHourOf(sweepTime);
  const startOfHour = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours());
  for (let offset = 1; offset <= 25; offset += 1) {
    const candidate = new Date(startOfHour + offset * 3600_000);
    if (isSweepDue(candidate.getUTCHours(), sweepHour, cadenceHours)) return candidate;
  }
  return null;
}

/** "in 5m", "in 3h", "in 2d". */
export function relativeFromNow(target: Date, now: Date): string {
  const mins = Math.max(1, Math.round((target.getTime() - now.getTime()) / 60000));
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `in ${hrs}h` : `in ${Math.round(hrs / 24)}d`;
}

/** "Tue 06:00 UTC · in 3h", "Automatic sweeps off", or "Not scheduled". */
export function formatNextSweep(sweepTime: string, cadence: string, now: Date = new Date()): string {
  if (cadence === 'off') return 'Automatic sweeps off';
  const next = nextSweepAt(sweepTime, cadence, now);
  if (!next) return 'Not scheduled';
  const label = next.toLocaleString('en-US', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
  return `${label} UTC · ${relativeFromNow(next, now)}`;
}
