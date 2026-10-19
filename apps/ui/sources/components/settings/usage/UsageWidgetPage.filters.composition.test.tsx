import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema, UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol';
import { getStorage } from '@/sync/domains/state/storage';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { buildWidgetSurfaceArtifactHeaderV1, buildWidgetSurfaceArtifactIdV1, WidgetAreaLayoutV1Schema,
    WIDGET_SURFACE_ARTIFACT_KIND_V1, type WidgetAreaLayoutV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createLayoutArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader, type CurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { createCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { executeCurrentUiContextAction, registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { WidgetAreaLayoutBar } from '@/components/widgets/area/WidgetAreaLayoutBar';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { WidgetSurface } from '@/components/widgets/surface/WidgetSurface';
import { UsageWidgetBody } from './widgets/UsageWidgetBody';
import { UsagePeriodSummaryWidget } from './widgets/UsagePeriodSummaryWidget';
import { UsageWidgetPage } from './UsageWidgetPage';
import { UsageFilterBar } from './UsageFilterBar';
import { getUsagePeriodDefinition } from '@/sync/api/account/usagePeriods';
import { t } from '@/text';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/settings/usage', segments: ['(app)', 'settings', 'usage'] }).module;
});

const totals: UsageAnalyticsQueryResponse['totals'] = { eventCount: 1,
    tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } };
const accounting: UsageAnalyticsQueryResponse = { v: 1, totals, breakdowns: {
    machine: ['machine-a', 'machine-b', 'machine-c', ...Array.from({ length: 24 }, (_, index) => `machine-${index}`)].map(key => ({ key, ...totals })),
    source: ['native', 'runtime', 'legacy'].map(key => ({ key, ...totals })),
    project: ['project-a', 'project-b', 'project-c', ...Array.from({ length: 24 }, (_, index) => `project-${index}`)].map(key => ({ key, ...totals })),
}, engineTimeline: [{ bucketStartMs: 1000, bucketEndMs: 2000,
    leaders: ['claude:remote', 'codex:local', 'pi'].map(key => ({ key, ...totals })) }] };
let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let reader: CurrentUiContextReader | null = null;
let unregister: (() => void) | undefined;

function CurrentContextPort() {
    reader = useOptionalCurrentUiContextReader();
    React.useEffect(() => {
        if (!reader) return;
        const current = reader;
        unregister = registerCurrentUiContextActionPort(surface => createCurrentUiContextVoiceToolPort({
            reader: current, invocationSurface: surface, readProjection: () => null, readNavigationBinding: () => null,
        }));
        return unregister;
    }, [reader]);
    return null;
}

afterEach(async () => {
    standardCleanup(); unregister?.(); unregister = undefined; reader = null;
    retireActiveServerAccountScopeLifetime(); invalidateUsageQueryResources(); await home?.dispose(); home = undefined;
});

describe('mounted Usage page scope commands', () => {
    it.each(['overview', 'work'])('admits the personalized %s once and selects from a closing menu across a page republish', async layoutId => {
        const selectedRoutes: string[] = [];
        const inventoryRead = createDeferred<void>();
        const inventoryStarted = createDeferred<void>();
        let artifact: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | undefined;
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-page-layout-link.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] })
                : request.path === '/v2/usage/query' ? Response.json(accounting)
                : request.path === '/v1/artifacts' && request.method === 'GET'
                    ? (inventoryStarted.resolve(), inventoryRead.promise.then(() => artifact?.request(request.url, { method: request.method })))
                    : artifact?.request(request.url, { method: request.method }) });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const surface: WidgetSurfaceRefV1 = { serverId: server.id, accountId: 'account-a',
            owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId } };
        const query = normalizeUsageQuery({});
        const layout = WidgetAreaLayoutV1Schema.parse({ v: 1, surface, items: [{ kind: 'widget', instance: {
            v: 1, id: 'work-only', definition: { kind: 'builtin', id: 'usage_period_summary' },
            bindings: Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined).map(([path, value]) => [path, { kind: 'value', value }])),
        } }] });
        artifact = createLayoutArtifactHttpBoundary('account-a', { artifactId: buildWidgetSurfaceArtifactIdV1(surface),
            kind: WIDGET_SURFACE_ARTIFACT_KIND_V1, defaultLayout: layout, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
            buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
        artifact.seed(layout);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><UsageWidgetPage initialFilters={{ layoutId, period: '7days', metric: 'cost', costMode: 'auto', focus: null }}
                    onLayoutChange={layoutId => selectedRoutes.push(layoutId)} />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        await inventoryStarted.promise;
        await flushHookEffects({ cycles: 10 });
        // The selected document is authoritative independently of the slow inventory.
        expect.soft(screen.findAllByType(WidgetSurface).map(node => node.props.instance.id)).toEqual(['work-only']);
        expect.soft(Boolean(screen.findHostByTestId('usage-area.unavailable'))).toBe(false);
        expect.soft(Boolean(screen.findHostByTestId('usage-area.loading'))).toBe(false);
        expect.soft(screen.findAllByType(WidgetAreaLayoutBar)).toHaveLength(0);
        inventoryRead.resolve();
        await vi.waitFor(() => expect(screen.findByType(WidgetAreaLayoutBar).props.selectedId).toBe(layoutId));
        const views = screen.findByType(WidgetAreaLayoutBar).props.layouts;
        expect(views).toHaveLength(8);
        expect(new Set(views.map((view: { id: string }) => view.id)).size).toBe(8);
        expect(views.filter((view: { id: string }) => view.id === layoutId)).toEqual([
            expect.objectContaining({ isPreset: true, edited: true }),
        ]);
        expect(screen.findAllByType(WidgetSurface).map(node => node.props.instance.id)).toEqual(['work-only']);
        await act(async () => {
            screen.findHostByTestId('usage-views')!.props.onLayout({ nativeEvent: { layout: { width: 300, height: 40 } } });
            screen.findByTestId('usage-views.tabs:viewport')!.props.onLayout({ nativeEvent: { layout: { width: 200, height: 40 } } });
            screen.findByTestId('usage-views.tabs:strip')!.props.onLayout({ nativeEvent: { layout: { width: 520, height: 40 } } });
        });
        await screen.pressByTestIdAsync('usage-views.current');
        const menu = screen.findAllByType(DropdownMenu).find(node => node.props.items.some((item: { id: string }) => item.id === 'overview'))!;
        const queuedSelection = menu.props.onSelect;
        // DropdownMenu closes before its deferred selection callback. The page can
        // republish in between (for example, after the mounted route binding updates).
        await act(async () => { menu.props.onOpenChange(false); });
        await screen.update(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><UsageWidgetPage initialFilters={{ layoutId, period: '7days', metric: 'cost', costMode: 'auto', focus: null }}
                    onLayoutChange={layoutId => selectedRoutes.push(layoutId)} />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const nextLayoutId = layoutId === 'overview' ? 'costs' : 'overview';
        await act(async () => { queuedSelection(nextLayoutId); });
        await vi.waitFor(() => expect(screen.findByType(WidgetAreaLayoutBar).props.selectedId).toBe(nextLayoutId));
        expect(selectedRoutes).toEqual([nextLayoutId]);
        // The page's filter bar names the scope its widgets follow; no frame repeats "This page".
        await vi.waitFor(() => expect(screen.findAllByType(WidgetSurface).length).toBeGreaterThan(1));
        expect(screen.findByType(UsageFilterBar).props.metric).toBe('cost');
        expect(screen.getTextContent()).not.toContain(t('widgetAdd.thisPage'));
        await screen.unmount();
    });
    it('retains a large toolbar inventory, toggles dimensions through UI and agent commands and refuses retired descriptors', async () => {
        let artifact: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | undefined;
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-page-filters.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] })
                : request.path === '/v2/usage/query' ? (() => {
                    const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
                    const select = <T extends { key: string }>(rows: readonly T[], selected: readonly string[], engine = false) =>
                        selected.length ? rows.filter(row => selected.includes(engine ? row.key.split(':')[0]! : row.key)) : rows;
                    return Response.json({ ...accounting, breakdowns: {
                        machine: select(accounting.breakdowns!.machine!, query.filters?.machineIds ?? []),
                        source: select(accounting.breakdowns!.source!, query.filters?.sources ?? []),
                        project: select(accounting.breakdowns!.project!, query.filters?.projectKeys ?? []),
                    }, engineTimeline: accounting.engineTimeline!.map(bucket => ({ ...bucket, leaders: select(bucket.leaders, query.filters?.agentIds ?? [], true) })) });
                })()
                : artifact?.request(request.url, { method: request.method }) });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const surface: WidgetSurfaceRefV1 = { serverId: server.id, accountId: 'account-a',
            owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } };
        const followed = Object.fromEntries(['period', 'agents', 'machines', 'projects', 'sources', 'session', 'costBasis']
            .map(slot => [slot, { kind: 'context' as const, slot }]));
        const layout = WidgetAreaLayoutV1Schema.parse({ v: 1, surface, items: [
            { kind: 'group', id: 'following', children: [{ kind: 'widget', instance: { v: 1, id: 'following-body',
                definition: { kind: 'builtin', id: 'usage_period_summary' }, bindings: { ...followed,
                    metric: { kind: 'value', value: 'tokens' }, breakdown: { kind: 'value', value: ['agent'] } } } }] },
            { kind: 'group', id: 'pinned', context: { period: { kind: 'value', value: { startMs: 1000, endMs: 2000 } } }, children: [{ kind: 'widget', instance: { v: 1, id: 'pinned-body',
                definition: { kind: 'builtin', id: 'usage_period_summary' }, bindings: { ...followed,
                    metric: { kind: 'value', value: 'cost' }, breakdown: { kind: 'value', value: ['model'] } } } }] },
        ] });
        artifact = createLayoutArtifactHttpBoundary('account-a', { artifactId: buildWidgetSurfaceArtifactIdV1(surface),
            kind: WIDGET_SURFACE_ARTIFACT_KIND_V1, defaultLayout: layout, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
            buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
        artifact.seed(layout);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><UsageWidgetPage />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        await flushHookEffects({ cycles: 40 });
        const published = await executeCurrentUiContextAction({ actionId: 'ui.current_context.read', input: {}, context: { surface: 'ui' } });
        expect(published).toMatchObject({ ok: true, result: { entity: { kind: 'usage_summary' } } });
        const invoke = async (title: string) => {
            const descriptor = reader?.readCurrentUiContext()?.commands.find(command => command.title === title);
            expect(descriptor, `mounted command: ${title}`).toBeDefined();
            await act(async () => {
                const result = await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
                    input: { commandId: descriptor!.id }, context: { surface: 'ui' } });
                expect(result.ok).toBe(true);
            });
            await flushHookEffects({ cycles: 30 });
            return descriptor!.id;
        };
        const chip = (field: string) => screen.findAllByType(SelectionListFilterChip)
            .find(node => node.props.filter.id === field)!.props.filter;
        const choice = (field: string, value: string) => chip(field).options.find((option: { id: string }) => option.id === value)!.label;
        const snapshot = reader!.readCurrentUiContext()!;
        const toolbarTitles = ['agents', 'machines', 'projects', 'sources'].flatMap(field =>
            chip(field).options.map((option: { label: string }) => `${chip(field).label}: ${option.label}`));
        expect(snapshot.commands.map(command => command.title)).toEqual(expect.arrayContaining(toolbarTitles));
        expect(snapshot.commands.length).toBeGreaterThan(32);
        expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeGreaterThan(8_192);
        await invoke(`${chip('machines').label}: ${choice('machines', 'machine-23')}`);
        expect(screen.findAllByType(UsageWidgetBody).every(node => normalizeUsageQuery(node.props.input).machines.includes('machine-23'))).toBe(true);
        await act(async () => { await chip('machines').onChange('machine-23'); });
        await flushHookEffects({ cycles: 30 });
        await act(async () => { await chip('projects').onChange('project-23'); });
        await flushHookEffects({ cycles: 30 });
        expect(screen.findAllByType(UsageWidgetBody).every(node => normalizeUsageQuery(node.props.input).projects.includes('project-23'))).toBe(true);
        await invoke(`${chip('projects').label}: ${choice('projects', 'project-23')}`);
        expect(screen.findAllByType(UsageWidgetBody).every(node => normalizeUsageQuery(node.props.input).projects.length === 0)).toBe(true);
        // UI scope intents must obey the same Action admission as agent commands.
        const settings = getStorage().getState().settings;
        const scope = { serverId: server.id, accountId: 'account-a' };
        const previousInputs = screen.findAllByType(UsageWidgetBody).map(node => normalizeUsageQuery(node.props.input));
        const viewBar = screen.findByType(WidgetAreaLayoutBar);
        const previousLayout = viewBar.props.selectedId;
        await act(async () => {
            getStorage().getState().applySettingsForScope(scope, { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
                v: 1, actions: { 'ui.current_context.command.invoke': { disabledSurfaces: ['ui'] } },
            }) }, 2);
            await chip('agents').onChange('claude');
            chip('costBasis').onChange('reported');
            screen.findAllByType(SegmentedTabBar).find(node => node.props.testIDPrefix === 'usage-filters.period')!
                .props.onSelectTab('30days');
            viewBar.props.onSelect(viewBar.props.layouts.find((layout: { id: string }) => layout.id !== previousLayout)!.id);
        });
        await flushHookEffects({ cycles: 20 });
        expect(screen.findAllByType(UsageWidgetBody).every(node => normalizeUsageQuery(node.props.input).agents.length === 0)).toBe(true);
        expect(screen.findAllByType(UsageWidgetBody).map(node => normalizeUsageQuery(node.props.input))).toEqual(previousInputs);
        expect(screen.findByType(WidgetAreaLayoutBar).props.selectedId).toBe(previousLayout);
        await act(async () => { getStorage().getState().applySettingsForScope(scope, settings, 3); });
        await flushHookEffects({ cycles: 10 });
        // Losing the mounted dispatcher must not fall back to a raw page setter.
        unregister?.();
        await act(async () => { await chip('agents').onChange('claude'); });
        await flushHookEffects({ cycles: 10 });
        expect(screen.findAllByType(UsageWidgetBody).every(node => normalizeUsageQuery(node.props.input).agents.length === 0)).toBe(true);
        const currentReader = reader!;
        unregister = registerCurrentUiContextActionPort(surface => createCurrentUiContextVoiceToolPort({
            reader: currentReader, invocationSurface: surface, readProjection: () => null, readNavigationBinding: () => null,
        }));
        const oldId = await invoke(`${chip('agents').label}: ${choice('agents', 'codex')}`);
        expect(chip('agents').options.map((option: { id: string }) => option.id)).toEqual(expect.arrayContaining(['claude', 'codex', 'pi']));
        await act(async () => { await chip('agents').onChange('claude'); });
        await flushHookEffects({ cycles: 30 });
        await invoke(`${chip('machines').label}: ${choice('machines', 'machine-a')}`);
        await invoke(`${chip('sources').label}: ${choice('sources', 'native')}`);
        await invoke(`${chip('projects').label}: ${choice('projects', 'project-a')}`);
        const bodies = () => screen.findAllByType(UsageWidgetBody).map(node => normalizeUsageQuery(node.props.input));
        // Published Actions use the page's semantic cost-basis label, not a raw
        // translation-key interpolation (API-equivalent has no usage.<id> key).
        await invoke(choice('costBasis', 'reported'));
        expect(bodies().every(input => input.costBasis === 'reported')).toBe(true);
        expect(bodies()).toHaveLength(2);
        for (const input of bodies()) expect(input).toMatchObject({ agents: ['claude', 'codex'], machines: ['machine-a'],
            sources: ['native'], projects: ['project-a'] });
        expect(bodies()).toEqual(expect.arrayContaining([
            expect.objectContaining({ period: { startMs: 1000, endMs: 2000 }, metric: 'cost', breakdown: [] }),
            expect.objectContaining({ metric: 'tokens', breakdown: [] }),
        ]));
        const shownQueries = () => screen.findAllByType(UsagePeriodSummaryWidget).map(node => normalizeUsageQuery(node.props.query));
        expect(shownQueries()).toHaveLength(2);
        for (const query of shownQueries()) expect(query).toMatchObject({ agents: ['claude', 'codex'], machines: ['machine-a'],
            sources: ['native'], projects: ['project-a'] });
        const previousFollowingPeriod = shownQueries().find(query => query.metric === 'tokens')!.period;
        await invoke(t(getUsagePeriodDefinition('30days').translationKey));
        expect(shownQueries().find(query => query.metric === 'tokens')!.period).not.toEqual(previousFollowingPeriod);
        expect(shownQueries().find(query => query.metric === 'cost')).toMatchObject({
            period: { startMs: 1000, endMs: 2000 }, metric: 'cost', breakdown: [],
        });
        const allAgents = chip('agents').options[0].label;
        await invoke(`${chip('agents').label}: ${allAgents}`);
        expect(bodies().every(input => input.agents.length === 0)).toBe(true);
        expect(bodies().every(input => input.machines[0] === 'machine-a')).toBe(true);
        await invoke(`${chip('agents').label}: ${choice('agents', 'pi')}`);
        await invoke(`${chip('agents').label}: ${choice('agents', 'pi')}`);
        expect(bodies().every(input => input.agents.length === 0)).toBe(true);
        const stale = await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
            input: { commandId: oldId }, context: { surface: 'ui' } });
        expect(stale).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        expect(bodies().every(input => input.agents.length === 0)).toBe(true);
        const currentId = reader!.readCurrentUiContext()!.commands[0]!.id;
        await act(async () => retireActiveServerAccountScopeLifetime());
        const retired = await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
            input: { commandId: currentId }, context: { surface: 'ui' } });
        expect(retired.ok).toBe(false);
    });
});
