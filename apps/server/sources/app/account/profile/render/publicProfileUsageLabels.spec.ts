import { describe, expect, it } from 'vitest';
import { PublicProfileViewV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { publicProfileUsageLabels } from './publicProfileUsageLabels';

const view = PublicProfileViewV1Schema.parse({
    v: 1, handle: 'nadia', indexable: false, state: 'published', identity: {}, metadata: {},
    service: { displayName: 'Home', publicBaseUrl: 'https://profiles.example' },
    snapshot: { v: 1, computedAtMs: 1, period: { startMs: Date.UTC(2026, 0, 1, 22),
        endMs: Date.UTC(2026, 0, 2, 22), timeZoneOffsetMinutes: 120 },
        coverage: { status: 'unknown', method: 'unknown' }, fieldCoverage: {}, facts: {} },
    layout: { v: 1, items: [] }, appearance: { theme: 'auto', atmosphere: { source: 'none' } },
    urls: { page: 'https://profiles.example/@nadia', json: 'https://profiles.example/json',
        badgeBase: 'https://profiles.example/badge', card: 'https://profiles.example/card.svg',
        og: 'https://profiles.example/og.png', report: 'mailto:operator@example.test' },
});

describe('anonymous Usage chart labels', () => {
    it('labels shared ordinal intensity as levels rather than manufacturing amounts', () => {
        const labels = publicProfileUsageLabels(view);
        expect(labels.weekTide?.peak(0, 23, 4)).toContain(labels.weekTide?.values.levelNames[4]);
        expect(labels.sky?.day('2026-01-02')).toBe('Fri, Jan 2');
        expect(labels.river?.values.formatTotal(1234)).toBe('—');
    });

    it('distinguishes unknown shares from measured zero, with measured durations and explicit English grouping', () => {
        const labels = publicProfileUsageLabels(view);
        expect(labels.daylight?.night(23, 7, null)).toBe('Night · 23:00–07:00');
        expect(labels.daylight?.night(23, 7, 0)).toBe('Night · 23:00–07:00 · 0%');
        expect(labels.runLength?.detail(59_500, 1234)).toBe('p90 1 min · 1,234');
        expect(labels.shipped?.countLine(1234)).toContain('1,234');
    });
});
