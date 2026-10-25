import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
// The chooser imports Socket through the real Sync graph during collection.
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ renderItems: true }).module;
});
const outgoing: SocketRpcRequestPayload[] = [];
let respond: (payload: SocketRpcRequestPayload) => Promise<unknown>;
installDisconnectedServerSocketBoundary((socket) => {
    configureConnectedServerSocketBoundary(socket);
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (_event: string, payload: SocketRpcRequestPayload) => {
        if (typeof payload?.method !== 'string') return { ok: true };
        outgoing.push(payload);
        return await respond(payload);
    });
});
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

describe('machineWorkspaceFileList', () => {
    it('projects a real transport failure as a search failure in the targeted folder chooser', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { t } = await import('@/text');
        const { MachinePathBrowserView } = await import('@/components/ui/pathBrowser/MachinePathBrowserModal');
        respond = async (request) => request.method.endsWith('daemon.workspaceFiles.list.v1')
            ? { ok: false, errorCode: 'MACHINE_RPC_FAILED', error: 'relay failed' }
            : { ok: true, result: { ok: true, entries: [], truncated: false } };
        const screen = await renderScreen(React.createElement(MachinePathBrowserView, {
            machineId: 'm1', serverId, rootDirectoryPath: '/repo', variant: 'popover',
            onPickPath: () => {},
        }));
        try {
            await act(async () => { screen.changeTextByTestId('path-browser-search', 'src'); });
            await vi.waitFor(() => expect(outgoing.some(request => request.method.endsWith('daemon.workspaceFiles.list.v1'))).toBe(true));
            await vi.waitFor(() => {
                expect(screen.getTextContent()).toContain(t('errors.searchFailed'));
                expect(screen.getTextContent()).not.toContain(t('errors.daemonUnavailableBody'));
            });
        } finally { await screen.unmount(); }
    });
    it('preserves missing-method, transport/admission and invalid-response outcomes through filename search', async () => {
        const { searchWorkspaceFiles, WorkspaceFileSearchUnavailableError } = await import('@/sync/domains/workspaces/files/workspaceFileSearch');
        const cases = [
            { ack: { ok: true, result: { ok: false, errorCode: 'root_not_found' } }, code: 'root_not_found' },
            { ack: { ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, error: 'missing' }, code: 'method_unavailable' },
            { ack: { ok: false, errorCode: 'MACHINE_RPC_FAILED', error: 'transport' }, code: 'transport_failed' },
            { ack: { ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN, error: 'admission' }, code: 'transport_failed' },
            // Unknown fields violate the producer's strict response contract.
            { ack: { ok: true, result: { ok: true, paths: [], truncated: false, unexpected: true } }, code: 'invalid_response' },
        ];
        for (const testCase of cases) {
            respond = async () => testCase.ack;
            const failure = await searchWorkspaceFiles({
                scope: { serverId, machineId: 'm1', rootPath: '/repo' }, query: 'src', mode: 'glob',
            }).catch((error: unknown) => error);
            expect.soft(failure).toBeInstanceOf(WorkspaceFileSearchUnavailableError);
            expect.soft(failure).toMatchObject({ errorCode: testCase.code });
        }
    });
    beforeEach(async () => {
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        await loadSyncSingletonForTests();
        serverId = await homes.addHome({ name: 'Workspace', serverUrl: 'https://workspace-files.test', accountId: 'account-a' });
        homes.answer(serverId, '/v1/machines/m1', { body: { machine: createPlainMachineRowFixture({ id: 'm1', accountId: 'account-a' }) } });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://workspace-files.test', accountId: 'account-a', request: homes.request });
        installHomeGovernanceBoundaries(homes);
        outgoing.length = 0;
        respond = async () => ({ ok: true, result: { ok: true, paths: ['src/a.ts'], truncated: false } });
    });
    afterEach(async () => {
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        await connection?.dispose(); connection = undefined;
        await homes.reset();
        vi.restoreAllMocks();
    });

    it('sends only a typed exact-workspace request and forwards cancellation', async () => {
        const controller = new AbortController();
        const { machineWorkspaceFileList } = await import('./machineWorkspaceFileList');
        await expect(machineWorkspaceFileList('m1', { rootPath: '/repo', query: 'a', limit: 50 }, {
            serverId, accountId: 'account-a', signal: controller.signal,
        })).resolves.toEqual({ ok: true, paths: ['src/a.ts'], truncated: false });
        expect(outgoing).toMatchObject([{
            method: 'm1:daemon.workspaceFiles.list.v1', params: { rootPath: '/repo', query: 'a', limit: 50 },
        }]);
        expect(outgoing[0]?.timeoutMs).toBeNull();
        expect(outgoing[0]?.params).toMatchObject({ budgetMs: expect.any(Number) });
        const budget = (outgoing[0]?.params as { budgetMs: number }).budgetMs;
        expect(budget).toBeGreaterThan(0);
        expect(budget).toBeLessThanOrEqual(30_000);
        // The exact Machine row is read through the Machine read batch (a532f4a1e0).
        expect(homes.requestsFor('/v1/machines/read-batch')[0]?.serverId).toBe(serverId);

        // Abort while the genuine network acknowledgement is outstanding. The
        // same scoped RPC owner must surface cancellation rather than an empty
        // successful inventory or the old-daemon unavailability projection.
        let release: (() => void) | undefined;
        respond = async () => await new Promise((resolve) => { release = () => resolve({ ok: true, result: { ok: true, paths: [], truncated: false } }); });
        const pending = machineWorkspaceFileList('m1', { rootPath: '/repo' }, { serverId, accountId: 'account-a', signal: controller.signal });
        await vi.waitFor(() => expect(outgoing).toHaveLength(2));
        const rejected = expect(pending).rejects.toBeInstanceOf(Error);
        controller.abort();
        await rejected;
        release?.();
    });

    it('distinguishes a successful empty result from an unavailable old daemon', async () => {
        const { machineWorkspaceFileList } = await import('./machineWorkspaceFileList');
        respond = async () => ({ ok: true, result: { ok: true, paths: [], truncated: false } });
        await expect(machineWorkspaceFileList('m1', { rootPath: '/repo' }, { serverId, accountId: 'account-a' }))
            .resolves.toEqual({ ok: true, paths: [], truncated: false });
        respond = async () => ({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, error: 'method unavailable' });
        await expect(machineWorkspaceFileList('m1', { rootPath: '/repo' }, { serverId, accountId: 'account-a' }))
            .resolves.toEqual({ ok: false, errorCode: 'method_unavailable' });
    });
});
