import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { MarketplaceIndexSourceSnapshotV1Schema, deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace';
import { HAPPIER_PICKS_SOURCE_ID } from '@happier-dev/protocol/registries';
import { DEFAULT_CURATED_MARKETPLACE_SOURCE_URL } from '@happier-dev/protocol/marketplace';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';

const platform = vi.hoisted(() => ({ value: 'web' }));
installPromptRegistriesCommonModuleMocks({ storage: original => original(), reactNative: async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { get OS() { return platform.value; } } }), modal: async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { createPlainPromptLibraryCatalogHomeFixture } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
// Load the fixture's runtime graph at collection, without admitting a Home or
// writing credentials before Vitest installs its per-case storage boundary.
await Promise.all([import('@/auth/storage/tokenStorage'), import('@/sync/domains/server/serverRuntime'),
    import('@/sync/domains/state/storage'), import('@/utils/system/runtimeFetch'),
    import('@/sync/runtime/orchestration/appliedActiveServerRuntime')]);
const [{ useRegistryItems }, { useRegistrySourceMutations }, { useRegistrySuggestions }, { useSkillsHomepageModel }] = await Promise.all([
    import('./useRegistryItems'), import('./useRegistrySourceMutations'), import('./useRegistrySuggestions'),
    import('@/components/settings/skills/useSkillsHomepageModel'),
]);
const [{ usePluginSettingsScreenState }, { usePromptLibraryCatalogValue }] = await Promise.all([
    import('@/components/settings/plugins/model/usePluginSettingsScreenState'), import('@/sync/store/usePromptLibraryCatalog'),
]);
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { decideApprovalAsInbox } = await import('@/dev/testkit/harness/approvalInbox');

async function confirmRemoval(fixture: Awaited<ReturnType<typeof createPlainPromptLibraryCatalogHomeFixture>>,
    remove: () => Promise<unknown>) {
    let mutation: Promise<unknown> | undefined;
    await act(async () => { mutation = remove(); });
    await waitForHomeGovernance(() => expect(fixture.boundary.list()).toHaveLength(1));
    const artifactId = fixture.boundary.list()[0]!.id;
    const decision = await decideApprovalAsInbox(fixture.home.id, artifactId, 'approve');
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
    await act(async () => { await mutation; });
}

async function setupHome(suffix: string) {
    const serverUrl = `https://registry-refresh-${suffix}.test`;
    const sourceUrl = `${serverUrl}/catalog.json`;
    const sourceId = deriveMarketplaceSourceId(sourceUrl);
    const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({
        source: { id: sourceId, title: 'Private catalog', kind: 'user', sourceUrl },
        freshness: { state: 'fresh', fetchedAtMs: 1 }, diagnostics: [], entries: [{
            pluginId: 'sample.plugin', publisher: { id: 'sample', displayName: 'Sample' },
            display: { title: 'Sample Plugin', description: 'A catalog entry' },
            distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: 'sample-plugin', version: '1.2.3',
                integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==' },
            manifestDigest: 'sha256:' + 'a'.repeat(64), compatibility: { happier: '>=1', platforms: ['web'] },
            summary: { contributions: ['agents'], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
            review: { status: 'unreviewed', reviewedAt: null }, categories: ['agents'], media: [], updatePolicy: 'allowed', links: {},
        }],
    });
    let unavailable = false;
    let rateLimited = false;
    const fixture = await createPlainPromptLibraryCatalogHomeFixture(serverUrl, {
        key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{ id: sourceId, title: 'Private catalog',
            format: 'happier-catalog', kinds: ['plugin'], url: sourceUrl, enabled: true, addedAt: 1 }] },
    }, 'updated', { handleRequest: async path => path === '/catalog.json'
        ? rateLimited ? new Response(null, { status: 429 })
            : unavailable ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(catalog) : null });
    onTestFailed(() => { console.error('Registry read Home requests:', JSON.stringify(fixture.requests)); });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    return { fixture, sourceId, setUnavailable: () => { unavailable = true; }, setRateLimited: (next: boolean) => { rateLimited = next; } };
}

async function setup(suffix: string, refresh = true) {
    const { fixture, sourceId, setUnavailable } = await setupHome(suffix);
    const hook = await renderHook(({ query }: { query: string }) => {
        const mutations = useRegistrySourceMutations();
        return { ...useRegistryItems({ kind: 'plugin', sourceIds: [sourceId], query }), available: mutations.ready, mutations };
    }, { initialProps: { query: 'Sample' } });
    await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
    expect(hook.getCurrent().error).toBeNull();
    expect(hook.getCurrent().pages).toEqual([expect.objectContaining({ sourceId, status: expect.objectContaining({ state: 'ok' }) })]);
    expect(hook.getCurrent().items).toContainEqual(expect.objectContaining({ sourceId, itemId: 'sample.plugin', version: '1.2.3' }));
    const lastKnown = hook.getCurrent().items;
    setUnavailable();
    if (refresh) await act(async () => { await hook.getCurrent().refresh(); });
    return { fixture, hook, sourceId, lastKnown };
}

describe('registry item last-known reads through the Account and HTTP owners', () => {
    it('reads curated skill picks through the mounted Action and real target adapter with no Machine', async () => {
        const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({ source: {
            id: HAPPIER_PICKS_SOURCE_ID, title: 'Happier picks', kind: 'curated', sourceUrl: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL,
        }, freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [], picks: [{
            kind: 'skill', format: 'git', sourceUrl: 'https://github.com/example/skills', itemId: '',
        }] });
        const commit = '1'.repeat(40);
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-picks.test', {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return Response.json(catalog);
            if (url.startsWith('https://api.github.com/repos/example/skills/commits/')) return Response.json({ sha: commit });
            if (url.includes('/git/trees/')) return Response.json({ sha: 'tree', tree: [{ path: 'SKILL.md', type: 'blob', mode: '100644', sha: 'blob', size: 40 }] });
            if (url.startsWith('https://raw.githubusercontent.com/example/skills/')) return new Response('---\nname: review-changes\n---\nInstructions');
            return null;
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const { storage } = await import('@/sync/domains/state/storage');
        const hook = await renderHook(() => useSkillsHomepageModel({ scope: storage.getState().settingsScope, status: 'ready', items: [], stale: false, errorCode: null,
            usageObservedSince: null, retry() {} }, []));
        await waitForHomeGovernance(() => expect(hook.getCurrent().registryShelf.loading).toBe(false));
        expect(hook.getCurrent().registryShelf.items).toContainEqual(expect.objectContaining({ title: 'review-changes', flags: { pick: true }, version: commit }));
        expect(hook.getCurrent().registryShelf.sourceId).toBe(HAPPIER_PICKS_SOURCE_ID);
        expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    });
    it('quietly omits the web skill shelf instead of browsing skills.sh through a Machine when picks are empty or unreachable', async () => {
        let unavailable = false;
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-empty-picks.test', {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            expect(url).toBe(DEFAULT_CURATED_MARKETPLACE_SOURCE_URL);
            return unavailable ? new Response(null, { status: 503 }) : Response.json(MarketplaceIndexSourceSnapshotV1Schema.parse({ source: {
                id: HAPPIER_PICKS_SOURCE_ID, title: 'Picks', kind: 'curated', sourceUrl: url,
            }, freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [], picks: [] }));
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const hook = await renderHook(() => useRegistrySuggestions('skill'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent()).toMatchObject({ items: [], sourceId: null });
        unavailable = true;
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent()).toMatchObject({ items: [], sourceId: null, loading: false });
        expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    });
    it('falls back to the first direct built-in agent registry without browsing user or daemon sources', async () => {
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-agent-suggestions.test', {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return new Response(null, { status: 503 });
            expect(url).toBe('https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json');
            return Response.json({ version: '1.0.0', agents: [{ id: 'sample', name: 'Sample agent', description: 'An Agent', version: '1.0.0', distribution: { npx: { package: 'sample@1.0.0' } } }] });
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const hook = await renderHook(() => useRegistrySuggestions('agent'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent()).toMatchObject({ sourceId: 'builtin:acp-registry', items: [{ itemId: 'sample', title: 'Sample agent' }] });
        expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    });
    it('reads the native skill fallback directly from the first built-in page', async () => {
        platform.value = 'ios';
        onTestFinished(() => { platform.value = 'web'; });
        const externalRequests: string[] = [];
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-native-suggestions.test', {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            externalRequests.push(url);
            if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return new Response(null, { status: 503 });
            expect(url).toBe('https://skills.sh/');
            return new Response('<a href="/example/skills/review">Review</a>');
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const hook = await renderHook(() => useRegistrySuggestions('skill'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent()).toMatchObject({ sourceId: 'builtin:skills-sh', items: [{ itemId: 'example/skills/review' }] });
        expect(externalRequests).toContain('https://skills.sh/');
        expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    });
    it('keeps known items on a headerless rate limit and recovers through the source failure manual Retry', async () => {
        const { sourceId, setRateLimited } = await setupHome('rate-limit');
        const hook = await renderHook(() => useRegistryItems({ kind: 'plugin', sourceIds: [sourceId] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().items).toContainEqual(expect.objectContaining({ itemId: 'sample.plugin' }));
        const known = hook.getCurrent().items;
        setRateLimited(true);
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent().pages[0]?.status).toEqual({ state: 'rate_limited' });
        expect(hook.getCurrent().items).toEqual(known);
        expect(hook.getCurrent().sourceFailures).toEqual([expect.objectContaining({ sourceId, onRetry: expect.any(Function) })]);
        setRateLimited(false);
        await act(async () => { await hook.getCurrent().sourceFailures[0]!.onRetry(); });
        expect(hook.getCurrent().pages[0]?.status.state).toBe('ok');
        expect(hook.getCurrent().sourceFailures).toEqual([]);
        expect(hook.getCurrent().items).toEqual(known);
    });
    it('retains the same Account/query result with the failed refresh status, but never merges it into a different query', async () => {
        const { fixture, hook, sourceId, lastKnown } = await setup('query');
        expect(hook.getCurrent().items).toEqual(lastKnown);
        expect(hook.getCurrent().pages).toEqual([expect.objectContaining({ sourceId, status: { state: 'unreachable' }, nextCursor: null })]);
        expect(hook.getCurrent().sourceFailures).toEqual([expect.objectContaining({ sourceId, onRetry: expect.any(Function) })]);
        expect(hook.getCurrent().hasNextPage).toBe(false);
        await hook.rerender({ query: 'Missing entry' });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ loading: false, stale: false }));
        expect(hook.getCurrent().items).toEqual([]);
        expect(hook.getCurrent().pages[0]?.status).toEqual({ state: 'unreachable' });
        expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    });
    it('withdraws retained items when the credential Account changes before the displayed settings scope', async () => {
        const { fixture, hook, lastKnown } = await setup('account', false);
        expect(hook.getCurrent().items).toEqual(lastKnown);
        const { storage } = await import('@/sync/domains/state/storage');
        const displayedScope = storage.getState().settingsScope;
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentialWrite: { value: Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>> } = { value: null };
        await act(async () => {
            credentialWrite.value = await TokenStorage.setCredentialsForServerUrlWithRollback(fixture.home.serverUrl, { serverId: fixture.home.id }, {
                token: `e30.${Buffer.from(JSON.stringify({ sub: 'replacement-account' })).toString('base64url')}.signature`,
            });
        });
        const replacement = credentialWrite.value;
        if (!replacement) throw new Error('Replacement credential admission failed');
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().available).toBe(false));
            expect(storage.getState().settingsScope).toEqual(displayedScope);
            expect(hook.getCurrent().items).toEqual([]);
            expect(hook.getCurrent().pages).toEqual([]);
            expect(hook.getCurrent().hasNextPage).toBe(false);
        } finally { await act(async () => { await replacement.rollback(); }); }
    });
    it.each(['disable', 'remove'] as const)('withdraws old summaries when the real Account source row changes during an HTTP outage: %s', async operation => {
        const { fixture, hook, sourceId } = await setup(operation, false);
        if (operation === 'disable') await act(async () => { await hook.getCurrent().mutations.update({ sourceId, enabled: false }); });
        else await confirmRemoval(fixture, () => hook.getCurrent().mutations.delete(sourceId));
        expect(fixture.read().revision).toBe(5);
        if (operation === 'disable') expect(fixture.read().record.value).toMatchObject({ sources: [{ id: sourceId, enabled: false }] });
        else expect(fixture.read().record.value).toMatchObject({ sources: [] });
        await waitForHomeGovernance(() => expect(hook.getCurrent().items).toEqual([]));
        expect(hook.getCurrent().pages).toEqual([]);
        expect(hook.getCurrent().hasNextPage).toBe(false);
    });
    it.each(['disable', 'remove'] as const)('withdraws the controller rich card in the first visible render of the changed source revision: %s', async operation => {
        const { fixture, sourceId, setUnavailable } = await setupHome(`controller-${operation}`);
        const observations: { revision: ReturnType<typeof usePromptLibraryCatalogValue>['revision']; entries: readonly string[]; canInstall: boolean }[] = [];
        const hook = await renderHook(() => {
            const state = usePluginSettingsScreenState();
            const catalog = usePromptLibraryCatalogValue('registry-sources');
            React.useLayoutEffect(() => {
                observations.push({ revision: catalog.revision, entries: state.discoverEntries.map(entry => entry.id), canInstall: state.canRunDiscoverActions });
            }, [catalog.revision, state.discoverEntries, state.canRunDiscoverActions]);
            return state;
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().marketplaceSourceRegistryAvailable).toBe(true));
        await act(async () => { hook.getCurrent().openDiscoverListing({ sourceId, pluginId: 'sample.plugin' }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toContainEqual(expect.objectContaining({
            id: 'sample.plugin', sourceId, title: 'Sample Plugin', version: '1.2.3', packageName: 'sample-plugin', installable: true,
        })));
        setUnavailable();
        observations.length = 0;
        if (operation === 'disable') await act(async () => { await hook.getCurrent().setMarketplaceSourceEnabled(sourceId, false); });
        else await confirmRemoval(fixture, () => hook.getCurrent().removeMarketplaceSource(sourceId));
        expect(fixture.read().revision).toBe(5);
        const changedRevision = observations.filter(observation => observation.revision === 5);
        expect(changedRevision.length).toBeGreaterThan(0);
        expect(changedRevision.every(observation => observation.entries.length === 0 && !observation.canInstall)).toBe(true);
        expect(hook.getCurrent().discoverEntries).toEqual([]);
        expect(hook.getCurrent().canRunDiscoverActions).toBe(false);
        expect(hook.getCurrent().executionMachineId).toBeNull();
    });
});
