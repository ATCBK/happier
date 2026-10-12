import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('cached Intl date/time formatters', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.restoreAllMocks();
    });

    it('reuses DateTimeFormat instances for equivalent locale and option sets', async () => {
        const formatSpy = vi.fn(() => 'formatted');
        const constructorSpy = vi
            .spyOn(Intl, 'DateTimeFormat')
            .mockImplementation((() => ({ format: formatSpy })) as unknown as typeof Intl.DateTimeFormat);
        const { formatWithCachedDateTimeFormatter } = await import('./cachedIntlFormatters');

        expect(formatWithCachedDateTimeFormatter(new Date(1), undefined, { timeStyle: 'short', dateStyle: 'medium' }))
            .toBe('formatted');
        expect(formatWithCachedDateTimeFormatter(new Date(2), undefined, { dateStyle: 'medium', timeStyle: 'short' }))
            .toBe('formatted');
        expect(formatWithCachedDateTimeFormatter(new Date(3), undefined, { hour: 'numeric' }))
            .toBe('formatted');

        expect(constructorSpy).toHaveBeenCalledTimes(2);
        expect(formatSpy).toHaveBeenCalledTimes(3);
    });

    it('names a calendar day without the year only while it is the current year', async () => {
        const { formatCalendarDate } = await import('./cachedIntlFormatters');
        const now = Date.parse('2026-10-12T12:00:00Z');
        expect(formatCalendarDate(Date.parse('2026-10-18T12:00:00Z'), 'en', now)).toBe('Oct 18');
        expect(formatCalendarDate(Date.parse('2027-01-03T12:00:00Z'), 'en', now)).toBe('Jan 3, 2027');
        expect(formatCalendarDate(Date.parse('2025-12-30T12:00:00Z'), 'en', now)).toBe('Dec 30, 2025');
    });
});
