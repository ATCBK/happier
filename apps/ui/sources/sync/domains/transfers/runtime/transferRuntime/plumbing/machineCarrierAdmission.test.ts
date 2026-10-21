import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const socketMachineRpc = vi.hoisted(() => vi.fn());

// Socket.IO is the genuine active-Home machine-RPC network boundary. The
// finite-transfer families below stay real so this records any preparation or
// legacy bulk RPC that escapes admission.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary(socket => {
    configureConnectedServerSocketBoundary(socket);
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(socketMachineRpc);
});

const { storage } = await import('@/sync/domains/state/storage');
const { resolveMachineCarrierRoute } = await import('./machineCarrierHttpLease');
// Load real entry points before observing operation-only network admission;
// cold graph loading otherwise lets unrelated Account bootstrap join the trace.
const { downloadDaemonWorkspaceFileToDestination } = await import('../families/workspaceFileTransfers');
const { uploadSessionAttachmentFromReaderViaMachineCarrier } = await import('../families/uploadSessionAttachmentFromReaderViaMachineCarrier');

describe('mandatory finite machine carrier admission', () => {
    let serverId: string;
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
    const networkRequests: string[] = [];

    beforeEach(async () => {
        installHomeGovernanceBoundaries(homes);
        serverId = await homes.addHome({ name: 'Admission Home', serverUrl: 'https://machine-admission.example.test',
            accountId: 'account-a' });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://machine-admission.example.test', accountId: 'account-a', request: homes.request });
        expect(serverId).not.toBe('');
        networkRequests.length = 0;
        socketMachineRpc.mockReset();
        socketMachineRpc.mockResolvedValue({ success: false, error: 'Unexpected machine RPC' });
        storage.setState({ machines: {}, machineListByServerId: {} });
        setRuntimeFetch(async (input, init) => {
            const path = new URL(String(input)).pathname;
            // Account capture may legitimately read its Home baseline. The
            // admission contract forbids feature/Machine/grant/byte work, not
            // authentication or Account currentness reads.
            if (!path.startsWith('/v1/features') && !path.startsWith('/v1/machines')
                && !path.startsWith('/machine-transfers/')) return await homes.request(input, init);
            networkRequests.push(String(input));
            return new Response('{}', { status: 503 });
        });
    });

    afterEach(async () => {
        resetRuntimeFetch();
        await connection?.dispose();
        await homes.reset();
        vi.restoreAllMocks();
    });

    it('refuses an unknown Machine before feature, grant, or transfer network work', async () => {
        await expect(resolveMachineCarrierRoute('machine-admission', serverId)).resolves.toMatchObject({
            kind: 'unavailable', errorCode: 'machine_carrier_unavailable',
        });
        expect(networkRequests).toEqual([]);
        expect(socketMachineRpc).not.toHaveBeenCalled();
    });

    it('refuses a running daemon without a current transfer declaration before network work', async () => {
        const machine = createMachineFixture({
            id: 'machine-admission',
            daemonState: { status: 'running' },
        });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });

        await expect(resolveMachineCarrierRoute(machine.id, serverId)).resolves.toMatchObject({
            kind: 'unavailable', errorCode: 'machine_carrier_unavailable',
        });
        expect(networkRequests).toEqual([]);
        expect(socketMachineRpc).not.toHaveBeenCalled();
    });

    it('refuses a workspace download before prepare without touching legacy bulk transports', async () => {
        const cleanup = vi.fn(async () => {});

        const result = await downloadDaemonWorkspaceFileToDestination({
            machineId: 'machine-admission',
            serverId,
            rootPath: '/repo',
            request: { path: 'README.md', asZip: false },
            destination: {
                writeBytes: async () => {},
                close: async () => {},
                cleanup,
            },
        });

        expect(result).toMatchObject({ ok: false, errorCode: 'machine_carrier_unavailable' });
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(networkRequests).toEqual([]);
        expect(socketMachineRpc).not.toHaveBeenCalled();
    });

    it('refuses an attachment upload before prepare and still closes the reader', async () => {
        const close = vi.fn(async () => {});

        const result = await uploadSessionAttachmentFromReaderViaMachineCarrier({
            machineId: 'machine-admission',
            serverId,
            fileReader: {
                sizeBytes: 3,
                readBytes: async () => new Uint8Array([1, 2, 3]),
                close,
            },
            request: {
                t: 'session_attachment_upload_v1',
                sessionId: 'session-a',
                workingDirectory: '/repo',
                messageLocalId: 'message-local-1',
                fileName: 'note.txt',
                sizeBytes: 3,
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.',
                vcsIgnoreStrategy: 'none',
                vcsIgnoreWritesEnabled: false,
            },
        });

        expect(result).toMatchObject({ success: false, errorCode: 'machine_carrier_unavailable' });
        expect(close).toHaveBeenCalledTimes(1);
        expect(networkRequests).toEqual([]);
        expect(socketMachineRpc).not.toHaveBeenCalled();
    });
});
