import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { MemoryDocumentSearchCoverageV1, MemorySearchResultHitV1 } from '@happier-dev/protocol/memory/memorySearch';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineAdministrationFixture } from '@/dev/testkit/fixtures/machineAdministrationFixture';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, options?: Record<string, unknown>) =>
        key === 'memoryContext.memory.factCount' ? `${options?.count} facts` : key });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const homes = createHomeGovernanceHarness();
installDisconnectedServerSocketBoundary();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { sync } = await import('@/sync/sync');
const { storage } = await import('@/sync/domains/state/storage');
const { MemorySearchPanel } = await import('./MemorySearchPanel');
const { useMemoryDocument } = await import('./useMemoryDocument');
const { useMemoryDocumentSummary } = await import('./useMemoryDocumentSummary');
const { MemoryDocumentBody } = await import('./MemoryDocumentBody');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
let administration: Awaited<ReturnType<typeof createMachineAdministrationFixture>>;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let webLocks: ReturnType<typeof installWebLockManagerMock>;
const baseline = storage.getState();
const transcript: MemorySearchResultHitV1 = {
    sessionId: 'past-session', seqFrom: 1, seqTo: 2, createdAtFromMs: 1, createdAtToMs: 2,
    summary: 'Matching past conversation', score: 0.5,
};
const document: MemorySearchResultHitV1 = {
    type: 'artifact', ref: { kind: 'doc', serverId: 'server-a', artifactId: 'memory-doc' },
    revision: { headerVersion: 1, bodyVersion: 2 }, location: { type: 'topic', title: 'Archive' },
    factId: 'fact-1', summary: 'Matching archived fact', score: 0.8,
};
const status = {
    v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: false, deepIndexReady: true, activeIndexReady: true,
    embeddingsEnabled: false, embeddingsMode: 'disabled', embeddingsPresetId: null, embeddingsProviderKind: null,
    embeddingsModelId: null, embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
    tier1DbPath: null, deepDbPath: '/memory/deep.sqlite', tier1DbBytes: null, deepDbBytes: 1,
};

beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    await homes.reset();
    storage.setState(baseline, true);
    administration = await createMachineAdministrationFixture('memory.settings');
    const machine = storage.getState().machineListByServerId[administration.serverIds[0]!]![0]!;
    await homes.addHome({ name: 'Memory Home', serverUrl: 'https://prompt-administration-1.example.test',
        serverIdentityId: 'srv_prompt_administration_1', accountId: 'account-a' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://prompt-administration-1.example.test',
        accountId: 'account-a', request: homes.request });
    installHomeGovernanceBoundaries(homes);
    storage.setState({ isDataReady: true, machines: { [machine.id]: machine },
        settings: { ...storage.getState().settings,
            machineAdministrationTargetsLocalV1: { 'memory.settings': administration.targets[0]! } },
    });
    storage.getState().activateProfileScope({ serverId: administration.serverIds[0]!, accountId: 'account-a' });
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = null;
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    await administration.cleanup();
    await homes.reset();
    machineRpc.mockReset();
    webLocks.restore();
});

async function search(coverage: MemoryDocumentSearchCoverageV1 | null, hits: readonly MemorySearchResultHitV1[]) {
    machineRpc.mockImplementation(async (request: Readonly<{ method: string }>) => request.method === RPC_METHODS.DAEMON_MEMORY_STATUS
        ? { ...status, ...(coverage ? { documentSearchSupported: true } : {}) }
        : { v: 1, ok: true, hits, ...(coverage ? { documents: coverage } : {}) });
    const screen = await renderScreen(<InjectedAuthProvider credentials={connection!.credentials}>
        <MemorySearchPanel testID="search" serverId={administration.serverIds[0]!} />
    </InjectedAuthProvider>);
    await flushHookEffects();
    expect(screen.findByTestId('search.input')?.props.editable).toBe(true);
    await act(async () => screen.findByTestId('search.input')!.props.onChangeText('fact'));
    await act(async () => {
        await vi.waitFor(() => expect(machineRpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)).toBe(true));
    });
    await flushHookEffects();
    return screen;
}

describe('MemorySearchPanel corpus coverage', () => {
    it('renders admitted loaded and indexed facts through the real selected-daemon summary path', async () => {
        const serverId = administration.serverIds[0]!;
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        const artifactId = await sync.createArtifactWithHeader({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }, JSON.stringify({
            v: 1, index: ['one', 'two'].map(id => ({ id, text: id, createdAtMs: 1, sourceSessionRef: null })),
            topics: [{ title: 'detail', summary: 'Topic', facts: [{ id: 'topic', text: 'Detail', createdAtMs: 1, sourceSessionRef: null }] }],
        }));
        homes.answer(serverId, '/v1/public-shares?' + new URLSearchParams({ subjectKind: 'artifact', subjectId: artifactId }), { body: { publicShares: [] } });
        const ref = { kind: 'doc' as const, serverId, artifactId };
        machineRpc.mockResolvedValue({ ...status, documents: { state: 'ready', facts: [{
            ref, revision: { headerVersion: 1, bodyVersion: 1 }, loadedFactCount: 1, indexedFactCount: 5,
        }] } });
        function Summary() {
            const source = useMemoryDocument({ ref, serverId });
            return <MemoryDocumentBody testID="summary-doc" source={source} serverId={serverId}
                preparationScope={{ type: 'session', sessionId: 'current-session' }}
                composing={false} onComposingChange={() => {}} emptyText="empty" />;
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection!.credentials}><Summary /></InjectedAuthProvider>);
        await act(async () => { await vi.waitFor(() => expect(screen.getTextContent()).toContain('5 facts')); });
        expect(screen.getTextContent()).toContain('1 facts');
        expect(screen.getTextContent()).not.toContain('2 facts');
    });
    it('keeps a fresh summary stable and refuses late scoped status after its context changes', async () => {
        const serverId = administration.serverIds[0]!;
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        const artifactId = await sync.createArtifactWithHeader({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }, JSON.stringify({
            v: 1, index: [{ id: 'key', text: 'Key fact', createdAtMs: 1, sourceSessionRef: null }], topics: [],
        }));
        homes.answer(serverId, '/v1/public-shares?' + new URLSearchParams({ subjectKind: 'artifact', subjectId: artifactId }), { body: { publicShares: [] } });
        const ref = { kind: 'doc' as const, serverId, artifactId };
        const response = (loadedFactCount: number) => ({ ...status, documents: { state: 'ready', facts: [{
            ref, revision: { headerVersion: 1, bodyVersion: 1 }, loadedFactCount, indexedFactCount: 5,
        }] } });
        const pending: ((value: unknown) => void)[] = [];
        machineRpc.mockResolvedValueOnce(response(1)).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
        const scope = { type: 'session' as const, sessionId: 'current-session' };
        const hook = await renderHook(({ basis }: { basis: string }) => {
            const source = useMemoryDocument({ ref, serverId });
            return useMemoryDocumentSummary({ source, serverId, scope, preparationBasis: basis });
        }, { initialProps: { basis: 'initial' }, wrapper: ({ children }) =>
            <InjectedAuthProvider credentials={connection!.credentials}>{children}</InjectedAuthProvider> });
        await act(async () => { await vi.waitFor(() => expect(hook.getCurrent()).toEqual({ state: 'ready', loadedFactCount: 1, indexedFactCount: 5 })); });
        await hook.rerender();
        expect(machineRpc.mock.calls).toHaveLength(1);
        await hook.rerender({ basis: 'changed' });
        expect(hook.getCurrent()).toEqual({ state: 'pending' });
        await hook.rerender({ basis: 'latest' });
        expect(machineRpc.mock.calls[1]?.[0].signal.aborted).toBe(true);
        await act(async () => pending[0]!(response(2)));
        expect(hook.getCurrent()).toEqual({ state: 'pending' });
        await act(async () => pending[1]!(response(3)));
        expect(hook.getCurrent()).toEqual({ state: 'ready', loadedFactCount: 3, indexedFactCount: 5 });
        await hook.rerender();
        expect(machineRpc.mock.calls).toHaveLength(3);
        await hook.unmount();
    });
    it('keeps older-daemon Session hits usable while identifying unavailable document search', async () => {
        const screen = await search(null, [transcript]);
        expect(screen.findByTestId('search.session.0')).toBeTruthy();
        expect(screen.findByTestId('search.documentsCoverage')).toBeTruthy();
        expect(screen.findByTestId('search.empty')).toBeNull();
    });
    it('shows pending document coverage alongside mixed usable hits', async () => {
        const screen = await search({ state: 'pending' }, [document, transcript]);
        expect(screen.findByTestId('search.remembered.0')).toBeTruthy();
        expect(screen.findByTestId('search.session.0')).toBeTruthy();
        expect(screen.findByTestId('search.documentsCoverage-spinner')).toBeTruthy();
    });
    it.each(['pending', 'unavailable'] as const)('does not claim ready-empty while document coverage is %s', async (state) => {
        const screen = await search({ state }, []);
        expect(screen.findByTestId('search.documentsCoverage')).toBeTruthy();
        expect(screen.findByTestId('search.empty')).toBeNull();
    });
    it('shows ready-empty only when the document corpus is ready', async () => {
        const screen = await search({ state: 'ready' }, []);
        expect(screen.findByTestId('search.documentsCoverage')).toBeNull();
        expect(screen.findByTestId('search.empty')).toBeTruthy();
    });
});
