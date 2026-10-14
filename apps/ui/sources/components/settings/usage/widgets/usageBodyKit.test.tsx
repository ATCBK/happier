import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { QualifiedConnectedServiceUsageSourceV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { ProviderAccountUsageSnapshotV1Schema, buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { projectProviderAccountUsageQuotaReadV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { resolveUsagePageAggregation, type UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { renderHook, renderScreen } from '@/dev/testkit';
import { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { resolveUsageShownCalendarRange, formatUsageObservedAt } from '@/sync/domains/usage/usageCalendarPresentation';
import { Heatmap, StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import { UsageDailyWidget } from './UsageDailyWidget';
import { UsageFlowWidget } from './UsageFlowWidget';
import { UsageRhythmWidget } from './UsageRhythmWidget';
import { usageQaAccountingFixture } from '@/dev/testkit/fixtures/usageQaAccountingFixture';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { usageSourceAgentId } from '@/sync/domains/usage/usageLabels';
import { describeUsagePagePendingSources, readUsageCoverageGaps, UsageCoverageLine, usageCoverageDescription, usageCoverageSummary, usageCoverageLineMode, usagePeriodPhrase, usageDimensionLabel, usageAgentTitle, usageSourceTitle, useUsageMeterListFirstReadReserve } from './usageBodyKit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

describe('shared Usage identity and dependent coverage', () => {
    it('retains the full numeric version in a newer model absent from the static Agent catalog', () => {
        expect(usageDimensionLabel('model', 'claude-haiku-6-1')).toBe('Claude Haiku 6.1');
    });
    it('holds an unanswered usage read as loading, never as "No usage in this period"', async () => {
        const query = normalizeUsageQuery({ period: { relative: '7days' }, granularity: 'day' });
        const slice = resolveUsagePageAggregation({ queries: [query] }).results[0]!;
        const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: true, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const screen = await renderScreen(<UsageDailyWidget query={query} slice={slice} model={model} serverId="home" id="usage_daily" testID="daily" />);
        expect(screen.getTextContent()).not.toContain(t('usage.board.page.noUsageTitle'));
        expect(screen.findByTestId('daily.loading')).toBeTruthy();
    });
    it.each([false, true])('keeps the real open-ended QA calendar and gaps visible (relative: %s)', async relative => {
        const accounting = usageQaAccountingFixture();
        const query = normalizeUsageQuery({ period: relative ? { relative: '7days' } : { startMs: 1791064800000 },
            granularity: 'day', timeZoneOffsetMinutes: 120, includeActivity: true, activityResolution: 'both' });
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: accounting }] }).results[0]!;
        const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const props = { query, slice, model, serverId: 'home' };
        const screen = await renderScreen(<><UsageDailyWidget {...props} id="usage_daily" testID="qa-daily" />
            <UsageRhythmWidget {...props} id="usage_rhythm" testID="qa-rhythm" /></>);
        const calendar = screen.findByType(Heatmap).props.cells as { id: string; value: number | null }[];
        expect(calendar.filter(cell => cell.value !== null && cell.value > 0).map(cell => [cell.id, cell.value]))
            .toEqual(accounting.activity!.calendarDays!.map(day => [day.date, day.eventCount]));
        expect(calendar).toHaveLength(relative ? 7 : 8);
        const points = screen.findByType(StackedSeriesChart).props.series[0].points as { y: number | null }[];
        expect(points).toHaveLength(relative ? 7 : 8);
        expect(points.slice(0, relative ? 4 : 5).every(point => point.y === null)).toBe(true);
        expect(accounting.insights!.activeDays).toBe(calendar.filter(cell => (cell.value ?? 0) > 0).length);
    });
    it('does not invent a Legacy Agent for scalar reports with unknown attribution', () => {
        expect(usageAgentTitle('legacy')).toBe(t('usage.board.page.unattributed'));
        expect(usageDimensionLabel('agent', 'legacy', 'Legacy')).toBe(t('usage.board.page.unattributed'));
    });
    it('projects known accounting producers as usage, not technical ingestion names', () => {
        for (const source of ['legacy', 'legacy_usage_report']) {
            expect(usageSourceTitle(source)).toBe(t('usage.board.page.sourceAccounting'));
        }
        expect(usageSourceTitle('legacy', 'Legacy')).toBe(t('usage.board.page.sourceAccounting'));
        expect(usageSourceTitle('claude-assistant-usage')).toBe(t('usage.board.page.sourceClaudeResponses'));
        expect(usageSourceTitle('claude-sdk-result')).toBe(t('usage.board.page.sourceClaudeSessionSummaries'));
        expect(usageSourceTitle('claude-assistant-usage')).not.toBe(usageSourceTitle('claude-sdk-result'));
        expect(usageSourceAgentId('claude-assistant-usage')).toBe('claude');
        expect(usageSourceAgentId('claude-sdk-result')).toBe('claude');
        for (const source of ['codex-native-accounting', 'codex-app-server-token-usage']) {
            expect(usageSourceTitle(source)).toBe(`${t('usage.board.page.sourceAccounting')} · ${usageAgentTitle('codex')}`);
        }
        // These ids are emitted by the native accounting codecs too.
        for (const agent of ['pi', 'opencode']) {
            const source = `${agent}-native-accounting`;
            expect(usageSourceAgentId(source)).toBe(agent);
            expect(usageSourceTitle(source)).toBe(`${t('usage.board.page.sourceAccounting')} · ${usageAgentTitle(agent)}`);
        }
        expect(usageSourceTitle('claude-sdk-result', 'Research capture')).toBe('Research capture');
        expect(usageSourceTitle('claude-sdk-result', 'Claude SDK Result')).toBe(t('usage.board.page.sourceClaudeSessionSummaries'));
    });
    it('says coverage once per page: passive gaps live in Sources, only reading and failure stay beside a body', () => {
        const gap = (status: 'partial' | 'stale' | 'pending' | 'not_loaded' | 'error' | 'unsupported') => ({ source: 'how_you_work', status });
        // On the Usage page the Sources chooser carries the one quiet coverage dot and its detail.
        expect(usageCoverageLineMode([gap('partial'), gap('stale'), gap('unsupported')], true)).toBe('hidden');
        // A source still being read is one cause: the page header says it once, the bodies hold their room.
        expect(usageCoverageLineMode([gap('pending'), gap('not_loaded')], true)).toBe('hidden');
        expect(usageCoverageLineMode([gap('partial'), gap('error')], true)).toBe('failed');
        // Off the page (Home, Project, Session hosts) nothing else says it, so the detail stays.
        expect(usageCoverageLineMode([gap('partial')], false)).toBe('detail');
        expect(usageCoverageLineMode([], false)).toBe('hidden');
    });

    it('a body\'s own line says an incomplete read in one quiet clause; the full wording stays for the Sources chooser', () => {
        const slice = (status: 'partial' | 'pending' | 'error') => ({ sources: [
            { source: 'claude-assistant-usage', status }, { source: 'claude-sdk-result', status }, { source: 'quota', status },
        ] }) as unknown as UsageQueryResultSlice;
        const partial = slice('partial');
        expect(usageCoverageSummary(partial, ['quota', 'claude-assistant-usage', 'claude-sdk-result'])).toBe('Partial history');
        expect(usageCoverageDescription(partial, ['quota', 'claude-assistant-usage', 'claude-sdk-result'])).toContain(usageSourceTitle('quota'));
        // A read still going, or failed, keeps naming what it is waiting on or what failed.
        expect(usageCoverageSummary(slice('pending'), ['quota'])).toBe(t('usage.board.page.coveragePending', { sources: usageSourceTitle('quota') }));
        expect(usageCoverageSummary(slice('error'), ['quota'])).toContain(usageSourceTitle('quota'));
        expect(usageCoverageSummary({ sources: [] } as unknown as UsageQueryResultSlice, ['quota'])).toBe('');
    });

    it('keeps settled incomplete allowance coverage visible through refresh and removes it only when history completes', async () => {
        const recordKey = { providerId: 'codex', accountSubjectId: 'work', subjectKind: 'account', quotaScope: 'account' } as const;
        const current = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordKey, recordId: buildProviderAccountUsageRecordId(recordKey),
            providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'work' }, observedAtMs: 100, fetchedAtMs: 100,
            staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [] });
        const source = QualifiedConnectedServiceUsageSourceV4Schema.parse({ bindingKind: 'account',
            ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' } });
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 200 } });
        const sliceFor = (complete: boolean) => resolveUsagePageAggregation({ queries: [query],
            quota: { status: 'available', asOfMs: 100, value: [projectProviderAccountUsageQuotaReadV1({ input: { source },
                current, nowMs: 200, history: { entries: [], nextCursor: complete ? null : { id: 'next', observedAtMs: 50 } } })] },
        }).results[0]!;
        const settled = sliceFor(false);
        const screen = await renderScreen(<UsageCoverageLine slice={settled} sources={['quota']} testID="settled-coverage" />);
        expect.soft(usageCoverageSummary(settled, ['quota'])).toBe('Partial history');
        expect.soft(screen.findHostByTestId('settled-coverage') !== null).toBe(true);
        const before = screen.getTextContent();
        await screen.update(<UsageCoverageLine slice={{ ...settled, pending: true }} sources={['quota']} testID="settled-coverage" />);
        expect(screen.getTextContent()).toBe(before);
        await screen.update(<UsageCoverageLine slice={sliceFor(true)} sources={['quota']} testID="settled-coverage" />);
        expect(screen.findHostByTestId('settled-coverage') === null).toBe(true);
    });

    it('names every source still being read once for the page header', () => {
        const slice = (sources: readonly Readonly<{ source: string; status: 'pending' | 'not_loaded' | 'available' | 'partial' }>[]) =>
            ({ sources }) as unknown as Parameters<typeof describeUsagePagePendingSources>[0][number];
        expect(describeUsagePagePendingSources([slice([{ source: 'quota', status: 'pending' }]),
            slice([{ source: 'quota', status: 'not_loaded' }, { source: 'accounting', status: 'available' }])]))
            .toBe(t('usage.board.page.coveragePending', { sources: usageSourceTitle('quota') }));
        expect(describeUsagePagePendingSources([slice([{ source: 'accounting', status: 'partial' }])])).toBeNull();
        // A widget's own read (a pool selection) is said by that widget, not listed in the page header.
        expect(describeUsagePagePendingSources([slice([{ source: 'selection:openai-codex-pool', status: 'pending' }])])).toBeNull();
    });
    it('discloses a held account read after sibling allowances have arrived', () => {
        // The aggregate Resource publishes each qualified account independently of its siblings.
        const source = QualifiedConnectedServiceUsageSourceV4Schema.parse({ bindingKind: 'account',
            ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'held' } });
        const held = `quota:${JSON.stringify(source)}`;
        const sources = [{ source: 'quota', status: 'available' }, { source: held, status: 'pending' }] satisfies UsageQueryResultSlice['sources'];
        expect(describeUsagePagePendingSources([{ sources }])).toBe(
            t('usage.board.page.coveragePending', { sources: usageSourceTitle('quota') }));
        expect(describeUsagePagePendingSources([{ sources: sources.map(source => ({ ...source, status: 'available' })) }])).toBeNull();
    });
    it('humanizes unknown qualified producer identities without replacing a supplied display title', () => {
        const producer = 'third.party/research:remote';
        expect(usageAgentTitle(producer, producer)).toBe('Third Party Research Remote');
        expect(usageAgentTitle(producer, 'Research lab Agent')).toBe('Research lab Agent');
        expect(usageSourceTitle(`native:${producer}`)).not.toContain(producer);
        expect(usageSourceTitle(`native:${producer}`)).not.toMatch(/[/:]/);
    });
    it('uses catalog model names in Flow for both source partitions and the unpartitioned mix', async () => {
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 2 * 86_400_000 }, metric: 'tokens', breakdown: ['model'] });
        const tokens = { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 };
        const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
        const sliceFor = (partitioned: boolean) => resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            v: 1, totals: { eventCount: 2, tokens: { ...tokens, total: 20, input: 20 }, cost }, modelTimeline: [0, 86_400_000].map(bucketStartMs => ({ bucketStartMs, bucketEndMs: bucketStartMs + 86_400_000,
                leaders: [{ key: 'claude-fable-5', label: 'claude-fable-5', eventCount: 1, tokens, cost,
                    ...(partitioned ? { sources: [{ source: 'runtime', path: 'runtime' as const, execution: 'happier' as const, eventCount: 1, tokens, cost }] } : {}) }] })),
        } }] }).results[0]!;
        const slice = sliceFor(true);
        const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const screen = await renderScreen(<UsageFlowWidget query={query} slice={slice} model={model} serverId="home" id="usage_flow" testID="flow-model" />);
        expect(screen.findByType(StackedSeriesChart).props.series[0].label).toBe('Fable 5');
        await screen.update(<UsageFlowWidget query={query} slice={sliceFor(false)} model={model} serverId="home" id="usage_flow" testID="flow-model" />);
        expect(screen.findByType(StackedSeriesChart).props.series[0].label).toBe('Fable 5');
    });
    it('projects catalog model names and canonical machine names instead of raw identities', () => {
        expect(usageDimensionLabel('model', 'claude-haiku-4-5-20251001')).toBe(usageDimensionLabel('model', 'claude-haiku-4-5'));
        expect(usageDimensionLabel('model', 'claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
        expect(usageDimensionLabel('model', 'claude-fable-5', undefined, new Map())).toBe('Fable 5');
        expect(usageDimensionLabel('machine', 'machine-uuid', 'machine-uuid', new Map([['machine-uuid', 'Build Mac']]))).toBe('Build Mac');
        expect(usageDimensionLabel('machine', 'missing-uuid', undefined, new Map())).toBe(t('machine.unlistedMachine'));
    });
    it('preserves genuine contributed model and source titles while humanizing raw fallback keys', () => {
        expect(usageDimensionLabel('model', 'third-party/model-snapshot', 'Research-Lab Model / Preview')).toBe('Research-Lab Model / Preview');
        expect(usageDimensionLabel('model', 'third-party/model-snapshot', 'third-party/model-snapshot')).toBe('Third Party Model Snapshot');
        expect(usageSourceTitle('native:third.party/research:remote', 'Research-Lab Capture / Preview')).toBe('Research-Lab Capture / Preview');
    });
    it('keeps the date of historical coverage instead of presenting an old observation as today', () => {
        const timestamp = new Date(2024, 3, 22, 9, 15).getTime();
        const now = new Date(2024, 3, 23, 9, 15).getTime();
        expect(formatUsageObservedAt(timestamp, now, 'en')).toBe(new Intl.DateTimeFormat('en', {
            hour: 'numeric', minute: '2-digit', year: 'numeric', month: 'short', day: 'numeric',
        }).format(timestamp));
        expect(formatUsageObservedAt(now, now, 'en')).toBe(new Intl.DateTimeFormat('en', {
            hour: 'numeric', minute: '2-digit',
        }).format(now));
    });
    it('keeps Agent identity and execution source partitions in mounted Daily and Flow charts', async () => {
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 86_400_000 }, metric: 'tokens' });
        const tokens = { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 };
        const cost = { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' };
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            v: 1, totals: { eventCount: 3, tokens: { ...tokens, total: 30, input: 30 }, cost },
            engineTimeline: [{ bucketStartMs: 0, bucketEndMs: 86_400_000, leaders: [{ key: 'codex:local', eventCount: 3,
                tokens: { ...tokens, total: 30, input: 30 }, cost, sources: [
                    { source: 'runtime', path: 'runtime', execution: 'happier', eventCount: 1, tokens, cost },
                    { source: 'native', path: 'native', execution: 'outside', eventCount: 1, tokens, cost },
                    { source: 'older', path: 'unknown', execution: 'unknown', eventCount: 1, tokens, cost },
                ] }] }],
        } }] }).results[0]!;
        const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const props = { query, slice, model, serverId: 'home' };
        const screen = await renderScreen(<><UsageDailyWidget {...props} id="usage_daily" testID="daily" />
            <UsageFlowWidget {...props} id="usage_flow" testID="flow" /></>);
        const charts = screen.findAllByType(StackedSeriesChart);
        for (const chart of charts) {
            expect(chart.props.series).toHaveLength(1);
            expect(chart.props.series.map((entry: { points: { y: number }[] }) => entry.points[0]!.y)).toEqual([30]);
            expect(new Set(chart.props.series.map((entry: { color: string }) => entry.color)).size).toBe(1);
            expect(chart.props.series[0].sourceDetails['0'].map((part: { value: number }) => part.value)).toEqual([10, 10, 10]);
            expect(chart.props.series.every((entry: { label: string }) => entry.label.includes('Codex'))).toBe(true);
            expect(Object.values(chart.props.leads as Record<string, React.ReactElement<{ agentId: string }>>)
                .every(mark => mark.props.agentId === 'codex')).toBe(true);
        }
        // Without a producer-selected common monetary basis, source costs must not be stacked.
        const costScreen = await renderScreen(<UsageDailyWidget {...props} query={normalizeUsageQuery({ ...query, metric: 'cost' })}
            id="usage_daily" testID="cost" />);
        expect(costScreen.findAllByType(StackedSeriesChart).flatMap(chart => chart.props.series)
            .some((entry: { fillPattern?: string }) => entry.fillPattern === 'hatch')).toBe(false);
        const pricedScreen = await renderScreen(<UsageDailyWidget {...props} query={normalizeUsageQuery({ ...query, metric: 'cost' })}
            slice={{ ...slice, accounting: { ...slice.accounting!, costPresentation: { mode: 'auto', effectiveUsd: 3, currency: 'USD', source: 'provider_reported' } } }}
            id="usage_daily" testID="priced" />);
        expect(pricedScreen.findByType(StackedSeriesChart).props.series.map((entry: { points: { y: number }[] }) => entry.points[0]!.y)).toEqual([3]);
    });
    it('keeps partial historical range gaps unavailable in the mounted Daily and Rhythm bodies', async () => {
        const start = Date.parse('2024-04-21T22:00:00Z');
        const end = start + 3 * 86_400_000;
        const query = normalizeUsageQuery({ period: { startMs: start, endMs: end }, timeZoneOffsetMinutes: 120, granularity: 'day', includeActivity: true });
        const tokens = { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 5 };
        const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            v: 1, totals: { tokens, cost, eventCount: 1 },
            series: [{ bucketStartMs: start, bucketEndMs: start + 86_400_000, eventCount: 1, tokens, cost }],
            activity: { calendarDays: [{ date: '2024-04-22', eventCount: 1 }], weekdayHourBuckets: [] },
            coverage: { status: 'partial', reasons: ['incomplete_history'], sources: [], missingDimensions: [], ranked: [], range: { startMs: start, endMs: end, complete: false } },
        } }] }).results[0]!;
        const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const props = { query, slice, model, serverId: 'home' };
        const screen = await renderScreen(<>
            <UsageDailyWidget {...props} id="usage_daily" testID="daily" />
            <UsageRhythmWidget {...props} id="usage_rhythm" testID="rhythm" />
        </>);
        expect(screen.findByType(StackedSeriesChart).props.series[0].points.map((point: { y: number | null }) => point.y)).toEqual([5, null, null]);
        const calendar = screen.findByType(Heatmap).props.cells;
        expect(calendar.map((cell: { id: string; value: number | null }) => [cell.id, cell.value])).toEqual([
            ['2024-04-22', 1], ['2024-04-23', null], ['2024-04-24', null],
        ]);
        // Language is presentation, not a new accounting response or query identity.
        const previous = getPreferredLanguage();
        try {
            setPreferredLanguageFromSettings('fr');
            await preloadTranslations();
            await act(async () => screen.update(<>
                <UsageDailyWidget {...props} id="usage_daily" testID="daily" />
                <UsageRhythmWidget {...props} id="usage_rhythm" testID="rhythm" />
            </>));
            expect(screen.findByType(StackedSeriesChart).props.series[0].points[0].label).toBe(new Intl.DateTimeFormat('fr', {
                month: 'short', day: 'numeric', timeZone: 'UTC',
            }).format(Date.parse('2024-04-22')));
            expect(screen.findByType(Heatmap).props.cells[0].label).toBe(new Intl.DateTimeFormat('fr', {
                month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
            }).format(Date.parse('2024-04-22')));
        } finally {
            setPreferredLanguageFromSettings(previous);
            await preloadTranslations();
        }
    });
    it('preserves an explicit epoch start instead of converting it to an unbounded all-time query', () => {
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 86_400_000 }, timeZoneOffsetMinutes: 0 });
        expect(resolveUsageShownCalendarRange(query)?.startMs).toBe(0);
        expect(usagePeriodPhrase(query)).toBe(new Intl.DateTimeFormat(getPreferredLanguage(), {
            month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
        }).format(0));
    });
    it('bounds older all-time and activity-only responses by their witnessed dates without using source freshness', () => {
        const accounting = usageQaAccountingFixture();
        const all = normalizeUsageQuery({ period: { relative: 'all' }, timeZoneOffsetMinutes: 120 });
        expect(resolveUsageShownCalendarRange(all, accounting.coverage, accounting)).toMatchObject({
            startMs: accounting.contributions![0]!.observedAtMs,
            endMs: accounting.contributions!.reduce((latest, row) => Math.max(latest, row.observedAtMs), 0) + 1,
        });
        const older = { ...accounting, contributions: undefined, series: [] };
        expect(resolveUsageShownCalendarRange(normalizeUsageQuery({ period: { relative: '7days' }, timeZoneOffsetMinutes: 120 }),
            older.coverage, older)).toMatchObject({
            startMs: Date.parse('2026-10-04T22:00:00Z'), endMs: Date.parse('2026-10-11T22:00:00Z'),
        });
        expect(resolveUsageShownCalendarRange(all)).toBeNull();
    });
    it('labels an end-only historical query through its exclusive endpoint in the admitted offset', () => {
        const query = normalizeUsageQuery({ period: { endMs: Date.parse('2024-04-22T22:00:00Z') }, timeZoneOffsetMinutes: 120 });
        const end = new Intl.DateTimeFormat(getPreferredLanguage(), {
            month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
        }).format(Date.parse('2024-04-22'));
        expect(usagePeriodPhrase(query)).toBe(`${t('usage.allTime')} – ${end}`);
        expect(usagePeriodPhrase(normalizeUsageQuery({ period: {} }))).toBe(t('usage.allTime'));
    });
    it('uses the selected French app locale and admitted offset, not the host locale', async () => {
        const previous = getPreferredLanguage();
        try {
            setPreferredLanguageFromSettings('fr');
            await preloadTranslations();
            const query = normalizeUsageQuery({ period: { startMs: Date.parse('2024-04-21T22:00:00Z'), endMs: Date.parse('2024-04-22T22:00:00Z') }, timeZoneOffsetMinutes: 120 });
            expect(usagePeriodPhrase(query)).toBe(new Intl.DateTimeFormat('fr', {
                month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
            }).format(Date.parse('2024-04-22')));
        } finally {
            setPreferredLanguageFromSettings(previous);
            await preloadTranslations();
        }
    });
    it('labels a historical custom range by exact dates instead of a rolling nearest preset', () => {
        const query = normalizeUsageQuery({ period: { startMs: Date.UTC(2024, 3, 21, 22), endMs: Date.UTC(2024, 4, 2, 22) }, timeZoneOffsetMinutes: 120 });
        const label = usagePeriodPhrase(query);
        const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
        expect(label).toBe(`${date.format(new Date(Date.UTC(2024, 3, 22)))} – ${date.format(new Date(Date.UTC(2024, 4, 2)))}`);
    });
    it('exposes incomplete native history and unsupported sources even with available accounting transport', async () => {
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } });
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            v: 1, totals: { tokens: { total: 5, input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' }, eventCount: 1 },
            coverage: { status: 'partial', reasons: ['incomplete_history', 'unknown_token_categories'], sources: [
                { source: 'native:claude', path: 'native', status: 'partial', eventCount: 1, historyComplete: false },
                { source: 'native:gemini', path: 'native', status: 'unsupported', eventCount: 0 },
            ], missingDimensions: [], range: { startMs: 0, endMs: 1000, complete: false }, ranked: [] },
        } }] }).results[0]!;
        expect(readUsageCoverageGaps(slice, ['accounting']).map(gap => gap.source)).toEqual(['accounting', 'native:claude', 'native:gemini']);
        const screen = await renderScreen(<UsageCoverageLine slice={slice} sources={['accounting']} testID="coverage" />);
        expect(screen.getTextContent()).not.toContain('native:claude');
        expect(screen.getTextContent()).not.toContain('native:gemini');
        // A host without the Usage page's Sources detail keeps one quiet clause; the full wording lives in Sources.
        expect(screen.getTextContent()).toContain('Partial history');
        expect(screen.getTextContent()).not.toContain(t('usage.board.page.coverageReason_unknown_token_categories'));
        const detail = usageCoverageDescription(slice, ['accounting']);
        expect(detail).toContain(t('usage.board.page.coverageReason_unknown_token_categories'));
        expect(detail).toContain(t('usage.board.page.coverageReason_incomplete_history'));
        expect(detail).toContain(t('usage.board.sources.unsupported'));
    });
    it('does not treat an available transport without coverage metadata as complete history', () => {
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } });
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            v: 1, totals: { tokens: { total: 5, input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' }, eventCount: 1 },
        } }] }).results[0]!;
        expect(readUsageCoverageGaps(slice, ['accounting'])).toEqual([{ source: 'accounting', status: 'unknown' }]);
    });
});

describe('the allowance list holds its first-read room once', () => {
    const query = normalizeUsageQuery({});
    const pendingSlice = () => resolveUsagePageAggregation({ queries: [query], sources: [0, 1, 2].map(index => ({
        source: `quota:${JSON.stringify(QualifiedConnectedServiceUsageSourceV4Schema.parse({ bindingKind: 'account',
            ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: `acct-${index}` } }))}`,
        status: 'pending' as const })) }).results[0]!;
    it('reserves through the first reads, lets go when every account has answered, and never reserves for a re-read', async () => {
        const slice = pendingSlice();
        const hook = await renderHook(({ answered }: { answered: boolean }) => useUsageMeterListFirstReadReserve(slice, 3, answered, false),
            { initialProps: { answered: false } });
        expect(hook.getCurrent()?.minHeight).toBeGreaterThan(0);
        await hook.rerender({ answered: true });
        expect(hook.getCurrent()).toBeUndefined();
        // A later re-read puts accounts back to pending: the retained rows keep their height, no blank room is added.
        await hook.rerender({ answered: false });
        expect(hook.getCurrent()).toBeUndefined();
    });
});
