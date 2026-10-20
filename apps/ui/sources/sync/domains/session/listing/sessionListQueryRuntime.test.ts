import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    fetchSessionListQueryPageForHome,
    getSessionListQueryHomeAvailability,
    isSessionListQueryHomeOnline,
    retrySessionListQueryHome,
} from './sessionListQueryRuntime';

const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());
const getAppliedActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());
const isAppliedActiveServerRuntimeAvailableSpy = vi.hoisted(() => vi.fn());
const fetchActivePageSpy = vi.hoisted(() => vi.fn());
const fetchConcurrentPageSpy = vi.hoisted(() => vi.fn());
const isConcurrentHomeOnlineSpy = vi.hoisted(() => vi.fn());
const getConcurrentHomeAvailabilitySpy = vi.hoisted(() => vi.fn());
const retryActiveServerConnectionSpy = vi.hoisted(() => vi.fn());
const retryConcurrentHomeSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/server/serverProfiles', async () => {
    const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return createServerProfilesModuleMock({
        profiles: [
            { id: 'home-a', serverUrl: 'https://home-a.example.test' },
            { id: 'home-b', serverUrl: 'https://home-b.example.test' },
        ],
    });
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: (...args: unknown[]) => getAppliedActiveServerSnapshotSpy(...args),
    isAppliedActiveServerRuntimeAvailable: (...args: unknown[]) => isAppliedActiveServerRuntimeAvailableSpy(...args),
    retryActiveServerConnection: (...args: unknown[]) => retryActiveServerConnectionSpy(...args),
}));

vi.mock('@/sync/domains/state/storageStore', async () => {
    const { createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    return {
        storage: createStorageStoreMock({ socketStatus: 'connected' }),
    };
});

vi.mock('@/sync/sync', () => ({
    sync: {
        fetchSessionListQueryPage: (...args: unknown[]) => fetchActivePageSpy(...args),
    },
}));

vi.mock('@/sync/runtime/orchestration/concurrentSessionCache', () => ({
    fetchConcurrentSessionListQueryPage: (...args: unknown[]) => fetchConcurrentPageSpy(...args),
    getConcurrentSessionListQueryHomeAvailability: (...args: unknown[]) => getConcurrentHomeAvailabilitySpy(...args),
    isConcurrentSessionListQueryHomeOnline: (...args: unknown[]) => isConcurrentHomeOnlineSpy(...args),
    retryConcurrentSessionListQueryHome: (...args: unknown[]) => retryConcurrentHomeSpy(...args),
}));

afterEach(() => {
    vi.clearAllMocks();
});

beforeEach(() => {
    isAppliedActiveServerRuntimeAvailableSpy.mockReturnValue(true);
    getConcurrentHomeAvailabilitySpy.mockReturnValue('offline');
});

describe('sessionListQueryRuntime', () => {
    it('keeps the applied Home on the active runtime while another Home is only staged', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'home-b',
            serverUrl: 'https://home-b.example.test',
            generation: 2,
        });
        getAppliedActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'home-a',
            serverUrl: 'https://home-a.example.test',
            generation: 1,
        });
        isConcurrentHomeOnlineSpy.mockReturnValue(false);
        fetchActivePageSpy.mockResolvedValue({ route: 'active' });
        fetchConcurrentPageSpy.mockResolvedValue({ route: 'secondary' });

        const page = {
            source: { kind: 'ordinary' as const, path: '/v2/sessions', allowV1Fallback: false },
            membership: 'ordinary' as const,
            signal: new AbortController().signal,
        };

        await expect(Promise.all([
            isSessionListQueryHomeOnline('home-a'),
            isSessionListQueryHomeOnline('home-b'),
            fetchSessionListQueryPageForHome('home-a', page),
            fetchSessionListQueryPageForHome('home-b', page),
        ])).resolves.toEqual([
            true,
            false,
            { route: 'active' },
            { route: 'secondary' },
        ]);
        expect(fetchActivePageSpy).toHaveBeenCalledWith('home-a', { ...page, signal: expect.any(AbortSignal) });
        expect(fetchConcurrentPageSpy).toHaveBeenCalledWith('home-b', { ...page, signal: expect.any(AbortSignal) });
    });

    it('does not route a torn-down applied Home through the singleton while another Home applies', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'home-b',
            serverUrl: 'https://home-b.example.test',
            generation: 2,
        });
        getAppliedActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'home-a',
            serverUrl: 'https://home-a.example.test',
            generation: 1,
        });
        // The singleton can still report its old socket status while B's
        // reset/restore is in flight. Only the connection owner knows that it
        // is no longer an A transport.
        isAppliedActiveServerRuntimeAvailableSpy.mockReturnValue(false);
        isConcurrentHomeOnlineSpy.mockReturnValue(false);
        getConcurrentHomeAvailabilitySpy.mockImplementation((serverId: string) => (
            serverId === 'home-a' ? 'pending' : 'offline'
        ));
        fetchActivePageSpy.mockResolvedValue({ route: 'active' });
        fetchConcurrentPageSpy.mockResolvedValue({ route: 'secondary-a' });
        retryActiveServerConnectionSpy.mockResolvedValue(undefined);
        retryConcurrentHomeSpy.mockResolvedValue(undefined);

        const page = {
            source: { kind: 'ordinary' as const, path: '/v2/sessions', allowV1Fallback: false },
            membership: 'ordinary' as const,
            signal: new AbortController().signal,
        };

        await expect(isSessionListQueryHomeOnline('home-a')).toBe(false);
        expect(getSessionListQueryHomeAvailability('home-a')).toBe('pending');
        expect(getSessionListQueryHomeAvailability('home-b')).toBe('pending');
        await expect(fetchSessionListQueryPageForHome('home-a', page)).resolves.toEqual({ route: 'secondary-a' });
        await retrySessionListQueryHome('home-a');

        expect(fetchActivePageSpy).not.toHaveBeenCalled();
        expect(retryActiveServerConnectionSpy).not.toHaveBeenCalled();
        expect(fetchConcurrentPageSpy).toHaveBeenCalledWith('home-a', { ...page, signal: expect.any(AbortSignal) });
        expect(retryConcurrentHomeSpy).toHaveBeenCalledWith('home-a');

        getAppliedActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'home-b',
            serverUrl: 'https://home-b.example.test',
            generation: 2,
        });
        isAppliedActiveServerRuntimeAvailableSpy.mockReturnValue(true);
        expect(getSessionListQueryHomeAvailability('home-a')).toBe('pending');
    });

    it('retries the applied and staged Homes through their separate owning transports', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'home-b',
            serverUrl: 'https://home-b.example.test',
            generation: 2,
        });
        getAppliedActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'home-a',
            serverUrl: 'https://home-a.example.test',
            generation: 1,
        });
        retryActiveServerConnectionSpy.mockResolvedValue(undefined);
        retryConcurrentHomeSpy.mockResolvedValue(undefined);

        await Promise.all([
            retrySessionListQueryHome('home-a'),
            retrySessionListQueryHome('home-b'),
        ]);

        expect(retryActiveServerConnectionSpy).toHaveBeenCalledOnce();
        expect(retryConcurrentHomeSpy).toHaveBeenCalledWith('home-b');
    });
});
