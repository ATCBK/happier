import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { DEFAULT_MEMORY_SETTINGS } from '@happier-dev/protocol/memory/memorySettings';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeferred, createMachineFixture, flushHookEffects, PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { FileFindSeedHandoff } from '@/components/appShell/panes/fileFindSeedHandoff';
import { makeExternalSessionHistoricalImportLocalId } from '@happier-dev/protocol/sessions/external/historicalImportIdentity';
import { ExternalSessionsCandidatesListRequestSchema, ExternalSessionsCandidatesListResponseSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';

const rpc = vi.hoisted(() => vi.fn());
const homes = createHomeGovernanceHarness();
let serverId: string;
let connection: Awaited<ReturnType<typeof import('@/dev/testkit/harness/serverAccountConnectionHarness').restoreServerAccountForTest>> | undefined;
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// The renderer has no native recycler viewport. Mount its cells at the SDK
// boundary while preserving the real SelectionList rows and activation path.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<typeof import('@legendapp/list/react-native')>() }).module;
});
// The app entry publishes the real Sync tuning before Account-bound search.
// Bridge its Node require through the canonical loader; keep sockets external.
const network = await installSessionOpsNetworkBoundary();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { isMachineOnline } = await import('@/utils/sessions/machineUtils');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
const { readExternalSessionBrowseCandidateKey } = await import('./useExternalSessionBrowseCandidates');
const { AppPaneProvider, useOptionalAppPaneContext } = await import('@/components/appShell/panes/AppPaneProvider');
const { parseToken } = await import('@/utils/auth/parseToken');
const { ExternalSessionsBrowseScreen } = await import('./ExternalSessionsBrowseScreen');
const { WorkspaceRouteBody } = await import('@/app/(app)/external/browse');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
afterAll(() => network.dispose());

const projection = PluginProjectionV2Schema.parse({ ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
    agentsById: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.agentsById, 'acme.archive': {
        id: 'acme.archive', identity: { pluginId: 'acme.review', localId: 'archive' }, title: 'Archive Agent',
        externalSessions: { agent: { pluginId: 'acme.review', localId: 'archive' }, generation: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.generation,
            operations: { listCandidates: true, resolveLinkIdentity: true, pageTranscript: true, readAfterTranscript: true },
            sources: [{ sourceKind: 'archive', contentSearch: true, schema: { fields: [{ name: 'kind', kind: 'literal', value: 'archive' }] },
                key: { segments: [{ kind: 'literal', value: 'archive' }] }, instances: [{ kind: 'default', constants: {} }] }],
        },
    } },
});

beforeEach(async () => {
    await homes.reset();
    const homeId = await homes.addHome({ serverUrl: 'https://history-index.example.test', serverIdentityId: 'srv_history_index', name: 'History Home', accountId: 'history-account' });
    serverId = resolveServerProfileScopeIdForIdentifier(homeId);
    installHomeGovernanceBoundaries(homes);
    homes.answer(homeId, '/v1/machines/machine-1', { body: { machine:
        createPlainMachineRowFixture({ id: 'machine-1', accountId: 'history-account' }) } });
    homes.answer(homeId, '/v1/machines', { body: [createPlainMachineRowFixture({ id: 'machine-1', accountId: 'history-account' })] });
    network.requests.length = 0;
    network.setRpcResponder(async call => rpc({ ...call, machineId: call.targetId,
        serverId: resolveServerProfileScopeIdForIdentifier(homes.findByServerUrl(call.serverUrl)?.serverId),
        accountId: call.token ? parseToken(call.token) : null,
    }));
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async url => {
        const token = homes.findByServerUrl(url)?.token;
        return token ? { token } : null;
    });
    const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    connection = await restoreServerAccountForTest({ serverUrl: 'https://history-index.example.test', serverIdentityId: serverId,
        accountId: 'history-account', request: homes.request });
    const machine = createMachineFixture({ id: 'machine-1', activeAt: Date.now() });
    const scope = { serverId, accountId: 'history-account' };
    storage.setState(state => ({ isDataReady: true, settingsVersion: 1, profile: { ...state.profile, id: scope.accountId }, profileScope: scope, settingsScope: scope,
        machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' },
        settings: { ...settingsDefaults, experiments: true, featureToggles: { 'memory.search': true } },
    }));
    clearDaemonMergedProjectionCacheForTests();
    rpc.mockReset();
    // Advance the search scheduler without aging fresh Machine presence.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(async () => { standardCleanup(); vi.useRealTimers(); await connection?.dispose(); connection = undefined; vi.restoreAllMocks(); await homes.reset(); });

async function flush() { await flushHookEffects({ runOnlyPendingTimers: true }); }

describe('History unified conversation search', () => {
    it.each(['control', 'return'] as const)('admits an explicit %s submit during indexed lookup and settles a partial hit or complete empty scan', async submit => {
        const pendingStatus = createDeferred<unknown>();
        let statusReads = 0;
        const terms: string[] = [];
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return { ...DEFAULT_MEMORY_SETTINGS, enabled: true };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_STATUS) {
                statusReads++;
                if (statusReads > 1) return pendingStatus.promise;
                return { v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: false, deepIndexReady: false,
                    activeIndexReady: false, embeddingsEnabled: false, embeddingsMode: 'disabled', embeddingsPresetId: null,
                    embeddingsProviderKind: null, embeddingsModelId: null, embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
                    tier1DbPath: null, deepDbPath: null, tier1DbBytes: null, deepDbBytes: null };
            }
            if (call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST) {
                terms.push(call.payload.searchTerm);
                return ExternalSessionsCandidatesListResponseSchema.parse({ ok: true,
                    candidates: submit === 'control' ? [{ remoteSessionId: 'pending-native-hit', updatedAtMs: 1,
                        match: { snippet: 'unmatched copper fern', sourceItemId: 'owned-message', messageIndex: 0 } }] : [],
                    contentCoverage: submit === 'control' ? 'partial' : 'complete', nextCursor: submit === 'control' ? 'remaining' : null });
            }
            throw new Error(`Unexpected pending-query transport ${call.method}`);
        });
        const screen = await renderScreen(<ExternalSessionsBrowseScreen
            lockScope={{ machineId: 'machine-1', serverId, providerId: 'acme.archive', source: { kind: 'archive' } }} initialSearchTarget="content" />,
        { flushOptions: { runOnlyPendingTimers: true } });
        const readList = () => screen.findAllByType(ExternalSessionBrowseCandidatesList)[0];
        await waitForHomeGovernance(async () => { await flush(); expect(readList().props.contentScanAvailable).toBe(true); });
        await act(async () => screen.changeTextByTestId('direct-session-candidates-search-input', 'unmatched copper fern'));
        await waitForHomeGovernance(async () => { await flush(); expect(statusReads).toBeGreaterThan(1); });
        expect(readList().props.loading).toBe(true);
        if (submit === 'control') await screen.pressByTestIdAsync('direct-session-candidates-content-submit');
        else await act(async () => readList().props.onSearchSubmit('unmatched copper fern'));
        expect(readList().props.contentSearchSubmitted).toBe(true);
        await act(async () => pendingStatus.resolve({ v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: false, deepIndexReady: false,
            activeIndexReady: false, embeddingsEnabled: false, embeddingsMode: 'disabled', embeddingsPresetId: null,
            embeddingsProviderKind: null, embeddingsModelId: null, embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
            tier1DbPath: null, deepDbPath: null, tier1DbBytes: null, deepDbBytes: null }));
        await waitForHomeGovernance(async () => { await flush(); expect(readList().props.loading).toBe(false); expect(terms).toEqual(['unmatched copper fern']); });
        expect(readList().props).toMatchObject({ contentSearchSubmitted: true,
            candidates: submit === 'control' ? [{ remoteSessionId: 'pending-native-hit', match: { sourceItemId: 'owned-message' } }] : [],
            contentCoverage: submit === 'control' ? 'partial' : 'complete', error: null });
        expect(screen.findHostByTestId('direct-session-candidates:content-unsearched')).toBeNull();
    });
    it.each(['ready', 'failed', 'home-profile'] as const)('keeps a submitted native hit, query and mode through a %s scoped route projection refresh', async outcome => {
        const features = createRootLayoutFeaturesResponse();
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        storage.setState(state => ({ settings: { ...state.settings, featureToggles: { ...state.settings.featureToggles, 'sessions.direct': true } } }));
        const refreshing = createDeferred<unknown>();
        const archive = projection.agentsById['acme.archive'];
        const source = archive.externalSessions!.sources[0];
        const fields = [...source.schema.fields, { name: 'archiveHome', kind: 'string' as const }];
        const sourceProjection = (reversed: boolean) => PluginProjectionV2Schema.parse({ ...projection, agentsById: {
            ...projection.agentsById, 'acme.archive': { ...archive, externalSessions: { ...archive.externalSessions,
                sources: [{ ...source, schema: { fields: reversed ? [...fields].reverse() : fields },
                    instances: [{ kind: 'default', constants: { archiveHome: '/fixture/archive' } }] }],
            } },
        } });
        let refresh = false;
        let scans = 0;
        const push = vi.fn();
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return refresh ? refreshing.promise : { protocolVersion: 1, projection: sourceProjection(false) };
            }
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return DEFAULT_MEMORY_SETTINGS;
            if (call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST) {
                if (call.payload.searchTarget !== 'content') return { ok: true, candidates: [], nextCursor: null };
                scans++;
                return ExternalSessionsCandidatesListResponseSchema.parse({ ok: true, candidates: [{ remoteSessionId: 'stable-native',
                    linkedSessionId: 'opened-native',
                    updatedAtMs: 1, match: { snippet: 'body phrase', sourceItemId: 'stable-message', messageIndex: 0 } }],
                    contentCoverage: 'complete', nextCursor: null });
            }
            throw new Error(`Unexpected route-refresh transport ${call.method}`);
        });
        const screen = await renderScreen(<DestinationInstanceHost tabId="browse-refresh" focused visible pathname="/external/browse"
            ref={{ kind: 'browseExistingSessions', params: { machineId: 'machine-1', serverId, agentId: 'acme.archive',
                agentPluginId: 'acme.review', agentLocalId: 'archive' } }}
            navigation={{ push, replace: () => {}, back: () => {} }}>
            <WorkspaceRouteBody />
        </DestinationInstanceHost>, { flushOptions: { runOnlyPendingTimers: true } });
        await flush();
        expect(screen.findHostByTestId('external-sessions-search-target:content'), screen.getTextContent()).not.toBeNull();
        await screen.pressByTestIdAsync('external-sessions-search-target:content');
        await act(async () => screen.changeTextByTestId('direct-session-candidates-search-input', 'body phrase'));
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.contentScanAvailable).toBe(true); });
        await screen.pressByTestIdAsync('direct-session-candidates-content-submit');
        const readList = () => screen.findAllByType(ExternalSessionBrowseCandidatesList)[0];
        await waitForHomeGovernance(async () => { await flush(); expect(readList().props.candidates).toHaveLength(1); });
        expect(scans).toBe(1);
        if (outcome === 'home-profile') {
            const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
            await act(async () => { await upsertServerProfile({ serverUrl: 'https://history-index.example.test', name: 'Renamed Home' }); });
            await flush();
            expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)).toHaveLength(1);
            expect(readList().props).toMatchObject({ searchQuery: 'body phrase', searchTarget: 'content',
                candidates: [{ remoteSessionId: 'stable-native' }] });
            return;
        }
        refresh = true;
        await act(async () => publishMachineContributionRegistryProjectionInvalidation({ serverId, machineId: 'machine-1' }));
        await flush();
        expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)).toHaveLength(1);
        expect(readList().props).toMatchObject({ searchQuery: 'body phrase', searchTarget: 'content',
            candidates: [{ remoteSessionId: 'stable-native' }] });
        await act(async () => {
            if (outcome === 'failed') refreshing.reject(new Error('Projection transport failed'));
            else refreshing.resolve({ protocolVersion: 1, projection: sourceProjection(true) });
        });
        await flush();
        expect(readList().props.candidateActionsDisabled).toBe(outcome === 'failed');
        expect(readList().props).toMatchObject({ searchQuery: 'body phrase', searchTarget: 'content',
            candidates: [{ remoteSessionId: 'stable-native' }] });
        expect(scans).toBe(1);
        if (outcome === 'failed') return;
        await act(async () => readList().props.onSelectCandidate(readList().props.candidates[0], readList().props.selectionAuthorityGeneration));
        expect(push).toHaveBeenCalledWith(expect.stringContaining('/session/opened-native'));
    });
    it('routes a thrown title-list transport failure through the shared failure copy and Retry', async () => {
        let recovered = false;
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return DEFAULT_MEMORY_SETTINGS;
            if (call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST) {
                if (!recovered) throw new Error('private transport detail');
                return ExternalSessionsCandidatesListResponseSchema.parse({ ok: true, candidates: [], nextCursor: null });
            }
            throw new Error(`Unexpected listing transport ${call.method}`);
        });
        const screen = await renderScreen(<ExternalSessionsBrowseScreen
            lockScope={{ machineId: 'machine-1', serverId, providerId: 'acme.archive', source: { kind: 'archive' } }} />,
        { flushOptions: { runOnlyPendingTimers: true } });
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.error).toBeTruthy(); });
        const list = screen.findAllByType(ExternalSessionBrowseCandidatesList)[0];
        expect(list.props.error).toBe('externalSessions.browseAgentFailed');
        expect(typeof list.props.onRetry).toBe('function');
        expect(screen.getTextContent()).not.toContain('private transport detail');
        recovered = true;
        await act(async () => list.props.onRetry());
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.error).toBeNull(); });
    });
    it.each(['retryable', 'terminal', 'transport'])('preserves actionable source failure and Retry admission in Browse (%s)', async failureKind => {
        const retryable = failureKind !== 'terminal';
        let recovered = false;
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return DEFAULT_MEMORY_SETTINGS;
            if (call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST) {
                if (failureKind === 'transport' && !recovered) throw new Error('private transport detail');
                return ExternalSessionsCandidatesListResponseSchema.parse(recovered
                ? { ok: true, candidates: [], contentCoverage: 'complete' }
                : { ok: false, errorCode: 'agent_error', retryable, error: 'private native path' });
            }
            throw new Error(`Unexpected failure-presentation transport ${call.method}`);
        });
        const screen = await renderScreen(<ExternalSessionsBrowseScreen
            lockScope={{ machineId: 'machine-1', serverId, providerId: 'acme.archive', source: { kind: 'archive' } }} initialSearchTarget="content" />,
        { flushOptions: { runOnlyPendingTimers: true } });
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findHostByTestId('direct-session-candidates-search-input')).not.toBeNull(); });
        await act(async () => screen.changeTextByTestId('direct-session-candidates-search-input', 'body phrase'));
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.contentScanAvailable).toBe(true); });
        await screen.pressByTestIdAsync('direct-session-candidates-content-submit');
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.loading).toBe(false); });
        const list = screen.findAllByType(ExternalSessionBrowseCandidatesList)[0];
        expect(list.props.error).toBe(retryable ? 'externalSessions.browseAgentFailed' : 'externalSessions.browseAgentFailedNoRetry');
        expect(typeof list.props.onRetry === 'function').toBe(retryable);
        expect(screen.getTextContent()).not.toContain('private native path');
        expect(screen.getTextContent()).not.toContain('private transport detail');
        if (retryable) {
            recovered = true;
            await act(async () => list.props.onRetry());
            await waitForHomeGovernance(async () => { await flush(); expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.contentCoverage).toBe('complete'); });
            expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.error).toBeNull();
        }
    });
    it('retries the same cancelled continuation through Browse with fresh request custody', async () => {
        const pages: Array<ReturnType<typeof createDeferred<unknown>>> = [];
        const cursors: Array<string | null | undefined> = [];
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return DEFAULT_MEMORY_SETTINGS;
            if (call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST) {
                const request = ExternalSessionsCandidatesListRequestSchema.parse(call.payload);
                cursors.push(request.cursor);
                if (!request.cursor) return ExternalSessionsCandidatesListResponseSchema.parse({
                    ok: true, candidates: [], contentCoverage: 'partial', nextCursor: 'remaining-file',
                });
                const page = createDeferred<unknown>();
                pages.push(page);
                return page.promise;
            }
            throw new Error(`Unexpected History retry transport ${call.method}`);
        });
        const screen = await renderScreen(<ExternalSessionsBrowseScreen
            lockScope={{ machineId: 'machine-1', serverId, providerId: 'acme.archive', source: { kind: 'archive' } }} initialSearchTarget="content" />,
        { flushOptions: { runOnlyPendingTimers: true } });
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findHostByTestId('direct-session-candidates-search-input')).not.toBeNull(); });
        await act(async () => screen.changeTextByTestId('direct-session-candidates-search-input', 'body phrase'));
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.contentScanAvailable).toBe(true); });
        await screen.pressByTestIdAsync('direct-session-candidates-content-submit');
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.nextCursor).toBe('remaining-file'); });
        await screen.pressByTestIdAsync('direct-session-candidates:pagination:more');
        await waitForHomeGovernance(async () => { await flush(); expect(pages).toHaveLength(1); });
        await screen.pressByTestIdAsync('direct-session-candidates-content-submit');
        expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.cancelled).toBe(true);
        await screen.pressByTestIdAsync('direct-session-candidates:cancelled-action');
        await flush();
        expect(pages).toHaveLength(2);
        expect(cursors).toEqual([undefined, 'remaining-file', 'remaining-file']);
        expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.cancelled).toBe(false);
        // A cancelled transport may still reply. It must not finish or replace Retry.
        await act(async () => pages[0].resolve(ExternalSessionsCandidatesListResponseSchema.parse({
            ok: true, candidates: [], contentCoverage: 'complete', nextCursor: null,
        })));
        await flush();
        expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.loading).toBe(true);
        await act(async () => pages[1].resolve(ExternalSessionsCandidatesListResponseSchema.parse({
            ok: true, candidates: [{ remoteSessionId: 'resumed-native', updatedAtMs: 1,
                match: { snippet: 'body phrase', sourceItemId: 'resumed-message', messageIndex: 0 } }],
            contentCoverage: 'complete', nextCursor: null,
        })));
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.candidates).toMatchObject([
            { remoteSessionId: 'resumed-native', match: { sourceItemId: 'resumed-message' } },
        ]); });
        expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props).toMatchObject({
            cancelled: false, loading: false, contentCoverage: 'complete', nextCursor: null,
        });
    });
    it('scans an unready source only on activation and keeps an empty partial page searchable', async () => {
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return DEFAULT_MEMORY_SETTINGS;
            if (call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST) return call.payload.cursor
                ? { ok: true, candidates: [{ remoteSessionId: 'later-native', updatedAtMs: 1,
                    match: { snippet: 'body phrase', sourceItemId: 'later-message', messageIndex: 0 } }], contentCoverage: 'complete', nextCursor: null }
                : { ok: true, candidates: [], contentCoverage: 'partial', nextCursor: 'remaining-file' };
            throw new Error(`Unexpected History scan transport ${call.method}`);
        });
        const screen = await renderScreen(<ExternalSessionsBrowseScreen
            lockScope={{ machineId: 'machine-1', serverId, providerId: 'acme.archive', source: { kind: 'archive' } }} initialSearchTarget="content" />,
        { flushOptions: { runOnlyPendingTimers: true } });
        expect(isMachineOnline(storage.getState().machines['machine-1'])).toBe(true);
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findHostByTestId('direct-session-candidates-search-input')).not.toBeNull(); });
        await act(async () => screen.changeTextByTestId('direct-session-candidates-search-input', 'body phrase'));
        await flush();
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.contentScanAvailable).toBe(true); });
        expect(rpc.mock.calls.some(([call]) => call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST)).toBe(false);
        await screen.pressByTestIdAsync('direct-session-candidates-content-submit');
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.nextCursor).toBe('remaining-file'); });
        const list = screen.findAllByType(ExternalSessionBrowseCandidatesList)[0];
        expect(list.props.candidates).toEqual([]);
        expect(list.props.contentCoverage).toBe('partial');
        await screen.pressByTestIdAsync('direct-session-candidates:pagination:more');
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.candidates).toMatchObject([
            { remoteSessionId: 'later-native', searchMode: 'standard', match: { sourceItemId: 'later-message' } },
        ]); });
        const requests = rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST).map(([call]) => call);
        expect(requests).toMatchObject([
            { machineId: 'machine-1', serverId, accountId: 'history-account', payload: { agentId: 'acme.archive', source: { kind: 'archive' }, searchTerm: 'body phrase', searchTarget: 'content' } },
            { payload: { cursor: 'remaining-file' } },
        ]);
        await act(async () => screen.changeTextByTestId('direct-session-candidates-search-input', 'new phrase'));
        await flush();
        expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.candidates).toEqual([]);
        expect(rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST)).toHaveLength(2);
    });
    // F6 (r11): "Press Return to search…" invited an action that could not run while Search on demand was off.
    it('says Search on demand is off, and leads to its setting, instead of inviting Return', async () => {
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return { ...DEFAULT_MEMORY_SETTINGS,
                conversationSearch: { standardSearch: { enabled: false }, indexExternal: { enabled: false, agents: [], historyDays: null, includeToolOutput: false } } };
            throw new Error(`Unexpected History transport ${call.method}`);
        });
        const screen = await renderScreen(<ExternalSessionsBrowseScreen
            lockScope={{ machineId: 'machine-1', serverId, providerId: 'acme.archive', source: { kind: 'archive' } }} initialSearchTarget="content" />,
        { flushOptions: { runOnlyPendingTimers: true } });
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findHostByTestId('direct-session-candidates:content-scan-off')).not.toBeNull(); });
        expect(screen.findHostByTestId('direct-session-candidates:content-unsearched')).toBeNull();
        expect(screen.findHostByTestId('direct-session-candidates:content-scan-off:settings')).not.toBeNull();
        expect(rpc.mock.calls.some(([call]) => call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST)).toBe(false);
    });
    it.each(['explicit Account', 'local Home alias'] as const)('searches a ready native source and opens with a mapped Find seed (%s)', async custody => {
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return { ...DEFAULT_MEMORY_SETTINGS, enabled: true,
                conversationSearch: { standardSearch: { enabled: false }, indexExternal: { enabled: true, agents: ['acme.archive'], historyDays: null, includeToolOutput: false } } };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return { v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: true,
                deepIndexReady: true, activeIndexReady: true, activeIndexSearchable: true, embeddingsEnabled: false, embeddingsMode: 'disabled',
                embeddingsPresetId: null, embeddingsProviderKind: null, embeddingsModelId: null, embeddingsRuntimeState: 'unavailable',
                embeddingsUsingFallback: false, tier1DbPath: null, deepDbPath: null, tier1DbBytes: null, deepDbBytes: null,
                sources: [{ source: { type: 'external_transcript', agentId: 'acme.archive', sourceKey: 'archive' }, state: 'ready' }] };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SEARCH) return { v: 1, ok: true, hits: [{ type: 'external_transcript',
                source: { type: 'external_transcript', agentId: 'acme.archive', sourceKey: 'archive', nativeSessionId: 'indexed-native' },
                sourceItemId: 'native-message', createdAtFromMs: 1, createdAtToMs: 1, summary: call.payload.query, score: 0.5 }] };
            if (call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE) return { ok: true, sessionId: 'happy-session', created: true };
            throw new Error(`Unexpected History transport ${call.method}`);
        });
        const scopes = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]), { flushOptions: { runOnlyPendingTimers: true } });
        await waitForHomeGovernance(async () => { await flush(); expect(scopes.getCurrent().get(serverId)?.isCurrent()).toBe(true); });
        const lifetime = scopes.getCurrent().get(serverId);
        expect(lifetime?.isCurrent()).toBe(true);
        const handoff: { current: FileFindSeedHandoff | undefined } = { current: undefined };
        function HandoffProbe() { handoff.current = useOptionalAppPaneContext()?.fileFindSeedHandoff; return null; }
        const routeServerId = custody === 'local Home alias' ? connection!.home.id : serverId;
        if (custody === 'local Home alias') expect(routeServerId).not.toBe(serverId);
        storage.setState(state => ({ settings: { ...state.settings, keyboardShortcutsV2Enabled: false } }));
        const screen = await renderScreen(<AppPaneProvider><HandoffProbe /><ExternalSessionsBrowseScreen accountLifetime={custody === 'explicit Account' ? lifetime : undefined}
            lockScope={{ machineId: 'machine-1', serverId: routeServerId, providerId: 'acme.archive', source: { kind: 'archive' } }} initialSearchTarget="content" /></AppPaneProvider>,
        { flushOptions: { runOnlyPendingTimers: true } });
        await flush();
        await act(async () => screen.changeTextByTestId('direct-session-candidates-search-input', 'body phrase'));
        await flush();
        await flush();
        const request = rpc.mock.calls.find(([call]) => call.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)?.[0];
        expect(request).toMatchObject({ machineId: 'machine-1', serverId, accountId: 'history-account',
            payload: { query: 'body phrase', externalSource: { agentId: 'acme.archive', sourceKey: 'archive' } } });
        const list = screen.findAllByType(ExternalSessionBrowseCandidatesList)[0];
        expect(list.props.candidates).toMatchObject([{ remoteSessionId: 'indexed-native', searchMode: 'indexed', match: { sourceItemId: 'native-message', snippet: 'body phrase' } }]);
        expect(list.props.candidateActionsDisabled).toBe(false);
        expect(list.props.contentScanAvailable).toBe(false);
        expect(rpc.mock.calls.some(([call]) => call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST)).toBe(false);
        await screen.pressByTestIdAsync(`direct-session-candidate:${readExternalSessionBrowseCandidateKey(list.props.candidates[0])}`);
        await flush();
        expect(handoff.current?.peekChatCurrent({ sessionId: 'happy-session', serverId })).toEqual({
            query: 'body phrase', options: { matchCase: false, regex: false }, target: { kind: 'route-message-id',
                routeMessageId: `server:${makeExternalSessionHistoricalImportLocalId({ agentId: 'acme.archive', remoteSessionId: 'indexed-native', directItemId: 'native-message' })}` },
        });
        await act(async () => screen.changeTextByTestId('direct-session-candidates-search-input', 'new phrase'));
        await flush();
        expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.candidates[0]?.match.snippet).toBe('new phrase');
    });
});
