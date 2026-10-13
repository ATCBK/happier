import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema, makeExternalSessionHistoricalImportLocalId } from '@happier-dev/protocol';
import { createDeferred, createMachineFixture, createRootLayoutFeaturesResponse, findAllHostTestInstances, flushHookEffects, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DEFAULT_MEMORY_SETTINGS } from '@happier-dev/protocol/memory/memorySettings';

const boundary = vi.hoisted(() => ({ list: vi.fn(), ensure: vi.fn(), page: vi.fn(), projection: vi.fn(), routerPush: vi.fn(), serverId: '' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// Legend's native scrolling is a platform boundary; the browser and paging owner remain real.
vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ renderItems: true }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: boundary.routerPush } }).module;
});
const network = await installSessionOpsNetworkBoundary();
// Scoped clients can reuse a transport after the per-case request ledger resets.
const observedSockets = new Set<(typeof network.socketBoundaries)[number]>();
function socketBoundaries() {
    for (const socket of network.socketBoundaries) observedSockets.add(socket);
    return [...observedSockets];
}
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { ExternalConversationSearchResults } = await import('./ExternalConversationSearchResults');
const { resolveExternalSessionBrowseSourceOptions } = await import('@/components/sessions/external/browse/resolveExternalSessionBrowseSourceOptions');
const { parseToken } = await import('@/utils/auth/parseToken');
const homeIdsByUrl = new Map<string, string>();

function issuedRequestId(method: string, remoteSessionId?: string): string {
    const calls = socketBoundaries().flatMap(item => item.socket.emitWithAck.mock.calls);
    const request = calls.map(([event, raw]) => {
        if (event !== SOCKET_RPC_EVENTS.CALL || !raw || typeof raw !== 'object') return null;
        return raw as SocketRpcRequestPayload;
    }).filter((request): request is SocketRpcRequestPayload => request !== null)
        .reverse().find(request => request.method.endsWith(`:${method}`)
            && (!remoteSessionId || (request.params as Record<string, unknown>).remoteSessionId === remoteSessionId));
    if (!request?.requestId) throw new Error('Expected an issued cancellable daemon RPC');
    return request.requestId;
}
function wasCancelled(requestId: string): boolean {
    return socketBoundaries().some(item => item.socket.emit.mock.calls.some(([event, raw]) =>
        event === SOCKET_RPC_EVENTS.CANCEL && raw !== null && typeof raw === 'object'
        && 'requestId' in raw && raw.requestId === requestId));
}

let scopeOwner: typeof import('@/sync/domains/scope/activeServerAccountScope');
let connection: Awaited<ReturnType<typeof import('@/dev/testkit/harness/serverAccountConnectionHarness').restoreServerAccountForTest>> | undefined;

function projection(contentSearch?: boolean) {
    return PluginProjectionV2Schema.parse({
        v: 2, generation: 1,
        installedPackagesById: {
            'happier.external-sessions-fixture': { id: 'happier.external-sessions-fixture', displayName: 'Codex', enabled: true, source: { kind: 'bundled', locator: 'happier.external-sessions-fixture' } },
        },
        agentsById: {
            codex: { id: 'codex', title: 'Codex', externalSessions: {
                agent: { pluginId: 'happier.external-sessions-fixture', localId: 'codex' }, generation: 1,
                operations: { listCandidates: true, resolveLinkIdentity: true, pageTranscript: true, readAfterTranscript: true },
                sources: [{
                    sourceKind: 'codexHome', ...(contentSearch === undefined ? {} : { contentSearch }),
                    schema: { fields: [{ name: 'kind', kind: 'literal', value: 'codexHome' }, { name: 'home', kind: 'literal', value: 'user' }] },
                    key: { segments: [{ kind: 'literal', value: 'codexHome' }] },
                    instances: [{ kind: 'default', constants: { home: 'user' } }],
                }],
            } },
        },
    });
}

const hit = { remoteSessionId: 'hit', title: 'Unrelated title', updatedAtMs: 1,
    match: { snippet: 'A body-only phrase', sourceItemId: 'source-item', messageIndex: 91 } };
const page = { ok: true, candidates: [hit, { remoteSessionId: 'native-only', title: 'Native thread', updatedAtMs: 1 }], nextCursor: 'next', contentCoverage: 'partial' } as const;
const transcriptPage = { ok: true, hasMore: false, items: [
    { id: 'prompt', createdAtMs: 1, raw: { role: 'user', content: { type: 'text', text: 'Explain this failure' } } },
    { id: 'source-item', createdAtMs: 2, raw: { role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'text', text: 'A body-only phrase in the full response' } } } },
] } satisfies Extract<Awaited<ReturnType<typeof import('@/sync/ops/machineExternalSessions').machineExternalSessionTranscriptPage>>, { ok: true }>;

function props() {
    const accountLifetime = scopeOwner.captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('Account fixture did not mount');
    return {
        target: { machineId: 'machine-1', serverId: boundary.serverId, accountId: 'account-a' },
        query: 'body-only phrase', machineLabel: 'Devbox', accountLifetime,
        onBack: vi.fn(), onRequestClose: vi.fn(), onOpenSession: vi.fn(),
    };
}

function sourceKey() {
    const option = resolveExternalSessionBrowseSourceOptions({
        accountScope: { serverId: boundary.serverId, accountId: 'account-a' },
        providerId: 'codex', machineId: 'machine-1', projection: projection(true),
        profile: null, labelsByKey: {}, activeServerId: boundary.serverId,
    })[0];
    if (!option) throw new Error('Projected source fixture did not materialize');
    return JSON.stringify(['machine-1', option.key]);
}

describe('activated external conversation results', () => {
    beforeEach(async () => {
        for (const boundary of socketBoundaries()) {
            boundary.socket.emitWithAck.mockClear();
            boundary.socket.emit.mockClear();
        }
        network.resetRequests();
        homeIdsByUrl.clear();
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState(storage.getInitialState(), true);
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        scopeOwner = await import('@/sync/domains/scope/activeServerAccountScope');
        boundary.list.mockReset().mockResolvedValue(page);
        boundary.ensure.mockReset().mockResolvedValue({ ok: true, sessionId: 'linked', created: true });
        boundary.page.mockReset().mockResolvedValue(transcriptPage);
        boundary.routerPush.mockReset();
        boundary.projection.mockReset().mockResolvedValue({ supported: true, projection: projection(true) });
        const home = await network.addHome('https://palette-history.test', 'account-a');
        homeIdsByUrl.set(home.serverUrl, home.id);
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        boundary.serverId = home.id;
        const { clearMachineRequestReachabilityForMachine } = await import('@/sync/domains/machines/reachability/machineReachability');
        clearMachineRequestReachabilityForMachine({ serverId: home.id, accountId: 'account-a' }, 'machine-1');
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
        registerStorageStateReader(() => storage.getState());
        const httpResponse: Parameters<typeof network.setHttpResponder>[0] = async input => {
            const url = new URL(String(input));
            if (url.pathname === '/health') return Response.json({});
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 0,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                experiments: true, featureToggles: { 'memory.search': true },
            } }, version: 1 });
            if (url.pathname === '/v1/machines') return Response.json([
                createPlainMachineRowFixture({ id: 'machine-1', accountId: url.origin === home.serverUrl ? 'account-a' : 'account-b' }),
            ]);
            if (url.pathname === '/v1/machines/machine-1') return Response.json({ machine:
                createPlainMachineRowFixture({ id: 'machine-1', accountId: url.origin === home.serverUrl ? 'account-a' : 'account-b' }) });
            return null;
        };
        network.setHttpResponder(httpResponse);
        network.setRpcResponder(async call => {
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return DEFAULT_MEMORY_SETTINGS;
            const serverId = homeIdsByUrl.get(call.serverUrl);
            if (!serverId) throw new Error('Unknown fixture Home route');
            const request = { ...(call.payload as Record<string, unknown>), machineId: call.targetId };
            const options = { serverId, accountId: call.token ? parseToken(call.token) : null };
            if (call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST) return boundary.list(request, options);
            if (call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE) return boundary.ensure(request, options);
            if (call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE) return boundary.page(request, options);
            if (call.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                const { supported, ...answer } = await boundary.projection(call.targetId, { serverId });
                if (!supported) throw new Error('Unexpected unavailable projection fixture');
                return { protocolVersion: 1, ...answer };
            }
            throw new Error(`Unexpected conversation RPC ${call.method}`);
        });
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        connection = await restoreServerAccountForTest({ serverUrl: home.serverUrl, accountId: 'account-a', credentials: { token: home.token },
            additionalRequestOrigins: ['https://palette-foreign.test'], request: httpResponse });
        storage.setState({
            isDataReady: true,
            profileScope: { serverId: home.id, accountId: 'account-a' },
            settingsScope: { serverId: home.id, accountId: 'account-a' }, settingsVersion: 1,
            settings: { ...storage.getState().settings, experiments: true, featureToggles: { 'memory.search': true } },
            machineListByServerId: { [home.id]: [createMachineFixture({ activeAt: Date.now() })] },
            machineListStatusByServerId: { [home.id]: 'idle' },
        });
        clearDaemonMergedProjectionCacheForTests();
    });
    afterEach(async () => {
        standardCleanup();
        await connection?.dispose();
        connection = undefined;
        scopeOwner?.retireActiveServerAccountScopeLifetime();
    });
    afterAll(() => network.dispose());

    it('searches only the selected source after activation, pages explicitly, and opens the decoded hit with a mapped Find seed', async () => {
        const input = props();
        input.query = '  body-only phrase  ';
        const ordering: string[] = [];
        input.onRequestClose.mockImplementation(() => { ordering.push('close'); });
        input.onOpenSession.mockImplementation(() => { ordering.push('navigate'); });
        const screen = await renderScreen(<ExternalConversationSearchResults {...input} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(boundary.list).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1', agentId: 'codex', source: { kind: 'codexHome', home: 'user' },
            searchTarget: 'content', searchTerm: input.query,
        }), expect.objectContaining({ serverId: boundary.serverId }));
        expect(screen.findHostByTestId('external-session-candidate-match:hit')).not.toBeNull();
        expect(screen.findByTestId('external-conversation-open:native-only')).toBeNull();
        expect(boundary.list.mock.calls).toHaveLength(1);
        await screen.pressByTestIdAsync(`external-conversation-more:${sourceKey()}`);
        expect(boundary.list.mock.calls[1]?.[0]).toMatchObject({ cursor: 'next', searchTarget: 'content' });
        await screen.pressByTestIdAsync('external-conversation-open:hit');
        expect(input.onOpenSession).toHaveBeenCalledWith('linked', { machineId: 'machine-1', serverId: boundary.serverId }, {
            query: input.query, options: { matchCase: false, regex: false },
            target: { kind: 'route-message-id', routeMessageId: makeExternalSessionHistoricalImportLocalId({ agentId: 'codex', remoteSessionId: 'hit', directItemId: 'source-item' }) },
        });
        expect(ordering).toEqual(['close', 'navigate']);
    });

    it('loads the highlighted exchange only when wide, and opens it from there (lab H1r)', async () => {
        const input = props();
        const screen = await renderScreen(<ExternalConversationSearchResults {...input} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        const layout = (width: number) => act(async () => {
            screen.findByTestId('external-conversation-results')!.props.onLayout({ nativeEvent: { layout: { width, height: 560 } } });
        });
        await layout(420);
        expect(screen.findHostByTestId('external-conversation-preview')).toBeNull();
        expect(boundary.page).not.toHaveBeenCalled();
        await layout(800);
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('Explain this failure');
        expect(screen.getTextContent()).toContain('in the full response');
        expect(boundary.page).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1', agentId: 'codex', remoteSessionId: 'hit', direction: 'older',
        }), expect.objectContaining({ serverId: boundary.serverId, accountId: 'account-a' }));
        expect(screen.findHostByTestId('external-conversation-preview')?.props).toBeDefined();
        expect(findAllHostTestInstances(screen.root, node => typeof (node.props.onPress ?? node.props.onClick) === 'function'
            && node.findAll(child => typeof child.type === 'string' && child.children.includes('externalSessions.browseContentShow')).length > 0)).toHaveLength(1);
        expect(boundary.ensure).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('external-conversation-preview-open');
        expect(input.onOpenSession).toHaveBeenCalledWith('linked', { machineId: 'machine-1', serverId: boundary.serverId },
            expect.objectContaining({ query: input.query }));
    });

    it('keeps one cancellable progress band above retained results while paging', async () => {
        const pending = createDeferred<typeof page>();
        boundary.list.mockResolvedValueOnce(page).mockImplementationOnce(() => pending.promise);
        const screen = await renderScreen(<ExternalConversationSearchResults {...props()} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        await screen.pressByTestIdAsync(`external-conversation-more:${sourceKey()}`);
        await flushHookEffects();
        expect(screen.findHostByTestId('external-conversation-progress')).not.toBeNull();
        expect(screen.findAllHostsByTestId('external-conversation-stop')).toHaveLength(1);
        await screen.pressByTestIdAsync('external-conversation-stop');
        expect(screen.findHostByTestId('external-conversation-stop')).toBeNull();
        expect(screen.findHostByTestId('external-session-candidate-match:hit')).not.toBeNull();
        pending.resolve(page);
        await flushHookEffects();
    });

    it('finishes an empty conversation search with a query-specific empty state', async () => {
        boundary.list.mockResolvedValue({ ok: true, candidates: [], contentCoverage: 'complete' });
        const screen = await renderScreen(<ExternalConversationSearchResults {...props()} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(screen.findHostByTestId('external-conversation-none')).not.toBeNull();
        expect(screen.findHostByTestId('external-conversation-progress')).toBeNull();
        expect(screen.getTextContent()).not.toContain('externalSessions.browseNoSearchResults');
    });

    // Lab H1r: the palette keeps the query in its band, and a source with nothing to show draws no heading.
    it('keeps the query in a band with the way back, and lists no empty source', async () => {
        boundary.list.mockResolvedValue({ ok: true, candidates: [], contentCoverage: 'complete' });
        const input = props();
        const screen = await renderScreen(<ExternalConversationSearchResults {...input} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(screen.findHostByTestId('external-conversation-band:input')?.props.value).toBe('body-only phrase');
        expect(screen.findHostByTestId(`external-conversation-source:${sourceKey()}`)).toBeNull();
        await screen.pressByTestIdAsync('external-conversation-band:leading:back-chip');
        expect(input.onBack).toHaveBeenCalledTimes(1);
    });

    it('never sends content to an older source or displays metadata rows as matches', async () => {
        boundary.projection.mockResolvedValue({ supported: true, projection: projection() });
        const screen = await renderScreen(<ExternalConversationSearchResults {...props()} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(boundary.list).not.toHaveBeenCalled();
        expect(screen.findHostByTestId(`external-conversation-unsupported:${sourceKey()}`)).not.toBeNull();
        expect(screen.findHostByTestId('external-session-candidate-match:hit')).toBeNull();
    });

    it('reads the preceding prompt across a page boundary without showing the neighboring turn', async () => {
        const full = transcriptPage;
        boundary.page.mockResolvedValueOnce({ ok: true, hasMore: true, nextCursor: 'older', items: [
            full.items[1],
            { id: 'next-prompt', createdAtMs: 3, raw: { role: 'user', content: { type: 'text', text: 'Another unrelated turn' } } },
        ] }).mockResolvedValueOnce({ ok: true, hasMore: false, items: [full.items[0]] });
        const screen = await renderScreen(<ExternalConversationSearchResults {...props()} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        await act(async () => { screen.findByTestId('external-conversation-results')!.props.onLayout({ nativeEvent: { layout: { width: 800 } } }); });
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('Explain this failure');
        expect(screen.getTextContent()).not.toContain('Another unrelated turn');
        expect(boundary.page.mock.calls[1]?.[0].cursor).toBe('older');
    });

    it('cancels the selected preview on a new highlight and Account retirement, rejecting both late responses', async () => {
        boundary.list.mockResolvedValue({ ...page, candidates: [hit, { ...hit, remoteSessionId: 'other' }] });
        const response = transcriptPage;
        const first = createDeferred<typeof response>();
        const second = createDeferred<typeof response>();
        boundary.page.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
        const screen = await renderScreen(<ExternalConversationSearchResults {...props()} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        await act(async () => { screen.findByTestId('external-conversation-results')!.props.onLayout({ nativeEvent: { layout: { width: 800 } } }); });
        await flushHookEffects();
        const firstRequest = issuedRequestId(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE, 'hit');
        await act(async () => { screen.findByTestId('external-conversation-open:other')!.props.onFocus(); });
        await flushHookEffects();
        expect(wasCancelled(firstRequest)).toBe(true);
        first.resolve(response);
        await flushHookEffects();
        expect(screen.getTextContent()).not.toContain('Explain this failure');
        const secondRequest = issuedRequestId(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE, 'other');
        await act(async () => { scopeOwner.retireActiveServerAccountScopeLifetime(); });
        expect(wasCancelled(secondRequest)).toBe(true);
        second.resolve(response);
        await flushHookEffects();
        expect(screen.findHostByTestId('external-conversation-results')).toBeNull();
        expect(boundary.ensure).not.toHaveBeenCalled();
    });

    it('Stop aborts a pending page and Account retirement removes published rows and prevents opening', async () => {
        const pending = createDeferred<typeof page>();
        boundary.list.mockImplementationOnce(() => pending.promise);
        const input = props();
        const screen = await renderScreen(<ExternalConversationSearchResults {...input} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        await screen.pressByTestIdAsync('external-conversation-stop');
        expect(wasCancelled(issuedRequestId(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST))).toBe(true);
        pending.resolve(page);
        await flushHookEffects();
        expect(screen.findHostByTestId('external-session-candidate-match:hit')).toBeNull();
        await act(async () => { scopeOwner.retireActiveServerAccountScopeLifetime(); });
        expect(screen.findHostByTestId('external-conversation-results')).toBeNull();
        expect(input.onOpenSession).not.toHaveBeenCalled();
    });

    it('replaces an expired source page when Search more resets its cursor', async () => {
        boundary.list.mockResolvedValueOnce(page).mockResolvedValueOnce({ ok: true,
            candidates: [], cursorReset: true }).mockResolvedValueOnce({ ok: true,
            candidates: [{ ...hit, remoteSessionId: 'fresh' }], contentCoverage: 'complete' });
        const screen = await renderScreen(<ExternalConversationSearchResults {...props()} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        await screen.pressByTestIdAsync(`external-conversation-more:${sourceKey()}`);
        await flushHookEffects();
        expect(screen.findHostByTestId('external-session-candidate-match:hit') === null).toBe(true);
        expect(screen.findHostByTestId('external-session-candidate-match:fresh') !== null).toBe(true);
        expect(boundary.list.mock.calls.at(-1)?.[0].cursor).toBeUndefined();
    });

    it('removes published results and suppresses a pending link when the selected Account retires', async () => {
        const pending = createDeferred<{ ok: true; sessionId: string; created: boolean }>();
        boundary.ensure.mockImplementationOnce(() => pending.promise);
        const input = props();
        const screen = await renderScreen(<ExternalConversationSearchResults {...input} />);
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(screen.findHostByTestId('external-session-candidate-match:hit')).not.toBeNull();
        await screen.pressByTestIdAsync('external-conversation-open:hit');
        await flushHookEffects();
        expect(boundary.ensure).toHaveBeenCalled();
        await act(async () => { scopeOwner.retireActiveServerAccountScopeLifetime(); });
        expect(screen.findHostByTestId('external-conversation-results')).toBeNull();
        pending.resolve({ ok: true, sessionId: 'late-linked', created: true });
        await flushHookEffects();
        expect(input.onRequestClose).not.toHaveBeenCalled();
        expect(input.onOpenSession).not.toHaveBeenCalled();
    });

    it('keeps Show scoped to the online foreign Home when the foreground Home has an offline machine with the same id', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { useServerCredentialAccountScopes } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const foreign = await network.addHome('https://palette-foreign.test', 'account-b');
        homeIdsByUrl.set(foreign.serverUrl, foreign.id);
        storage.setState({
            settingsScope: { serverId: boundary.serverId, accountId: 'account-a' },
            machineListByServerId: {
                [boundary.serverId]: [createMachineFixture({ active: false, activeAt: Date.now() - 600_000 })],
                [foreign.id]: [createMachineFixture({ active: true, activeAt: Date.now() })],
            },
        });
        const input = props();
        input.query = '  body-only phrase  ';
        function ForeignResults() {
            const accountLifetime = useServerCredentialAccountScopes([foreign.id]).get(foreign.id);
            const [admitted, setAdmitted] = React.useState<typeof accountLifetime>();
            // Credential admission withdraws unproven retained rows. Publish this
            // fixture's scoped census after that admission, as the real runtime does.
            React.useLayoutEffect(() => {
                if (accountLifetime?.isCurrent()) {
                    storage.setState(state => ({
                        machineListByServerId: { ...state.machineListByServerId, [foreign.id]: [createMachineFixture({ active: true, activeAt: Date.now() })] },
                        machineListStatusByServerId: { ...state.machineListStatusByServerId, [foreign.id]: 'idle' },
                    }));
                    setAdmitted(accountLifetime);
                }
            }, [accountLifetime]);
            return accountLifetime && admitted === accountLifetime ? <ExternalConversationSearchResults {...input}
                target={{ machineId: 'machine-1', serverId: foreign.id, accountId: 'account-b' }}
                accountLifetime={accountLifetime} /> : null;
        }
        const screen = await renderScreen(<ForeignResults />);
        await flushHookEffects({ cycles: 6, turns: 2 });
        // Lazy transport admission can settle after the credential/census
        // render; wait for the observable request, not a fixed effect count.
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(boundary.list).toHaveBeenCalled();
        });
        const request = {
            machineId: 'machine-1', agentId: 'codex', source: { kind: 'codexHome', home: 'user' },
            searchTarget: 'content', searchTerm: input.query,
        };
        expect(boundary.list.mock.calls, JSON.stringify({ inventory: storage.getState().machineListByServerId,
            statuses: storage.getState().machineListStatusByServerId, projectionCalls: boundary.projection.mock.calls,
            text: findAllHostTestInstances(screen.root, node => node.children.some(child => typeof child === 'string')).map(node => node.children.filter(child => typeof child === 'string')) })).not.toHaveLength(0);
        expect(boundary.list).toHaveBeenCalledWith(expect.objectContaining(request), expect.objectContaining({ serverId: foreign.id }));
        boundary.list.mockClear();
        const show = findAllHostTestInstances(screen.root, (button) => typeof (button.props.onPress ?? button.props.onClick) === 'function'
            && button.findAll((node) => typeof node.type === 'string' && node.children.includes('externalSessions.browseContentShow')).length > 0).at(-1);
        await pressTestInstanceAsync(show, 'Show in External sessions');
        await flushHookEffects({ cycles: 6, turns: 2 });
        expect(boundary.list).toHaveBeenCalledWith(expect.objectContaining(request), expect.objectContaining({ serverId: foreign.id }));
        expect(boundary.list.mock.calls.every((call) => call[1]?.serverId === foreign.id && call[0].source.home === 'user')).toBe(true);
        expect(screen.findHostByTestId('external-session-candidate-match:hit')).not.toBeNull();
        await pressTestInstanceAsync(screen.findAllHostsByTestId('direct-session-candidate:hit').at(-1), 'browser content hit');
        await flushHookEffects();
        expect(boundary.ensure).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1', agentId: 'codex', remoteSessionId: 'hit', source: request.source,
        }), expect.objectContaining({ serverId: foreign.id }));
        const { buildScopedSessionRouteHref } = await import('@/hooks/session/sessionRouteServerScope');
        expect(boundary.routerPush).toHaveBeenCalledWith(buildScopedSessionRouteHref({ sessionId: 'linked', serverId: foreign.id }));
    });
});
