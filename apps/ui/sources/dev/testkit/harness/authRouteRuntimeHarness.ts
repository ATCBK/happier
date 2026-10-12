import { afterAll, vi } from 'vitest';
import { installDisconnectedServerSocketBoundary } from './serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

installDisconnectedServerSocketBoundary();
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));

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
