import { getPreferredLanguage, t } from '@/text';

/**
 * The choices of Keeping it tidy (plan 40 STO-21/22, R43): each continuous value lists its presets
 * and ends with Custom…, which takes any value in the field's own range — a whole number of days from
 * one, a time of day. `null` is the policy's "Forever" / "Never".
 */

export const LOG_RETENTION_PRESET_DAYS = [7, 14, 30, 90] as const;
export const TRASH_EMPTY_PRESET_DAYS = [1, 7, 30] as const;
export const SUGGEST_UNUSED_PRESET_DAYS = [14, 30, 90] as const;
export const SCAN_TIME_PRESETS = ['00:00', '03:00', '06:00', '12:00', '18:00', '21:00'] as const;
export const FOREVER_ID = 'forever';

/** "30", "30 days", " 14d " → 14…; anything that is not a whole number of days from one is not a choice. */
export function parseCustomStorageDays(raw: string): number | null {
    const value = Number(raw.trim().replace(/\s*(days?|d)$/iu, ''));
    return Number.isInteger(value) && value >= 1 && value <= Number.MAX_SAFE_INTEGER ? value : null;
}

/** "3:00", "03:00", "21:30" → the policy's 24-hour HH:mm. */
export function parseCustomScanTime(raw: string): string | null {
    const match = /^\s*(\d{1,2}):(\d{2})\s*$/u.exec(raw);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function formatStorageDays(days: number): string {
    return t('machineStorage.tidy.days', { days });
}

/** Sunday = 0, as the policy stores the machine-local day; named in the reader's language. */
export function formatStorageWeekday(weekday: number): string {
    // 2024-01-07 was a Sunday; noon keeps every time zone on the same calendar day.
    return new Intl.DateTimeFormat(getPreferredLanguage(), { weekday: 'long' }).format(new Date(2024, 0, 7 + weekday, 12));
}

export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
