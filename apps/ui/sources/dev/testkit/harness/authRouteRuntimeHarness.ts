import { afterAll } from 'vitest';
import { installDisconnectedServerSocketBoundary } from './serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

installDisconnectedServerSocketBoundary();
// Vitest's canonical platform aliases already load the real Node crypto ports.
// Mocking an alias with a factory importing its target would await that same factory.

/** Real Auth/Sync owners, independent of any route's navigation boundary. */
export async function initializeAuthRouteRuntimeForTests() {
    const webLocks = installWebLockManagerMock();
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async () => new Response('{}', { status: 404 }));
    const { loadSyncSingletonForTests } = await import('./syncSingletonLoader');
    await loadSyncSingletonForTests();
    afterAll(async () => {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        await stopAllEndpointSupervisorsForTests();
        const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        resetRuntimeFetch();
        webLocks.restore();
    });
}
