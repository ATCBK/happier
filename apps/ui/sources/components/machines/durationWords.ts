import { t } from '@/text';

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;

/**
 * "5 min", "1 h", "2 h 30 min", "2 d": how long, as a person says it. The one duration wording for
 * machine rules (alert sustains, guard delays and leads), Activity receipts and the session stop marker.
 */
export function formatMachineDuration(ms: number): string {
    const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
    if (minutes < 60) return t('machineVitals.alerts.durations.minutes', { minutes });
    if (minutes % DAY_MINUTES === 0) return t('machineVitals.alerts.durations.days', { days: minutes / DAY_MINUTES });
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0
        ? t('machineVitals.alerts.durations.hours', { hours })
        : t('machineVitals.alerts.durations.hoursMinutes', { hours, minutes: rest });
}

/**
 * A running or finished tool's elapsed time as a person says it: whole seconds under a minute ("45s"), then
 * the same words as every other duration ("2 min", "9 h 21 min"). Never a raw seconds counter.
 */
export function formatElapsedDuration(ms: number): string {
    const safe = Math.max(0, ms);
    return safe < MINUTE_MS
        ? t('tools.common.elapsedSeconds', { seconds: String(Math.floor(safe / 1000)) })
        : formatMachineDuration(safe);
}

/** "4:52" under ten minutes (the countdown a stop warning shows), else the duration ("10 min", "1 h 5 min"). */
export function formatMachineCountdown(remainingMs: number): string {
    const ms = Math.max(0, remainingMs);
    if (ms >= 10 * MINUTE_MS) return formatMachineDuration(ms);
    const seconds = Math.ceil(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
