import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { DEFAULT_MEMORY_SETTINGS } from '@happier-dev/protocol/memory/memorySettings';
import { MemorySearchQueryV1Schema, MemorySearchResultV1Schema } from '@happier-dev/protocol/memory/memorySearch';
import { MemoryStatusV1Schema } from '@happier-dev/protocol/memory/memoryStatus';
import { ExternalSessionsCandidatesListRequestSchema, ExternalSessionsCandidatesListResponseSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { act, createDeferred, renderHook } from '@/dev/testkit';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionFixture, installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
// Only the daemon's serialized Socket response is substituted; hook, store,
// Account lifetime, search operation, transport and strict candidate codec stay real.
const scans: Array<{ machineId: string; signal: AbortSignal; cursor?: string; page: ReturnType<typeof createDeferred<unknown>> }> = [];
const indexedPages: Array<{ cursor?: string; corpora?: readonly string[]; page: ReturnType<typeof createDeferred<unknown>> }> = [];
let memoryEnabled = false;
let memoryStatusAvailable = true;
let documentSearchSupported = false;
const readyIndex = MemoryStatusV1Schema.parse({
    v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: false, deepIndexReady: true,
    activeIndexReady: true, activeIndexSearchable: true, embeddingsEnabled: false,
    embeddingsMode: 'disabled', embeddingsPresetId: null, embeddingsProviderKind: null,
    embeddingsModelId: null, embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
    tier1DbPath: null, deepDbPath: null, tier1DbBytes: null, deepDbBytes: null,
});
installSessionActionRpcBoundary((request, context) => {
    if (request.method.endsWith(`:${RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET}`)) {
        return { ...DEFAULT_MEMORY_SETTINGS, enabled: memoryEnabled };
    }
    if (request.method.endsWith(`:${RPC_METHODS.DAEMON_MEMORY_STATUS}`)) {
        if (!memoryStatusAvailable) throw Object.assign(new Error('Memory readiness is unavailable'), { code: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        return { ...readyIndex, documentSearchSupported };
    }
    if (request.method.endsWith(`:${RPC_METHODS.DAEMON_MEMORY_SEARCH}`)) {
        const payload = MemorySearchQueryV1Schema.parse(request.params);
        const page = createDeferred<unknown>();
        indexedPages.push({ cursor: payload.cursor, corpora: payload.corpora, page });
        return page.promise;
    }
    expect(request.method.endsWith(`:${RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST}`)).toBe(true);
    const payload = ExternalSessionsCandidatesListRequestSchema.parse(request.params);
    const page = createDeferred<unknown>();
    scans.push({ machineId: request.method.slice(0, request.method.indexOf(':')), signal: context.signal, cursor: payload.cursor ?? undefined, page });
    return page.promise;
});
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { useConversationSearch } = await import('./useConversationSearch');
type Input = Parameters<typeof useConversationSearch>[0];
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let input: Input;
let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useConversationSearch>, Input>>> | undefined;
const completedPage = () => ExternalSessionsCandidatesListResponseSchema.parse({ ok: true,
    candidates: [{ remoteSessionId: 'native-hit', updatedAtMs: 10,
        match: { snippet: 'amber orchard', sourceItemId: 'message', messageIndex: 0 } }], contentCoverage: 'complete' });

beforeEach(async () => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Search continuity', serverUrl: 'https://search-continuity.test', accountId: 'account' });
    const rows = ['selected', 'unrelated'].map(id => createPlainMachineRowFixture({ id, accountId: 'account' }));
    homes.answer(serverId, '/v1/machines', { body: rows });
    for (const machine of rows) homes.answer(serverId, `/v1/machines/${machine.id}`, { body: { machine } });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://search-continuity.test', accountId: 'account', request: homes.request });
    installHomeGovernanceBoundaries(homes);
    const lifetime = captureActiveServerAccountScopeLifetime();
    expect(lifetime?.isCurrent()).toBe(true);
    storage.setState({ machineListByServerId: { [lifetime!.scope.serverId]: rows.map(row => createMachineFixture({ id: row.id, activeAt: Date.now() })) } });
    scans.length = 0;
    indexedPages.length = 0;
    memoryEnabled = false;
    memoryStatusAvailable = true;
    documentSearchSupported = false;
    input = { query: { v: 1, query: 'amber orchard', scope: { type: 'global' }, mode: 'auto', corpora: ['external_transcripts'] },
        machineIds: ['selected'], mode: 'standard', accountLifetime: lifetime,
        providers: { homeSessions: false, daemonEnabled: true },
        source: { agentId: 'claude', sourceKey: 'native', source: { kind: 'claudeConfig' }, contentSearch: true } };
});
afterEach(async () => {
    await hook?.unmount(); hook = undefined;
    for (const scan of scans) scan.page.resolve(completedPage());
    for (const index of indexedPages) index.page.resolve(MemorySearchResultV1Schema.parse({ v: 1, ok: true, hits: [] }));
    await connection?.dispose();
});
async function changeInventory(change: (rows: NonNullable<ReturnType<typeof storage.getState>['machineListByServerId'][string]>) => ReturnType<typeof storage.getState>['machineListByServerId'][string]) {
    const serverId = input.accountLifetime!.scope.serverId;
    await act(async () => storage.setState(state => ({ machineListByServerId: {
        ...state.machineListByServerId, [serverId]: change(state.machineListByServerId[serverId]!),
    } })));
}
async function start() {
    hook = await renderHook(useConversationSearch, { initialProps: input });
    await vi.waitFor(() => expect(scans).toHaveLength(1));
}

describe('conversation search through real Account/store wiring', () => {
    it('cancels a stalled scan while its retained view is hidden and retries when presented again', async () => {
        let presented = true;
        hook = await renderHook(useConversationSearch, { initialProps: input,
            wrapper: ({ children }) => React.createElement(PluginSurfaceFocusEligibilityProvider, { active: presented, children }),
        });
        await vi.waitFor(() => expect(scans).toHaveLength(1));
        presented = false;
        await hook.rerender(input);
        expect(scans[0]!.signal.aborted).toBe(true);
        expect(hook.getCurrent().loading).toBe(false);
        presented = true;
        await hook.rerender(input);
        await vi.waitFor(() => expect(scans).toHaveLength(2));
        await act(async () => { scans[1]!.page.resolve(completedPage()); });
        await vi.waitFor(() => expect(hook!.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().result?.hits).toHaveLength(1);
    });

    it('refreshes empty-query source availability when the exact machine becomes reachable', async () => {
        const { isMachineReachable, recordMachineRequestFailed, recordMachineRequestSucceeded,
            clearMachineRequestReachabilityForMachine } = await import('@/sync/domains/machines/reachability/machineReachability');
        input = { ...input, query: { ...input.query, query: '' }, mode: 'indexed' };
        const scope = input.accountLifetime!.scope;
        const observation = { ...scope, machineId: 'selected' };
        recordMachineRequestFailed(observation);
        try {
            hook = await renderHook(useConversationSearch, { initialProps: input });
            await vi.waitFor(() => expect(hook!.getCurrent().result?.machines).toMatchObject([
                { machineId: 'selected', status: 'offline', standardSearchEnabled: false },
            ]));
            await act(async () => { recordMachineRequestSucceeded(observation); });
            expect(isMachineReachable(scope, createMachineFixture({ id: 'selected', activeAt: Date.now() }))).toBe(true);
            await vi.waitFor(() => expect(hook!.getCurrent().result?.machines).toMatchObject([
                { machineId: 'selected', standardSearchEnabled: true },
            ]));
            expect(scans).toHaveLength(0);
        } finally { clearMachineRequestReachabilityForMachine(scope, 'selected'); }
    });

    it('merges a changed-file pass by native candidate identity even when its matched message changes', async () => {
        await start();
        const candidate = { remoteSessionId: 'native-hit', candidateKey: 'project-a-native-hit', updatedAtMs: 10,
            match: { snippet: 'amber orchard', sourceItemId: 'first-message', messageIndex: 0 } };
        await act(async () => scans[0].page.resolve(ExternalSessionsCandidatesListResponseSchema.parse({
            ok: true, candidates: [candidate], nextCursor: 'changed-pass', contentCoverage: 'partial',
        })));
        await vi.waitFor(() => expect(hook!.getCurrent().loading).toBe(false));
        let pending!: Promise<void>;
        await act(async () => { pending = hook!.getCurrent().loadMore(hook!.getCurrent().result!.continuations![0]); });
        await vi.waitFor(() => expect(scans).toHaveLength(2));
        expect(scans[1].cursor).toBe('changed-pass');
        await act(async () => {
            scans[1].page.resolve(ExternalSessionsCandidatesListResponseSchema.parse({ ok: true, contentCoverage: 'complete',
                candidates: [{ ...candidate, updatedAtMs: 20,
                    match: { snippet: 'amber orchard changed', sourceItemId: 'second-message', messageIndex: 1 } },
                    { ...candidate, candidateKey: 'project-b-native-hit' }],
            }));
            await pending;
        });
        const hits = hook!.getCurrent().result!.hits;
        expect(hits).toHaveLength(2);
        expect(hits.filter(row => row.mode === 'standard' && row.candidate.candidateKey === candidate.candidateKey))
            .toMatchObject([{ candidate: { updatedAtMs: 20, match: { sourceItemId: 'second-message' } } }]);
    });
    it('keeps a typed failed source beside successful hits and retries only that source through the page owner', async () => {
        input = { ...input, machineIds: ['selected', 'unrelated'] };
        hook = await renderHook(useConversationSearch, { initialProps: input });
        await vi.waitFor(() => expect(scans).toHaveLength(2));
        await act(async () => {
            scans.find(scan => scan.machineId === 'selected')!.page.resolve(ExternalSessionsCandidatesListResponseSchema.parse({
                ok: false, errorCode: 'agent_error', error: 'private native path', retryable: true,
            }));
            scans.find(scan => scan.machineId === 'unrelated')!.page.resolve(completedPage());
        });
        await vi.waitFor(() => expect(hook!.getCurrent().loading).toBe(false));
        const result = hook!.getCurrent().result!;
        expect(result).toMatchObject({ hits: [{ machineId: 'unrelated' }], failures: [{
            machineId: 'selected', agentId: 'claude', sourceKey: 'native', errorCode: 'agent_error', retryable: true,
        }] });
        const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
        const schema = getActionSpec('search.conversations').outputSchema!;
        expect(schema.parse(result)).toEqual(result);
        expect(schema.safeParse({ ...result, failures: [{ ...result.failures![0], retryable: 'true' }] }).success).toBe(false);
        expect(schema.safeParse({ ...result, unexpected: true }).success).toBe(false);
        let pending!: Promise<void>;
        await act(async () => { pending = hook!.getCurrent().loadMore(result.failures![0]); });
        await vi.waitFor(() => expect(scans).toHaveLength(3));
        expect(scans[2]).toMatchObject({ machineId: 'selected', cursor: undefined });
        expect(hook!.getCurrent().result!.hits).toEqual(result.hits);
        await act(async () => { scans[2].page.reject(new Error('Native transport failed')); await pending; });
        expect(hook!.getCurrent().result).toMatchObject({ failures: [{ machineId: 'selected', sourceKey: 'native',
            errorCode: 'internal_error', retryable: true }], hits: result.hits });
        await act(async () => { pending = hook!.getCurrent().loadMore(hook!.getCurrent().result!.failures![0]); });
        await vi.waitFor(() => expect(scans).toHaveLength(4));
        expect(scans[3]).toMatchObject({ machineId: 'selected', cursor: undefined });
        await act(async () => { scans[3].page.resolve(completedPage()); await pending; });
        expect(hook!.getCurrent().result).toMatchObject({ failures: [], hits: expect.arrayContaining(result.hits) });
        expect(hook!.getCurrent().result!.hits).toHaveLength(2);
    });
    it('retains document coverage when a conversation continuation does not search documents again', async () => {
        memoryEnabled = true;
        documentSearchSupported = true;
        input = { ...input, mode: 'indexed', source: undefined,
            query: { ...input.query, corpora: ['sessions', 'documents'] } };
        hook = await renderHook(useConversationSearch, { initialProps: input });
        await vi.waitFor(() => expect(indexedPages).toHaveLength(2));
        const conversation = indexedPages.find(page => page.corpora?.includes('sessions'))!;
        const documents = indexedPages.find(page => page.corpora?.includes('documents'))!;
        await act(async () => {
            conversation.page.resolve(MemorySearchResultV1Schema.parse({ v: 1, ok: true, hits: [],
                hasMore: true, nextCursor: 'conversation-more' }));
            documents.page.resolve(MemorySearchResultV1Schema.parse({ v: 1, ok: true, hits: [], documents: { state: 'ready' } }));
        });
        await vi.waitFor(() => expect(hook!.getCurrent().loading).toBe(false));
        expect(hook!.getCurrent().result!.machines[0].documents).toBe('ready');
        let pending!: Promise<void>;
        await act(async () => { pending = hook!.getCurrent().loadMore(hook!.getCurrent().result!.continuations![0]); });
        await vi.waitFor(() => expect(indexedPages).toHaveLength(3));
        expect(indexedPages[2]).toMatchObject({ cursor: 'conversation-more', corpora: ['sessions'] });
        await act(async () => {
            indexedPages[2].page.resolve(MemorySearchResultV1Schema.parse({ v: 1, ok: true, hits: [], hasMore: false }));
            await pending;
        });
        expect(hook!.getCurrent().result!.machines[0].documents).toBe('ready');
    });
    it.each([true, false])('retains the indexed producer cursor after a failed memory page and resumes the same index (readiness available: %s)', async available => {
        memoryEnabled = true;
        memoryStatusAvailable = available;
        input = { ...input, mode: 'indexed', source: undefined, query: { ...input.query, corpora: ['sessions'] } };
        hook = await renderHook(useConversationSearch, { initialProps: input });
        await vi.waitFor(() => expect(indexedPages).toHaveLength(1));
        await act(async () => indexedPages[0].page.resolve(MemorySearchResultV1Schema.parse({
            v: 1, ok: true, hits: [], hasMore: true, nextCursor: 'index-remaining',
        })));
        await vi.waitFor(() => expect(hook!.getCurrent().loading).toBe(false));
        expect(hook!.getCurrent().result!.continuations).toEqual([{ machineId: 'selected', cursor: 'index-remaining' }]);
        const continuation = hook!.getCurrent().result!.continuations![0];
        let failed!: Promise<void>;
        await act(async () => { failed = hook!.getCurrent().loadMore(continuation); });
        await vi.waitFor(() => expect(indexedPages).toHaveLength(2));
        expect(indexedPages[1].cursor).toBe(continuation.cursor);
        await act(async () => { indexedPages[1].page.reject(new Error('MACHINE_RPC_TIMEOUT')); await failed; });
        expect(hook!.getCurrent()).toMatchObject({ loading: false,
            result: { machines: [{ machineId: 'selected', status: 'partial' }], continuations: [continuation] } });
        let resumed!: Promise<void>;
        await act(async () => { resumed = hook!.getCurrent().loadMore(hook!.getCurrent().result!.continuations![0]); });
        await vi.waitFor(() => expect(indexedPages).toHaveLength(3));
        expect(indexedPages[2].cursor).toBe(continuation.cursor);
        await act(async () => { indexedPages[2].page.resolve(MemorySearchResultV1Schema.parse({
            v: 1, ok: true, hits: [], hasMore: false,
        })); await resumed; });
        expect(hook!.getCurrent()).toMatchObject({ loading: false,
            result: { machines: [{ machineId: 'selected' }], continuations: [] } });
    });

    it('updates Home failure and recovery coverage while retaining hits, producer cursors and unrelated Machine coverage', async () => {
        input = { ...input, machineIds: undefined, mode: 'auto',
            providers: { homeSessions: true, daemonEnabled: true }, query: { ...input.query, corpora: ['sessions', 'external_transcripts'] } };
        const serverId = input.accountLifetime!.scope.serverId;
        const homeHit = (sessionId: string, time: number) => ({ sessionId, seqFrom: 1, seqTo: 1,
            createdAtFromMs: time, createdAtToMs: time, summary: 'amber orchard', score: 0.5 });
        for (const id of ['home-first', 'home-second']) installSessionActionFixture({ homes, storage, serverId,
            session: { id, encryptionMode: 'plain', seq: 1 } });
        homes.answer(serverId, '/v1/home/search', { body: MemorySearchResultV1Schema.parse({
            v: 1, ok: true, hits: [homeHit('home-first', 1)], hasMore: true, nextCursor: 'home-remaining',
        }) });
        hook = await renderHook(useConversationSearch, { initialProps: input });
        await vi.waitFor(() => expect(scans).toHaveLength(2));
        await act(async () => {
            for (const scan of scans) scan.page.resolve(ExternalSessionsCandidatesListResponseSchema.parse({
                ...completedPage(), ...(scan.machineId === 'selected' ? { contentCoverage: 'partial', nextCursor: 'native-remaining' } : {}),
            }));
        });
        await vi.waitFor(() => expect(hook!.getCurrent()).toMatchObject({ loading: false,
            result: { homeStatus: 'partial' } }));
        const retainedHits = hook!.getCurrent().result!.hits;
        expect(retainedHits).toHaveLength(3);
        expect(retainedHits).toEqual(expect.arrayContaining([
            expect.objectContaining({ machineId: null, hit: expect.objectContaining({ sessionId: 'home-first' }) }),
            expect.objectContaining({ machineId: 'selected', candidate: expect.objectContaining({ remoteSessionId: 'native-hit' }) }),
        ]));
        const continuation = hook!.getCurrent().result!.continuations!.find(value => value.machineId === null)!;
        const nativeContinuation = hook!.getCurrent().result!.continuations!.find(value => value.machineId === 'selected')!;
        expect(continuation).toEqual({ machineId: null, cursor: 'home-remaining' });
        homes.answer(serverId, '/v1/home/search', { status: 503 });
        await act(async () => hook!.getCurrent().loadMore(continuation));
        const failedRequest = homes.requestsFor('/v1/home/search').at(-1)!;
        expect(failedRequest.serverId).toBe(serverId);
        expect(MemorySearchQueryV1Schema.parse(failedRequest.input).cursor).toBe(continuation.cursor);
        expect(hook!.getCurrent()).toMatchObject({ loading: false, error: null,
            result: { homeStatus: 'unavailable', hits: retainedHits } });
        expect(hook!.getCurrent().result!.continuations).toEqual(expect.arrayContaining([continuation, nativeContinuation]));
        let nativePage!: Promise<void>;
        await act(async () => { nativePage = hook!.getCurrent().loadMore(nativeContinuation); });
        await vi.waitFor(() => expect(scans).toHaveLength(3));
        expect(scans[2].cursor).toBe(nativeContinuation.cursor);
        expect(scans[2].machineId).toBe(nativeContinuation.machineId);
        await act(async () => { scans[2].page.resolve(completedPage()); await nativePage; });
        expect(hook!.getCurrent()).toMatchObject({ loading: false, error: null,
            result: { homeStatus: 'unavailable', hits: retainedHits, continuations: [continuation] } });
        homes.answer(serverId, '/v1/home/search', { body: MemorySearchResultV1Schema.parse({
            v: 1, ok: true, hits: [homeHit('home-second', 2)], hasMore: false,
        }) });
        await act(async () => hook!.getCurrent().loadMore(hook!.getCurrent().result!.continuations![0]));
        const resumedRequest = homes.requestsFor('/v1/home/search').at(-1)!;
        expect(resumedRequest.serverId).toBe(serverId);
        expect(MemorySearchQueryV1Schema.parse(resumedRequest.input).cursor).toBe(continuation.cursor);
        expect(hook!.getCurrent()).toMatchObject({ loading: false, error: null,
            result: { homeStatus: 'ok', continuations: [] } });
        expect(hook!.getCurrent().result!.hits).toHaveLength(4);
        expect(hook!.getCurrent().result!.hits).toEqual(expect.arrayContaining([...retainedHits,
            expect.objectContaining({ machineId: null, hit: expect.objectContaining({ sessionId: 'home-second' }) }),
        ]));
    });

    it.each(['transport failure', 'Agent timeout'] as const)('keeps Search more after repeated empty incomplete pages and %s', async failure => {
        await start();
        const emptyPage = (cursor: string) => ExternalSessionsCandidatesListResponseSchema.parse({
            ok: true, candidates: [], contentCoverage: 'partial', searchIncomplete: true, nextCursor: cursor,
        });
        await act(async () => scans[0].page.resolve(emptyPage('remaining-0')));
        await vi.waitFor(() => expect(hook!.getCurrent().loading).toBe(false));
        for (let pageIndex = 1; pageIndex <= 3; pageIndex++) {
            const continuation = hook!.getCurrent().result!.continuations![0];
            expect(continuation.cursor).toBe(`remaining-${pageIndex - 1}`);
            let pending!: Promise<void>;
            await act(async () => { pending = hook!.getCurrent().loadMore(continuation); });
            await vi.waitFor(() => expect(scans).toHaveLength(pageIndex + 1));
            expect(scans[pageIndex].cursor).toBe(continuation.cursor);
            await act(async () => { scans[pageIndex].page.resolve(emptyPage(`remaining-${pageIndex}`)); await pending; });
            expect(hook!.getCurrent()).toMatchObject({ loading: false,
                result: { hits: [], machines: [{ status: 'partial' }], continuations: [{ cursor: `remaining-${pageIndex}` }] } });
        }

        const continuation = hook!.getCurrent().result!.continuations![0];
        let failed!: Promise<void>;
        await act(async () => { failed = hook!.getCurrent().loadMore(continuation); });
        await vi.waitFor(() => expect(scans).toHaveLength(5));
        await act(async () => {
            if (failure === 'transport failure') scans[4].page.reject(new Error('MACHINE_RPC_TIMEOUT'));
            else scans[4].page.resolve(ExternalSessionsCandidatesListResponseSchema.parse({
                ok: false, errorCode: 'agent_timeout', error: 'Agent did not return a page',
            }));
            await failed;
        });
        expect(hook!.getCurrent()).toMatchObject({ loading: false,
            result: { hits: [], machines: [{ status: 'partial' }], continuations: [continuation] } });

        let resumed!: Promise<void>;
        await act(async () => { resumed = hook!.getCurrent().loadMore(hook!.getCurrent().result!.continuations![0]); });
        await vi.waitFor(() => expect(scans).toHaveLength(6));
        expect(scans[5].cursor).toBe(continuation.cursor);
        await act(async () => { scans[5].page.resolve(completedPage()); await resumed; });
        expect(hook!.getCurrent()).toMatchObject({ loading: false,
            result: { hits: [{ candidate: { remoteSessionId: 'native-hit' } }], machines: [{ status: 'ok' }], continuations: [] } });
    });

    it('discards a rejected cursor before retrying from the source root, even when that retry fails', async () => {
        await start();
        await act(async () => scans[0].page.resolve(ExternalSessionsCandidatesListResponseSchema.parse({
            ...completedPage(), contentCoverage: 'partial', nextCursor: 'retired-cursor',
        })));
        await vi.waitFor(() => expect(hook!.getCurrent().loading).toBe(false));
        let pending!: Promise<void>;
        await act(async () => { pending = hook!.getCurrent().loadMore(hook!.getCurrent().result!.continuations![0]); });
        await vi.waitFor(() => expect(scans).toHaveLength(2));
        expect(scans[1].cursor).toBe('retired-cursor');
        await act(async () => scans[1].page.resolve(ExternalSessionsCandidatesListResponseSchema.parse({
            ok: true, candidates: [], cursorReset: true,
        })));
        await vi.waitFor(() => expect(scans).toHaveLength(3));
        expect(scans[2].cursor).toBeUndefined();
        await act(async () => { scans[2].page.reject(new Error('MACHINE_RPC_TIMEOUT')); await pending; });
        expect(hook!.getCurrent()).toMatchObject({ loading: false,
            result: { machines: [{ status: 'partial' }], continuations: [] } });
    });

    it('keeps the selected scan and its first page through reorders and unrelated availability changes', async () => {
        await start();
        await changeInventory(rows => [...rows].reverse().map(row => row.id === 'unrelated' ? { ...row, active: false } : row));
        await hook!.rerender({ ...input, machineIds: ['selected', 'selected'] });
        expect(scans[0].signal.aborted).toBe(false);
        expect(scans).toHaveLength(1);
        await act(async () => scans[0].page.resolve(completedPage()));
        await vi.waitFor(() => expect(hook!.getCurrent()).toMatchObject({ loading: false, result: {
            hits: [{ candidate: { remoteSessionId: 'native-hit' } }],
        } }));
    });

    it('keeps all-Machine hits and cursors when background inventory membership and presence change', async () => {
        input = { ...input, machineIds: undefined };
        hook = await renderHook(useConversationSearch, { initialProps: input });
        await vi.waitFor(() => expect(scans).toHaveLength(2));
        await changeInventory(rows => [...rows].reverse());
        expect(scans.every(scan => !scan.signal.aborted)).toBe(true);
        expect(scans).toHaveLength(2);
        await act(async () => {
            for (const scan of scans) scan.page.resolve(ExternalSessionsCandidatesListResponseSchema.parse({
                ...completedPage(), contentCoverage: 'partial', nextCursor: 'remaining',
            }));
        });
        await vi.waitFor(() => expect(hook!.getCurrent().loading).toBe(false));
        const result = hook!.getCurrent().result;
        await changeInventory(rows => rows.filter(row => row.id === 'selected').map(row => ({ ...row, active: false })));
        expect(hook!.getCurrent().result).toBe(result);
        expect(scans.every(scan => !scan.signal.aborted)).toBe(true);
        expect(scans).toHaveLength(2);
    });

    it('retires the in-flight scan when the real Account lifetime ends', async () => {
        await start();
        await act(async () => connection.dispose());
        expect(input.accountLifetime!.isCurrent()).toBe(false);
        expect(scans[0].signal.aborted).toBe(true);
        await act(async () => scans[0].page.resolve(completedPage()));
        expect(hook!.getCurrent()).toMatchObject({ loading: false, result: null });
    });

    it('keeps Stop across inventory changes, fences late pages, and allows explicit Retry', async () => {
        await start();
        await act(async () => hook!.getCurrent().cancel());
        expect(scans[0].signal.aborted).toBe(true);
        await changeInventory(rows => [...rows].reverse().map(row => ({ ...row, active: false })));
        await act(async () => scans[0].page.resolve(completedPage()));
        expect(hook!.getCurrent()).toMatchObject({ loading: false, cancelled: true });
        expect(hook!.getCurrent().result?.hits ?? []).toEqual([]);
        expect(scans).toHaveLength(1);
        await act(async () => hook!.getCurrent().reload());
        await vi.waitFor(() => expect(scans).toHaveLength(2));
        await act(async () => scans[1].page.resolve(completedPage()));
        await vi.waitFor(() => expect(hook!.getCurrent()).toMatchObject({ loading: false,
            result: { hits: [{ candidate: { remoteSessionId: 'native-hit' } }] } }));
    });

    it('keeps selected presence changes out of query identity; explicit query and source changes still restart', async () => {
        await start();
        await changeInventory(rows => rows.map(row => row.id === 'selected' ? { ...row, active: false } : row));
        expect(scans[0].signal.aborted).toBe(false);
        expect(scans).toHaveLength(1);
        await changeInventory(rows => rows.map(row => ({ ...row, active: true })));
        expect(scans).toHaveLength(1);
        await act(async () => hook!.getCurrent().cancel());
        input = { ...input, query: { ...input.query, query: 'silver meadow' } };
        await hook!.rerender(input);
        await vi.waitFor(() => expect(scans).toHaveLength(2));
        input = { ...input, source: { ...input.source!, sourceKey: 'other-native' } };
        await hook!.rerender(input);
        await vi.waitFor(() => expect(scans).toHaveLength(3));
        expect(scans[1].signal.aborted).toBe(true);
    });

    it.each(['unmount', 'Account retirement'])('retains published hits through Stop, resumes the same page and aborts its fresh request on %s', async retirement => {
        await start();
        await act(async () => scans[0].page.resolve(ExternalSessionsCandidatesListResponseSchema.parse({
            ...completedPage(), contentCoverage: 'partial', nextCursor: 'remaining',
        })));
        await vi.waitFor(() => expect(hook!.getCurrent().loading).toBe(false));
        const continuation = hook!.getCurrent().result!.continuations![0];
        let pending!: Promise<void>;
        await act(async () => { pending = hook!.getCurrent().loadMore(continuation); });
        await vi.waitFor(() => expect(scans).toHaveLength(2));
        await act(async () => hook!.getCurrent().cancel());
        await changeInventory(rows => rows.map(row => ({ ...row, active: false })));
        await act(async () => { scans[1].page.resolve(completedPage()); await pending; });
        expect(hook!.getCurrent()).toMatchObject({ loading: false, cancelled: true,
            result: { hits: [{ candidate: { remoteSessionId: 'native-hit' } }], continuations: [continuation] } });
        expect(scans).toHaveLength(2);
        let resumed!: Promise<void>;
        await act(async () => { resumed = hook!.getCurrent().loadMore(continuation); });
        await vi.waitFor(() => expect(scans).toHaveLength(3));
        expect(scans[2].cursor).toBe(continuation.cursor);
        expect(scans[2].signal.aborted).toBe(false);
        expect(hook!.getCurrent()).toMatchObject({ loading: true, cancelled: false,
            result: { hits: [{ candidate: { remoteSessionId: 'native-hit' } }] } });
        if (retirement === 'unmount') await hook!.unmount();
        else await act(async () => connection.dispose());
        expect(scans[2].signal.aborted).toBe(true);
        await act(async () => { scans[2].page.resolve(completedPage()); await resumed; });
        if (retirement !== 'unmount') expect(hook!.getCurrent()).toMatchObject({ loading: false, result: null });
    });
});
