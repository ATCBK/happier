import { describe, expect, it } from 'vitest';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfileSnapshotV1Schema } from '@happier-dev/protocol/account/publicProfile';
import { projectPublicProfile } from '@happier-dev/protocol/account/projectPublicProfile';
import { PublicProfileLayoutV1Schema, PublicProfileViewV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { renderPublicProfileHtml } from './publicProfileHtml';

function published(tokens = true) {
    const view = projectPublicProfile({ context: { handle: 'nadia', identity: { name: '<Nadia> Müller' },
        service: { displayName: 'My Home', publicBaseUrl: 'https://profiles.example/prefix' },
        urls: { page: 'https://profiles.example/prefix/@nadia', json: 'https://profiles.example/prefix/v1/public/profiles/nadia',
            badgeBase: 'https://profiles.example/prefix/@nadia/badge', card: 'https://profiles.example/prefix/@nadia/card.svg',
            og: 'https://profiles.example/prefix/@nadia/og.png', report: 'mailto:operator@example.test' } },
        policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens } },
        metadata: {}, appearance: { theme: 'auto', atmosphere: { source: 'none' } },
        layout: PublicProfileLayoutV1Schema.parse({ v: 1, items: [{ kind: 'widget', id: 'summary', title: 'Shared work', size: 'medium', frameStyle: 'card',
            presentation: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Tokens',
                data: { kind: 'value', value: { kind: 'public_profile' } }, value: { path: ['snapshot', 'facts', 'tokens'], type: 'number' } } } } }] }),
        snapshot: PublicProfileSnapshotV1Schema.parse({ v: 1, computedAtMs: 2000,
            period: { startMs: 1000, endMs: 2000, timeZoneOffsetMinutes: 120 }, coverage: { status: 'partial', method: 'runtime' },
            fieldCoverage: {}, facts: { tokens: 987654321 } }) });
    if (!view) throw new Error('Expected admitted fixture');
    return { kind: 'published', view } as const;
}

describe('cold public-profile document', () => {
    it.each([
        ['usage_daily', {}], ['usage_period_summary', {}], ['usage_footprint', {}], ['usage_source_coverage', {}],
        ['usage_rhythm', { style: 'heatmap' }], ['usage_rhythm', { style: 'weekdayHour' }],
        ['usage_breakdowns', { style: 'breakdowns' }], ['usage_outcomes', { style: 'outcomes' }],
        ['usage_recap', { style: 'recap' }],
    ])('cold-renders admitted original %s %j through a shared body', (widgetId, inputs) => {
        const result = published();
        const view = PublicProfileViewV1Schema.parse({ ...result.view,
            snapshot: { ...result.view.snapshot,
                period: { startMs: Date.UTC(2026, 0, 1), endMs: Date.UTC(2026, 0, 4), timeZoneOffsetMinutes: 0 },
                facts: { tokens: 321, activeDays: 2, mergedPrs: 0, currentStreakDays: 1, bestStreakDays: 2,
                    agentTimeMs: 60000, peakParallel: 2,
                    calendar: [{ date: '2026-01-01', level: 4 }, { date: '2026-01-02', level: null }, { date: '2026-01-03', level: 0 }],
                    punch: [{ weekday: 1, hour: 10, level: 3 }],
                    agentMix: [{ agentId: 'codex', share: 1, coverage: { status: 'partial', method: 'runtime' } }],
                    sourceSplit: [{ execution: 'happier', share: 1 }],
                    footprint: { status: 'insufficient_basis', reason: 'no_applicable_versioned_method' },
                    highlights: [{ kind: 'active_days', count: 2 }],
                } },
            layout: { v: 1, items: [{ kind: 'widget', id: 'original', title: 'Shared original', size: 'wide', frameStyle: 'plain',
                presentation: { kind: 'usage', widgetId, inputs } }] },
        });
        const html = renderPublicProfileHtml({ kind: 'published', view });
        expect(html).toContain('Shared original');
        expect(html).toContain('data-testid="public-profile-usage-original');
        expect(html).not.toContain('data-testid="public-profile-usage-original-unavailable"');
        expect(html).not.toContain('<script');
        if (widgetId === 'usage_daily' || widgetId === 'usage_rhythm') {
            expect(html).toContain('Activity level');
        }
        if (widgetId === 'usage_footprint') expect(html).toContain('No estimate');
        if (widgetId === 'usage_outcomes') expect(html).toContain('0');
    });
    it('contains the actual placed shared body and CSS before client layout or hydration, using prefixed server-owned font and metadata URLs', () => {
        const html = renderPublicProfileHtml(published());
        expect(html).toContain('Shared work');
        expect(html).toContain('987,654,321');
        expect(html).toContain('&lt;Nadia&gt; Müller');
        expect(html).toContain('[stylesheet-group=');
        expect(html).toContain('https://profiles.example/prefix/v1/public/profiles/assets/fonts/Inter-Regular.ttf');
        expect(html).toContain('https://profiles.example/prefix/@nadia/og.png');
        expect(html).not.toContain('/og.png?v=');
        expect(html).not.toMatch(/<script\b|<Nadia>/);
        expect(html).toContain('noindex,nofollow');
        expect(html.split('<body>')[1]).toContain('font-family:Inter');
    });

    it('never serializes a hidden value, title or copied binding, including accessible markup and metadata', () => {
        const html = renderPublicProfileHtml(published(false));
        expect(html).not.toContain('987654321');
        expect(html).not.toContain('987,654,321');
        expect(html).not.toContain('Shared work');
        expect(html).not.toContain('snapshot.facts.tokens');
    });

    it('honors automatic appearance without hydration and uses only the one shared page for each selected edition', () => {
        const html = renderPublicProfileHtml(published());
        expect(html).toContain('@media(prefers-color-scheme:dark)');
        expect(html).toContain('public-profile-dark');
        expect(html).not.toContain('<script');
    });

    it('draws the shared Usage portrait through the real Brand slot without inventing absent public facts', () => {
        const result = published(false);
        const view = PublicProfileViewV1Schema.parse({ ...result.view, layout: { v: 1, items: [
            { kind: 'widget', id: 'portrait', title: 'Shared planet', size: 'medium', frameStyle: 'plain',
                presentation: { kind: 'usage', widgetId: 'usage_planet', inputs: {} } },
        ] } });
        const html = renderPublicProfileHtml({ kind: 'published', view });
        expect(html).toContain('Shared planet');
        expect(html).toContain('Light');
        expect(html).toContain('Not shared or not recorded');
        expect(html).toContain('<circle');
        expect(html).not.toContain('987,654,321');
        expect(html).not.toContain('<script');
    });
});
