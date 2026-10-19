import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { DEFAULT_CURATED_MARKETPLACE_SOURCE_URL, COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1 } from '@happier-dev/protocol/marketplace';
import { HAPPIER_PICKS_SOURCE_ID } from '@happier-dev/protocol/registries';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createRegistryPluginCatalogFixture, createRegistryNpmPackageFixture } from '@/dev/testkit/fixtures/registryPluginCatalog';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';

installPromptRegistriesCommonModuleMocks({ storage: original => original(), modal: async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { createPlainPromptLibraryCatalogHomeFixture } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
await Promise.all([import('@/auth/storage/tokenStorage'), import('@/sync/domains/server/serverRuntime'),
    import('@/sync/domains/state/storage'), import('@/utils/system/runtimeFetch'),
    import('@/sync/runtime/orchestration/appliedActiveServerRuntime')]);
const { usePluginSettingsScreenState } = await import('./model/usePluginSettingsScreenState');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { renderSettingsView } = await import('@/dev/testkit/harness/settingsViewHarness');
const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
const { PluginListingScreen } = await import('./listing/PluginListingScreen');

async function setup(suffix: string, options: Readonly<{
    entries?: Parameters<typeof createRegistryPluginCatalogFixture>[0]['entries'];
    curatedEntries?: Parameters<typeof createRegistryPluginCatalogFixture>[0]['entries'];
    handleExternalRequest?: (url: string) => Promise<Response | null>;
}> = {}) {
    const serverUrl = `https://plugin-discovery-${suffix}.test`;
    const sourceUrl = `${serverUrl}/catalog.json`;
    const catalog = createRegistryPluginCatalogFixture({ sourceUrl, entries: options.entries });
    const sourceId = catalog.source.id;
    const curated = createRegistryPluginCatalogFixture({ sourceUrl: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL,
        kind: 'curated', entries: options.curatedEntries ?? [] });
    let unavailable = false;
    let pending: Promise<void> | null = null;
    const requests: string[] = [];
    const fixture = await createPlainPromptLibraryCatalogHomeFixture(serverUrl, {
        key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{ id: sourceId, title: 'Private catalog',
            format: 'happier-catalog', kinds: ['plugin'], url: sourceUrl, enabled: true, addedAt: 1 }] },
    }, 'updated', {
        handleRequest: async path => {
            if (path !== '/catalog.json') return null;
            requests.push(sourceUrl);
            await pending;
            return unavailable ? new Response(null, { status: 503 }) : Response.json(catalog);
        },
        handleExternalRequest: async url => {
            requests.push(url);
            const response = await options.handleExternalRequest?.(url);
            if (response) return response;
            if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return Response.json(curated);
            if (url.startsWith('https://registry.npmjs.org/-/v1/search')) return Response.json({ total: 0, objects: [] });
            return null;
        },
    });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ localSettings: { ...storage.getState().localSettings,
        pluginsCollectionViewV1: { installed: 'list', discover: 'list' } } });
    const hook = await renderHook(() => usePluginSettingsScreenState());
    onTestFailed(() => {
        const state = hook.getCurrent();
        console.error('Registry discovery boundary:', JSON.stringify({ requests, homeRequests: fixture.requests,
            sourceId: state.selectedDiscoverSourceId, entries: state.discoverEntries.map(entry => ({ id: entry.id, version: entry.version })),
            loading: state.loadingDiscover, loadingMore: state.loadingMoreDiscover, nextCursor: state.discoverNextCursor, error: state.discoverError }));
    });
    await waitForHomeGovernance(() => expect(hook.getCurrent().marketplaceSourceRegistryAvailable).toBe(true));
    return { hook, fixture, sourceId, sourceUrl, requests,
        fail: () => { unavailable = true; }, recover: () => { unavailable = false; }, hold: (value: Promise<void> | null) => { pending = value; } };
}

async function browse(hook: Awaited<ReturnType<typeof setup>>['hook']) {
    await act(async () => { hook.getCurrent().setActiveView('discover'); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toContainEqual(expect.objectContaining({ id: 'sample.plugin' })));
    await waitForHomeGovernance(() => expect(hook.getCurrent().loadingDiscover).toBe(false));
}

it('browses the Account source union without a Machine and keeps each source-qualified listing and reviewed version', async () => {
    const { hook, fixture, sourceId } = await setup('union', { curatedEntries: [{ pluginId: 'sample.plugin', title: 'Curated Sample', version: '2.0.0', review: 'approved' }] });
    await browse(hook);
    expect(hook.getCurrent().discoverSources.map(source => source.id)).toEqual(expect.arrayContaining([sourceId, HAPPIER_PICKS_SOURCE_ID, COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1]));
    expect(hook.getCurrent().discoverSources.filter(source => source.id === COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1)).toHaveLength(1);
    expect(hook.getCurrent().selectedDiscoverSourceId).toBeNull();
    expect(hook.getCurrent().discoverEntries).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'sample.plugin', sourceId, version: '1.2.3', installable: true, warning: 'unreviewed' }),
        expect.objectContaining({ id: 'sample.plugin', sourceId: HAPPIER_PICKS_SOURCE_ID, version: '2.0.0', installable: true }),
    ]));
    expect(hook.getCurrent().executionMachineId).toBeNull();
    expect(hook.getCurrent().canRunDiscoverActions).toBe(false);
    expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    await act(async () => { hook.getCurrent().setSelectedDiscoverSourceId(sourceId); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toHaveLength(1));
    expect(hook.getCurrent().discoverEntries[0]?.sourceId).toBe(sourceId);
    expect(fixture.mutations).toEqual([]);
});

it('keeps shown results while a search draft changes, submits the requested query, and clears an empty search', async () => {
    const { hook } = await setup('search');
    await browse(hook);
    const shown = hook.getCurrent().discoverEntries;
    await act(async () => { hook.getCurrent().setDiscoverSearchText('absent plugin'); });
    expect(hook.getCurrent().discoverEntries).toBe(shown);
    expect(hook.getCurrent().discoverStale).toBe(true);
    await act(async () => { hook.getCurrent().refreshDiscover(); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toEqual([]));
    expect(hook.getCurrent().discoverError).toBeNull();
    await act(async () => { hook.getCurrent().clearDiscoverSearch(); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toHaveLength(1));
    expect(hook.getCurrent().discoverSearchText).toBe('');
    expect(hook.getCurrent().discoverStale).toBe(false);
});

it('retains a known listing while refresh is pending, exposes the failed source, and recovers through Retry', async () => {
    const { hook, sourceId, fail, recover, hold } = await setup('outage');
    await browse(hook);
    const known = hook.getCurrent().discoverEntries;
    let release!: () => void;
    hold(new Promise<void>(resolve => { release = resolve; }));
    onTestFinished(() => { release(); });
    await act(async () => { hook.getCurrent().refreshDiscover(); });
    expect(hook.getCurrent().discoverEntries).toBe(known);
    fail();
    await act(async () => { release(); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverSourceStatuses).toContainEqual(expect.objectContaining({ id: sourceId, freshness: 'unavailable' })));
    expect(hook.getCurrent().discoverDiagnostics).toContainEqual(expect.objectContaining({ sourceId, code: 'unreachable' }));
    recover(); hold(null);
    await act(async () => { hook.getCurrent().refreshDiscover(); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toContainEqual(expect.objectContaining({ id: 'sample.plugin', sourceId })));
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverSourceStatuses).toContainEqual(expect.objectContaining({ id: sourceId, freshness: 'fresh' })));
});

it('keeps a withdrawn curated listing inspectable and exposes blocked listings separately from installable metadata', async () => {
    const { hook } = await setup('review', { curatedEntries: [
        { pluginId: 'withdrawn.plugin', title: 'Withdrawn', review: 'withdrawn' },
        { pluginId: 'blocked.plugin', title: 'Blocked', review: 'blocked' },
    ] });
    await browse(hook);
    expect(hook.getCurrent().discoverEntries).toContainEqual(expect.objectContaining({ id: 'withdrawn.plugin', warning: 'withdrawn', installable: false }));
    expect(hook.getCurrent().discoverNonInstallable).toContainEqual(expect.objectContaining({ pluginId: 'blocked.plugin', reason: 'notApproved' }));
    await act(async () => { hook.getCurrent().openDiscoverListing({ sourceId: HAPPIER_PICKS_SOURCE_ID, pluginId: 'withdrawn.plugin' }); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toHaveLength(1));
    expect(hook.getCurrent().discoverEntries[0]).toMatchObject({ id: 'withdrawn.plugin', sourceId: HAPPIER_PICKS_SOURCE_ID, installable: false });
});

function npmBoundary() {
    const packages = [
        createRegistryNpmPackageFixture({ packageName: '@sample/one', pluginId: 'sample.one', title: 'First Plugin', version: '1.0.0' }),
        createRegistryNpmPackageFixture({ packageName: '@sample/two', pluginId: 'sample.two', title: 'Second Plugin', version: '2.0.0' }),
    ];
    return async (url: string): Promise<Response | null> => {
        const parsed = new URL(url);
        if (parsed.origin !== 'https://registry.npmjs.org') return null;
        if (parsed.pathname === '/-/v1/search') {
            if (parsed.searchParams.get('text')?.includes('absent')) return Response.json({ total: 0, objects: [] });
            const exact = packages.find(candidate => parsed.searchParams.get('text')?.includes(candidate.name));
            const metadata = exact ?? packages[Number(parsed.searchParams.get('from') ?? '0')];
            return Response.json({ total: exact ? 1 : packages.length, objects: metadata ? [{ package: {
                name: metadata.name, version: metadata.version, publisher: { username: 'sample' },
            } }] : [] });
        }
        const metadata = packages.find(candidate => decodeURIComponent(parsed.pathname.slice(1)) === candidate.name);
        return metadata ? Response.json({ name: metadata.name, versions: { [metadata.version]: metadata }, 'dist-tags': { latest: metadata.version } }) : null;
    };
}

it('pages Community npm through the real format reader and clears its continuation when the query changes', async () => {
    const { hook, requests } = await setup('npm-paging', { handleExternalRequest: npmBoundary() });
    await act(async () => { hook.getCurrent().setSelectedDiscoverSourceId(COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries, 'Community npm first page').toHaveLength(1));
    expect(hook.getCurrent().discoverEntries[0]).toMatchObject({ id: 'sample.one', version: '1.0.0', sourceId: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1 });
    expect(hook.getCurrent().discoverNextCursor).not.toBeNull();
    await act(async () => { hook.getCurrent().loadMoreDiscover(); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries, 'Community npm continuation').toHaveLength(2));
    expect(hook.getCurrent().discoverEntries.map(entry => entry.id)).toEqual(['sample.one', 'sample.two']);
    expect(requests.some(url => new URL(url).searchParams.get('from') === '1')).toBe(true);
    await act(async () => { hook.getCurrent().setDiscoverSearchText('absent'); });
    await act(async () => { hook.getCurrent().refreshDiscover(); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toEqual([]));
    expect(hook.getCurrent().discoverNextCursor).toBeNull();
});

it('settles the latest selected source while an earlier catalog response is still pending', async () => {
    const { hook, sourceId, hold } = await setup('source-race', { handleExternalRequest: npmBoundary() });
    let release!: () => void;
    hold(new Promise<void>(resolve => { release = resolve; }));
    onTestFinished(() => { release(); });
    await act(async () => { hook.getCurrent().setSelectedDiscoverSourceId(sourceId); });
    await act(async () => { hook.getCurrent().setSelectedDiscoverSourceId(COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toHaveLength(1));
    expect(hook.getCurrent().discoverEntries[0]?.sourceId).toBe(COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1);
    await act(async () => { release(); });
    expect(hook.getCurrent().selectedDiscoverSourceId).toBe(COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1);
    expect(hook.getCurrent().discoverEntries[0]?.sourceId).toBe(COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1);
});

it('renders current registry listings and a single polite status region through the Plugins page', async () => {
    const { sourceId } = await setup('screen');
    const screen = await renderSettingsView(<AppPaneProvider><PluginSettingsHomeScreen /></AppPaneProvider>);
    await act(async () => { screen.pressByTestId('settings.plugins.management.view:discover'); });
    await waitForHomeGovernance(() => expect(screen.findByTestId(`settings.plugins.marketplace.entry.${sourceId}.sample.plugin`)).not.toBeNull());
    const status = screen.findHostByTestId('settings.plugins.marketplace.discover.status');
    expect(status).not.toBeNull();
    expect(status?.findAll(node => typeof node.type === 'string' && node.props.accessibilityLiveRegion === 'polite')).toHaveLength(1);
    expect(screen.getTextContent()).toContain('Sample Plugin');
    const search = screen.findAll(node => node.props.testID === 'settings.plugins.marketplace.search'
        && typeof node.props.onChangeText === 'function')[0];
    expect(search).toBeDefined();
    await act(async () => { search!.props.onChangeText('absent'); });
    // Typing is a draft: the current result remains until the real submit path runs.
    expect(screen.findByTestId(`settings.plugins.marketplace.entry.${sourceId}.sample.plugin`)).not.toBeNull();
    const submittedSearch = screen.findAll(node => node.props.testID === 'settings.plugins.marketplace.search'
        && typeof node.props.onSubmitEditing === 'function')[0];
    await act(async () => { submittedSearch!.props.onSubmitEditing(); });
    await waitForHomeGovernance(() => expect(screen.findByTestId(`settings.plugins.marketplace.entry.${sourceId}.sample.plugin`)).toBeNull());
    // The loading view also has no rows; Clear belongs to the settled no-match
    // result, so wait for that actual recovery control before pressing it.
    await waitForHomeGovernance(() => expect(screen.findByTestId('settings.plugins.marketplace.discover.clearSearch')).not.toBeNull());
    await act(async () => { screen.pressByTestId('settings.plugins.marketplace.discover.clearSearch'); });
    await waitForHomeGovernance(() => expect(screen.findByTestId(`settings.plugins.marketplace.entry.${sourceId}.sample.plugin`)).not.toBeNull());
});

it('reads a source-qualified listing page without installing or writing Account state', async () => {
    const { fixture, sourceId } = await setup('listing');
    const screen = await renderSettingsView(<AppPaneProvider><PluginListingScreen sourceId={sourceId} pluginId="sample.plugin" /></AppPaneProvider>);
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Sample Plugin'));
    expect(screen.getTextContent()).toContain('1.2.3');
    expect(fixture.mutations).toEqual([]);
    expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
});

it('announces the real pending catalog once and renders its source failure outside the live region', async () => {
    const { sourceId, hold, fail } = await setup('screen-pending');
    let release!: () => void;
    hold(new Promise<void>(resolve => { release = resolve; }));
    onTestFinished(() => { release(); });
    const screen = await renderSettingsView(<AppPaneProvider><PluginSettingsHomeScreen /></AppPaneProvider>);
    await act(async () => { screen.pressByTestId('settings.plugins.management.view:discover'); });
    await waitForHomeGovernance(() => {
        const status = screen.findHostByTestId('settings.plugins.marketplace.discover.status');
        expect(status?.findAll(node => typeof node.type === 'string' && node.props.accessibilityLiveRegion === 'polite')).toHaveLength(1);
    });
    fail();
    await act(async () => { release(); });
    await waitForHomeGovernance(() => expect(screen.findByTestId(`settings.plugins.marketplace.discover.issue.${sourceId}`)).not.toBeNull());
    expect(screen.getTextContent()).not.toContain('HTTP 503');
});
