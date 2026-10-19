import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createDeferred } from '@/dev/testkit';

// HTTP and Socket.IO are the only substituted boundaries. The release owner,
// credential guard, transfer routing and correlated RPC cancellation stay real.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { releaseComposerContent } = await import('./composerMediaStageTransfers');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
let home: Awaited<ReturnType<typeof network.addHome>>;
beforeEach(async () => {
    network.resetRequests();
    home = await network.addHome('https://composer-cleanup.example.test', 'cleanup-owner');
});
afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    resetScopedMachineTransportCacheForTests();
});
afterAll(() => network.dispose());

const handleForHome = (serverId: string) => ({
    v: 1, id: 'cleanup-stage', executionTarget: { serverId, machineId: 'machine-1' },
    owner: { pluginId: 'com.example.media', localId: 'image' }, mediaKind: 'image',
    mimeType: 'image/png', name: 'picture.png', sizeBytes: 4, sha256: 'a'.repeat(64),
} as const);

it('retires an unanswered cleanup on exact Home credential replacement and permits a fresh release', async () => {
    const entered = createDeferred<void>();
    const reply = createDeferred<{ success: true }>();
    network.setRpcResponder(async request => {
        expect(request.method).toBe(RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE);
        entered.resolve();
        return await reply.promise;
    });
    const release = releaseComposerContent(handleForHome(home.id));
    try {
        await entered.promise;
        await network.setAccount(home.serverUrl, 'replacement-owner');
        let settled = false;
        void release.then(() => { settled = true; });
        await vi.waitFor(() => expect(settled).toBe(true));
        await expect(release).resolves.toMatchObject({ success: false, errorCode: 'MACHINE_RPC_ABORTED' });
        reply.resolve({ success: true });
        network.setRpcResponder(async () => ({ success: true }));
        await expect(releaseComposerContent(handleForHome(home.id))).resolves.toEqual({ success: true });
        expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE)).toHaveLength(2);
    } finally { reply.resolve({ success: true }); await release; }
});
