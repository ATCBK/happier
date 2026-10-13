import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { WidgetDefinitionV1Schema, type WidgetInputBindingsV1, type WidgetInstanceV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { renderScreen, renderHook, flushHookEffects } from '@/dev/testkit';
import { useConfiguredWidgetTarget } from '@/sync/domains/widgets/useConfiguredWidgetTarget';
import type { ConfiguredWidgetTargetResolution } from '@/sync/domains/widgets/widgetBinding';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary, createLayoutArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { buildWidgetDefinitionArtifactHeaderV1 } from '@happier-dev/protocol/widgets/widgetDefinitionArtifactV1';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { ProjectBuiltinWidgetBody } from '@/components/projects/widgets/ProjectBuiltinWidgetBody';
import { WidgetSurface } from './WidgetSurface';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { describeAuthoredWidgetDefinitionV1, readWidgetDescriptor, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { Text } from '@/components/ui/text/Text';
import { HostedHtmlSurfaceAdapter } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { readInputPath } from '@happier-dev/protocol/inputs';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { HappierDataMetric, StackedSeriesChart, type HappierSeries } from '@happier-dev/plugin-ui/presentation';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { readUsageWidgetPageContext, readUsageWidgetPageScope } from '@/components/settings/usage/usageWidgetPageContext';
import { ConfiguredWidgetRefusal } from '@/components/widgets/InstalledWidgetSurface';
import { SessionSurfaceItemV1Schema } from '@happier-dev/protocol/sessions/board';
import { createSessionBoardSourceAvailabilityResolver } from '@/components/sessions/board/sessionBoardItemPresentation';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import { loadPluginUiHostSupport } from '@/components/plugins/hostApi/loadPluginUiHostSupport';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { widgetProjectionOf, widgetInstalledPackage } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';

// Statically imported surface consumers reach Sync; install its external Socket boundary before that graph loads.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// The physical browser frame is the platform boundary; the bundle, renderer,
// viewer runtime, capability admission and bridge remain real.
vi.mock('@/components/browser/frame/BrowserViewFrame.web', () => ({
    BrowserViewFrame: () => React.createElement('BrowserViewFrame', { testID: 'html-copy-frame' }),
}));

installDisconnectedServerSocketBoundary();

it('mounts the exact installed app widget from a multi-machine Home union and retires on viewer loss', async () => {
    const http = createHomeHubArtifactHttpBoundary('viewer');
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://installed-widget-union.test', accountId: 'viewer', request: http.request });
    const viewer = getActiveServerAccountScope()!;
    const definition = { kind: 'installed', surface: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: 'latest' } } as const;
    const union = unionPluginUiProjections([
        { machineId: 'origin-a', serverId: viewer.serverId, phase: 'current', interactionEnabled: true,
            projection: widgetProjectionOf([{ ...definition.surface, target: 'app', homeDefault: 'shown' }], {
                [definition.surface.pluginId]: widgetInstalledPackage(definition.surface.pluginId, 'PRs & Issues'),
            }) },
        { machineId: 'origin-b', serverId: viewer.serverId, phase: 'current', interactionEnabled: true, projection: EMPTY_PLUGIN_UI_PROJECTION },
    ]);
    const runtime = { ...union, pluginBrowserProjection: null, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime() };
    const descriptor = readWidgetDescriptor(union.pluginUiProjection, definition);
    expect(descriptor).not.toBeNull();
    const screen = await renderScreen(<WidgetSurface scope={{ ...viewer, owner: { kind: 'home' } }}
        instance={{ v: 1, id: 'latest-copy', definition, bindings: {} }} descriptor={descriptor}
        providedContext={{}} appRuntime={runtime} recordRevision="latest:1" presentation="content"
        reference={<Text testID="latest-admitted-reference">Open PRs &amp; Issues</Text>} testID="latest-union" />);
    let disconnected = false;
    try {
        expect(screen.tree.root.findAllByType(ConfiguredWidgetRefusal)).toHaveLength(0);
        expect(screen.tree.root.findAllByProps({ testID: 'latest-admitted-reference' }).length).toBeGreaterThan(0);
        await React.act(async () => { await connection.dispose(); disconnected = true; });
        expect(screen.tree.root.findAllByProps({ testID: 'latest-admitted-reference' })).toHaveLength(0);
        expect(http.writes).toEqual([]);
    } finally { await screen.unmount(); if (!disconnected) await connection.dispose(); }
});

it.each([['artifact', 'home'], ['artifact', 'project'], ['inline', 'sessionBoard']] as const)('renders a saved builtin daily widget through %s on %s with viewer admission and retires its Resource on authority loss', async (kind, owner) => {
    const disposeActionLoader = await installRealActionExecutorModuleLoader();
    const native = readWidgetDescriptor(null, { kind: 'builtin', id: 'usage_daily' })!;
    const saved = WidgetDefinitionV1Schema.parse({ v: 1, id: 'daily-copy', name: 'Saved daily usage',
        body: { kind: 'builtin', id: 'usage_daily' }, inputs: native.inputs, inputSchema: native.inputSchema,
        sizeDeclaration: native.sizeDeclaration, provenance: { source: { kind: 'authored' } } });
    const http = createLayoutArtifactHttpBoundary('viewer', { artifactId: saved.id, kind: 'widget-definition.v1',
        defaultLayout: saved, parseLayout: value => WidgetDefinitionV1Schema.parse(value), buildHeader: buildWidgetDefinitionArtifactHeaderV1 });
    http.seed(saved);
    let total = 15;
    const start = Date.UTC(2026, 9, 10);
    const query = normalizeUsageQuery({ period: { startMs: start, endMs: start + 86_400_000 }, metric: 'tokens', breakdown: [] });
    const connection = await restoreServerAccountForTest({ serverUrl: `https://saved-builtin-${owner}.test`, accountId: 'viewer', request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/machines') return Response.json({ machines: [] });
        if (path !== '/v2/usage/query') return http.request(url, init);
        const tokens = { input: total - 5, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total };
        const cost = { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' };
        return Response.json({ v: 1, totals: { eventCount: 1, tokens, cost }, series: [{ bucketStartMs: start, bucketEndMs: start + 86_400_000, eventCount: 1, tokens, cost }] });
    } });
    const viewer = getActiveServerAccountScope();
    if (!viewer) throw new Error('Expected current viewer');
    const reference = kind === 'artifact' ? { kind, artifactId: saved.id } : { kind, definition: saved };
    const instance: WidgetInstanceV1 = { v: 1, id: 'daily-instance', definition: reference,
        bindings: Object.fromEntries(saved.inputs.fields.map(field => [field.path, { kind: 'value', value: StrictJsonValueSchema.parse(readInputPath(query, field.path)) }])) };
    // Shared Session content is an inline copy, never a foreign private Account reference.
    const scope: WidgetSurfaceRefV1 = { ...viewer, ...(kind === 'inline' ? { accountId: 'author' } : {}), owner: owner === 'home' ? { kind: owner }
        : owner === 'project' ? { kind: owner, projectId: 'project-one' } : { kind: owner, sessionId: 'destination' } };
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: null, serverId: null, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime() };
    let containingCurrent = true;
    const isCurrent = () => containingCurrent;
    const body = () => <InjectedAuthProvider credentials={connection.credentials}>
        <WidgetSurface scope={scope} admittedViewer={kind === 'inline' ? viewer : undefined} instance={instance} descriptor={describeAuthoredWidgetDefinitionV1(saved, reference)}
            providedContext={{}} appRuntime={runtime} isCurrent={isCurrent} recordRevision="fixture:1" presentation="content" testID="saved-daily" />
    </InjectedAuthProvider>;
    const screen = await renderScreen(body());
    const values = () => screen.tree.root.findAllByType(StackedSeriesChart).flatMap(chart => chart.props.series.flatMap((series: HappierSeries) => series.points.map(point => point.y)));
    let disconnected = false;
    try {
        await flushHookEffects({ cycles: 30 });
        await vi.waitFor(() => expect(values(), JSON.stringify(screen.tree.toJSON())).toContain(15));
        total = 30;
        await React.act(async () => { invalidateUsageQueryResources(); });
        await vi.waitFor(() => expect(values()).toContain(30));
        containingCurrent = false;
        await screen.update(body());
        expect(values()).not.toContain(30);
        containingCurrent = true;
        await screen.update(body());
        await vi.waitFor(() => expect(values()).toContain(30));
        await React.act(async () => { await connection.dispose(); disconnected = true; });
        await vi.waitFor(() => expect(values()).not.toContain(30));
        expect(http.writes).toEqual([]);
    } finally { await screen.unmount(); if (!disconnected) await connection.dispose(); disposeActionLoader(); invalidateUsageQueryResources(); }
});

it.each(['declarative', 'html', 'installed'] as const)('renders a published inline %s through Session Board presence and real WidgetSurface admission', async kind => {
    const { SessionWidgetHost } = await import('@/components/sessions/board/SessionWidgetHost');
    const http = createHomeHubArtifactHttpBoundary('viewer');
    const connection = await restoreServerAccountForTest({ serverUrl: `https://session-inline-${kind}.test`,
        serverIdentityId: `srv_session_inline_${kind}`, accountId: 'viewer', request: http.request });
    const viewer = getActiveServerAccountScope();
    if (!viewer) throw new Error('Expected current viewer');
    const session = createSessionFixture({ id: 'destination-session', serverId: viewer.serverId,
        access: createSessionAccessFixture('view') });
    storage.getState().applySessions([session]);
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'saved-copy', name: 'Independent result',
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
        inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
        body: kind === 'declarative' ? { kind, document: { version: 1, root: { kind: 'text', text: 'Published result' } } }
            : kind === 'html' ? { kind, source: artifactHtmlBundleFromBodyV1('<main>Published result</main>'), requestedCapabilities: { network: 'none' } }
            : { kind, surface: { pluginId: 'acme.missing', localId: 'widget' } } });
    const item = SessionSurfaceItemV1Schema.parse({ v: 1, title: definition.name, frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'widget', instance: { v: 1, id: 'published-copy', definition: { kind: 'inline', definition }, bindings: {} } } });
    vi.stubGlobal('location', { origin: 'https://app.happier.dev' });
    const body = (executableCurrentness: 'current' | 'stale') => <InjectedAuthProvider credentials={connection.credentials}>
        <SessionWidgetHost serverId={viewer.serverId} sessionId="destination-session"
            item={{ itemId: 'published-copy', revision: 'fixture:1', state: { kind: 'ready', item } }}
            resolveSourceAvailability={createSessionBoardSourceAvailabilityResolver({ hostedHtmlRendererAvailable: true })}
            host="details" primaryHost="details" density="compact" canEdit={false} executableCurrentness={executableCurrentness} testID="published-copy" />
    </InjectedAuthProvider>;
    const screen = await renderScreen(body('current'));
    try {
        if (kind === 'declarative') await vi.waitFor(() => expect(screen.getTextContent()).toContain('Published result'));
        else if (kind === 'html') {
            await React.act(async () => { await loadPluginUiHostSupport(); });
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(screen.tree.root.findAllByType(HostedHtmlSurfaceAdapter), JSON.stringify(screen.tree.toJSON())).toHaveLength(1);
            });
            expect(screen.tree.root.findByType(HostedHtmlSurfaceAdapter).props.source).toEqual(definition.body.kind === 'html' ? definition.body.source : null);
            await vi.waitFor(() => expect(screen.tree.root.findAllByProps({ testID: 'html-copy-frame' }).length).toBeGreaterThan(0));
            await screen.update(body('stale'));
            await vi.waitFor(() => expect(screen.tree.root.findAllByType(HostedHtmlSurfaceAdapter)).toHaveLength(0));
            expect(screen.tree.root.findAllByProps({ testID: 'html-copy-frame' })).toHaveLength(0);
        } else {
            await vi.waitFor(() => expect(screen.tree.root.findAllByType(WidgetSurface)).toHaveLength(1));
            expect(screen.tree.root.findAllByType(HostedHtmlSurfaceAdapter)).toHaveLength(0);
            expect(screen.tree.root.findAllByType(SurfaceStateCard).some(node => node.props.kind === 'unavailable')).toBe(true);
        }
        expect(http.writes).toEqual([]);
    } finally { await screen.unmount(); await connection.dispose(); vi.unstubAllGlobals(); }
});

it.each([
    ['follow', 'corePage'], ['pin', 'corePage'], ['pin', 'home'], ['project-follow', 'project'], ['session-follow', 'corePage'],
] as const)('renders Usage through real %s admission on an unmaterialized %s host', async (bindingKind, host) => {
    const disposeActionLoader = await installRealActionExecutorModuleLoader();
    const http = createHomeHubArtifactHttpBoundary('viewer');
    const connection = await restoreServerAccountForTest({ serverUrl: `https://usage-${bindingKind}-admission.test`,
        accountId: 'viewer', request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/machines') return Response.json({ machines: [] });
            if (path !== '/v2/usage/query') return http.request(url, init);
            const totals: UsageAnalyticsQueryResponse['totals'] = { eventCount: 1,
                tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
                cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } };
            return Response.json({ v: 1, totals, breakdowns: { agent: [{ key: 'codex', ...totals }] } });
        } });
    const account = getActiveServerAccountScope();
    if (!account) throw new Error('Expected current viewer Account');
    const scope: WidgetSurfaceRefV1 = { ...account, owner: host === 'home' ? { kind: 'home' }
        : host === 'project' ? { kind: 'project', projectId: 'project-one' }
        : { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } };
    const query = normalizeUsageQuery({ period: { startMs: 1000 }, agents: bindingKind === 'pin' ? ['codex'] : [], metric: 'tokens',
        projects: host === 'project' ? ['project-one'] : [], session: bindingKind === 'session-follow' ? ['session-one'] : null });
    const definition = { kind: 'builtin', id: 'usage_period_summary' } as const;
    const descriptor = readWidgetDescriptor(null, definition)!;
    const bindings: WidgetInputBindingsV1 = Object.fromEntries(descriptor.inputs!.fields.map(field => [field.path,
        (bindingKind === 'follow' || bindingKind === 'session-follow') && field.contextMode === 'follow'
            || bindingKind === 'project-follow' && field.path === 'projects' ? { kind: 'context', slot: field.path }
            : { kind: 'value', value: StrictJsonValueSchema.parse(readInputPath(query, field.path)) }]));
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: null, serverId: null, platform: 'web' as const,
        accountLifetime: captureActiveServerAccountScopeLifetime() };
    const body = (context: ReturnType<typeof readUsageWidgetPageContext>) => <InjectedAuthProvider credentials={connection.credentials}>
        <WidgetSurface scope={scope} instance={{ v: 1, id: 'usage-admission', definition, bindings }} descriptor={descriptor}
            providedContext={context} appRuntime={runtime} recordRevision="fixture:1" presentation="content" testID="usage-admission" />
    </InjectedAuthProvider>;
    const pageContext = readUsageWidgetPageContext(readUsageWidgetPageScope(query));
    const providedContext = host === 'home' ? {} : host === 'project' ? { projects: pageContext.projects! } : pageContext;
    const screen = await renderScreen(body(providedContext));
    try {
        await flushHookEffects({ cycles: 30 });
        await vi.waitFor(() => {
            expect(screen.tree.root.findAllByType(ConfiguredWidgetRefusal).map(node => node.props.resolution)).toEqual([]);
            expect(screen.tree.root.findAllByType(HappierDataMetric).map(node => node.props.value)).toContain(15);
        });
        if (bindingKind === 'follow') {
            // The page can retain a selected Agent absent from this period's choice inventory.
            const changed = normalizeUsageQuery({ ...query, agents: ['claude'] });
            await screen.update(body(readUsageWidgetPageContext(readUsageWidgetPageScope(changed))));
            await vi.waitFor(() => expect(screen.tree.root.findAllByType(ConfiguredWidgetRefusal)).toEqual([]));
            expect(screen.tree.root.findAllByType(HappierDataMetric).map(node => node.props.value)).toContain(15);
        }
        expect(http.writes).toEqual([]);
    } finally {
        await screen.unmount(); await connection.dispose(); disposeActionLoader(); invalidateUsageQueryResources();
    }
});

it('consumes a live U5 widget in the generic Session surface through ordinary usage Resource admission', async () => {
    const http = createHomeHubArtifactHttpBoundary('viewer');
    let total = 15;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://session-usage-visual.test',
        serverIdentityId: 'srv_session_usage_visual', accountId: 'viewer', request: async (url, init) => {
            if (new URL(String(url)).pathname !== '/v2/usage/query') return http.request(url, init);
            const value: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
                tokens: { input: total - 5, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total },
                cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } };
            return Response.json(value);
        } });
    const account = getActiveServerAccountScope();
    if (!account) throw new Error('Expected current viewer Account');
    const scope: WidgetSurfaceRefV1 = { ...account, owner: { kind: 'sessionBoard', sessionId: 'session-one' } };
    const query = normalizeUsageQuery({ period: { startMs: 1000 }, metric: 'tokens', breakdown: [] });
    const definition = { kind: 'builtin', id: 'usage_period_summary' } as const;
    const descriptor = readWidgetDescriptor(null, definition);
    if (!descriptor?.inputs) throw new Error('Expected U5 widget input descriptor');
    const bindings: WidgetInputBindingsV1 = {};
    for (const field of descriptor.inputs.fields) {
        bindings[field.path] = { kind: 'value', value: StrictJsonValueSchema.parse(readInputPath(query, field.path)) };
    }
    const instance: WidgetInstanceV1 = { v: 1, id: 'live-usage', definition, bindings };
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: null, serverId: null, platform: 'web' as const,
        accountLifetime: captureActiveServerAccountScopeLifetime() };
    const screen = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}>
        <WidgetSurface scope={scope} instance={instance} descriptor={descriptor}
            providedContext={{}} appRuntime={runtime} recordRevision="fixture:1" presentation="content" testID="live-usage" />
    </InjectedAuthProvider>);
    const shownValues = () => screen.tree.root.findAllByType(HappierDataMetric).map(node => node.props.value);
    let disconnected = false;
    try {
        await flushHookEffects({ cycles: 30 });
        await vi.waitFor(() => expect(shownValues(), JSON.stringify(screen.tree.toJSON())).toContain(15));
        total = 30;
        await React.act(async () => { invalidateUsageQueryResources(); });
        await flushHookEffects({ cycles: 30 });
        await vi.waitFor(() => expect(shownValues()).toContain(30));
        await React.act(async () => { await connection.dispose(); disconnected = true; });
        await vi.waitFor(() => expect(shownValues()).not.toContain(30));
    } finally { await screen.unmount(); if (!disconnected) await connection.dispose(); invalidateUsageQueryResources(); }
});

it('keeps an input-options read pending, then preserves the canonical terminal refusal', async () => {
    const disposeActionLoader = await installRealActionExecutorModuleLoader();
    const http = createHomeHubArtifactHttpBoundary('actor');
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://usage-widget-options.test', accountId: 'actor', request: http.request });
    const scope: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'actor', owner: { kind: 'home' } };
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'options-reader', name: 'Options reader',
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
        inputs: { fields: [{ path: 'home', title: 'Home', widget: 'select', optionsSourceId: 'sessions.spawn.servers.available' }] },
        inputSchema: { type: 'object', properties: { home: { type: 'string' } }, additionalProperties: false },
        provenance: { source: { kind: 'authored' } },
        body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'A declared options reader' } } } });
    const reference = { kind: 'inline' as const, definition };
    const instance: WidgetInstanceV1 = { v: 1, id: 'options', definition: reference, bindings: { home: { kind: 'value', value: connection.home.id } } };
    const descriptor = describeAuthoredWidgetDefinitionV1(definition, reference, null);
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: null, serverId: null, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime() };
    const observed: ConfiguredWidgetTargetResolution[] = [];
    const hook = await renderHook(() => {
        const state = useConfiguredWidgetTarget({ scope, instance, descriptor,
            providedContext: {}, appRuntime: runtime });
        observed.push(state);
        return state;
    });
    try {
        expect(observed.find(state => state.status !== 'ready' && state.reasonCode === 'widget_input_options_loading'))
            .toMatchObject({ status: 'loading' });
        await vi.waitFor(() => expect(hook.getCurrent().status).not.toBe('loading'));
        // This inline definition is not published in the Account catalog. The real Action
        // refuses it after discovery; that terminal fact must not become permanent loading.
        expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', reasonCode: 'input_type_consumer_unavailable' });
    } finally { await hook.unmount(); await connection.dispose(); disposeActionLoader(); }
});

it('renders an HTML copy through the shared sandbox with its copied policy and retires on lost viewer admission', async () => {
    const http = createHomeHubArtifactHttpBoundary('viewer');
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://html-widget-copy.test', serverIdentityId: 'srv_html-widget-home', accountId: 'viewer', request: http.request });
    // The advertised identity adopts the routing slug. Layout admission uses
    // the canonical Account scope, not the earlier profile's transport alias.
    const viewer = getActiveServerAccountScope();
    if (!viewer) throw new Error('Expected restored viewer Account');
    const scope: WidgetSurfaceRefV1 = { ...viewer, owner: { kind: 'home' } };
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'html', name: 'HTML copy',
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
        provenance: { source: { kind: 'authored' } }, networkOverride: { network: 'none' },
        body: { kind: 'html', source: artifactHtmlBundleFromBodyV1('<main>Saved HTML</main>'), requestedCapabilities: { network: 'open', actions: ['session.board.get'] } } });
    const instance: WidgetInstanceV1 = { v: 1, id: 'copy', definition: { kind: 'inline', definition }, bindings: {} };
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: null, serverId: null, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime() };
    let current = true;
    const body = () => <WidgetSurface scope={scope} instance={instance} descriptor={null} providedContext={{}}
        appRuntime={runtime} presentation="content" recordRevision="copy-revision" isCurrent={() => current} testID="html-copy" />;
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    vi.stubGlobal('location', { origin: 'https://app.happier.dev' });
    try {
        screen = await renderScreen(body());
        await vi.waitFor(() => expect(screen!.tree.root.findAllByType(HostedHtmlSurfaceAdapter)).toHaveLength(1));
        const adapter = screen.tree.root.findByType(HostedHtmlSurfaceAdapter);
        expect(adapter.props.requestedCapabilities).toEqual({ actions: ['session.board.get'], network: 'none' });
        await React.act(async () => { await loadPluginUiHostSupport(); });
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen!.tree.root.findAllByProps({ testID: 'html-copy-frame' }).length,
                JSON.stringify(screen!.tree.toJSON())).toBeGreaterThan(0);
        });
        instance.networkOverride = { networkOrigins: ['https://copy.example.com'] };
        await screen.update(body());
        expect(screen.tree.root.findByType(HostedHtmlSurfaceAdapter).props.requestedCapabilities).toEqual({ actions: ['session.board.get'], networkOrigins: ['https://copy.example.com'] });
        current = false;
        await screen.update(body());
        expect(screen.tree.root.findAllByProps({ testID: 'html-copy-frame' })).toHaveLength(0);
    } finally { await screen?.unmount(); await connection.dispose(); vi.unstubAllGlobals(); }
});

it('renders a declared native app-read fixture and removes it when its Account read retires', async () => {
    const http = createHomeHubArtifactHttpBoundary('actor');
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://native-app-widget.test', accountId: 'actor', request: http.request });
    const scope: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'actor', owner: { kind: 'home' } };
    const instance: WidgetInstanceV1 = { v: 1, id: 'app-copy', definition: { kind: 'builtin', id: 'session_summary' }, bindings: { period: { kind: 'value', value: 7 } } };
    const descriptor: WidgetCandidate = { ...readWidgetDescriptor(null, instance.definition)!, target: 'app',
        inputs: { fields: [{ path: 'period', title: 'Period', widget: 'integer', required: true }] },
        inputSchema: { type: 'object', properties: { period: { type: 'integer' } }, required: ['period'], additionalProperties: false } };
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: null, serverId: null, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime() };
    let current = true;
    let pending = false;
    const body = () => <WidgetSurface scope={scope} instance={instance} descriptor={descriptor}
        providedContext={{}} appRuntime={runtime} presentation="content" recordRevision="same-instance" isCurrent={() => current} isReadPending={() => pending}
        reference={<Text testID="native-app-read">7 days</Text>} testID="native-app-widget" />;
    const screen = await renderScreen(body());
    try {
        expect(screen.tree.root.findAllByProps({ testID: 'native-app-read' }).length).toBeGreaterThan(0);
        current = false;
        pending = true;
        await screen.update(body());
        expect(screen.tree.root.findAllByProps({ testID: 'native-app-read' })).toHaveLength(0);
        // A read still pending keeps the card's first-load rows (one loading look per card), never a state card.
        expect(screen.tree.root.findAllByProps({ testID: 'native-app-widget-state-rows' }).length).toBeGreaterThan(0);
        expect(screen.tree.root.findAllByType(SurfaceStateCard)).toHaveLength(0);
        pending = false;
        await screen.update(body());
        expect(screen.tree.root.findByType(SurfaceStateCard).props.kind).toBe('unavailable');
    } finally { await screen.unmount(); await connection.dispose(); }
});

it('does not mount native readers while the containing document admission is suspended', async () => {
    const http = createHomeHubArtifactHttpBoundary('actor');
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://native-widget.test', accountId: 'actor', request: http.request });
    const checkout = { id: 'checkout', serverId: connection.home.id, machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
    const scope: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'actor', owner: { kind: 'project', projectId: 'project' } };
    const instance: WidgetInstanceV1 = { v: 1, id: 'about', definition: { kind: 'builtin', id: 'project_about' },
        bindings: { checkout: { kind: 'context', slot: 'checkout' } } };
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: 'machine', serverId: connection.home.id, platform: 'web' as const,
        accountLifetime: captureActiveServerAccountScopeLifetime() };
    let current = true;
    let groupBindings: WidgetInputBindingsV1 | undefined;
    const body = () => <WidgetSurface scope={scope} instance={instance} descriptor={readWidgetDescriptor(null, instance.definition)}
        providedContext={{ checkout: [checkout] }} appRuntime={runtime} presentation="content" recordRevision="same-instance"
        groupBindings={groupBindings}
        isCurrent={() => current} testID="native-widget" />;
    const screen = await renderScreen(body());
    try {
        expect(screen.tree.root.findAllByType(ProjectBuiltinWidgetBody)).toHaveLength(1);
        groupBindings = { checkout: { kind: 'value', value: { ...checkout, rootPath: '/forged' } } };
        await screen.update(body());
        expect(screen.tree.root.findAllByType(ProjectBuiltinWidgetBody)).toHaveLength(0);
        groupBindings = { checkout: { kind: 'value', value: checkout } };
        await screen.update(body());
        expect(screen.tree.root.findAllByType(ProjectBuiltinWidgetBody)).toHaveLength(1);
        current = false;
        await screen.update(body());
        expect(screen.tree.root.findAllByType(ProjectBuiltinWidgetBody)).toHaveLength(0);
        current = true;
        await screen.update(body());
        expect(screen.tree.root.findAllByType(ProjectBuiltinWidgetBody)).toHaveLength(1);
    } finally { await screen.unmount(); await connection.dispose(); }
});
