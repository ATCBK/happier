import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { stopSessionAndMaybeArchive } from './sessionStopArchiveFlow';

const { modalConfirmSpy } = vi.hoisted(() => ({ modalConfirmSpy: vi.fn(async () => true) }));

function address(sessionId: string, serverId = 'server-a') {
    return { serverId, sessionId } as const;
}

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: modalConfirmSpy } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

describe('stopSessionAndMaybeArchive', () => {
    beforeEach(() => { storage.setState(storage.getInitialState(), true); });
    it('asks the Home to archive when a preceding Stop already retired the captured active target', async () => {
        const archiveSession = vi.fn(async () => ({ success: true }));
        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');
        const params = {
            address: address('session_already_stopped'), hideInactiveSessions: false, isPinned: false,
            stopSession: async () => ({ success: false, code: 'session_stop_not_found', message: 'runtime already retired' }),
            archiveSession, stopErrorMessage: 'stop failed', archiveErrorMessage: 'archive failed',
        };
        await expect(stopSessionAndMaybeArchive({ ...params, archiveAfterStop: 'always' })).resolves.toBeUndefined();
        expect(archiveSession).toHaveBeenCalledTimes(1);
        await expect(stopSessionAndMaybeArchive({ ...params, archiveAfterStop: 'always',
            archiveSession: async () => ({ success: false, code: 'session_active', message: 'raw conflict' }),
        })).rejects.toMatchObject({ message: 'archive failed', code: 'session_active' });
        await expect(stopSessionAndMaybeArchive({ ...params, archiveAfterStop: 'never' }))
            .rejects.toMatchObject({ message: 'runtime already retired' });
        await expect(stopSessionAndMaybeArchive({ ...params, archiveAfterStop: 'always',
            stopSession: async () => ({ success: false, code: 'session_stop_failed', message: 'Session not found' }),
        })).rejects.toMatchObject({ message: 'Session not found' });
        expect(archiveSession).toHaveBeenCalledTimes(1);
    });

    it('reports an active archive conflict without a silent polling window', async () => {
        vi.useFakeTimers();
        const archiveSession = vi.fn()
            .mockResolvedValueOnce({ success: false, code: 'session_active' })
            .mockResolvedValueOnce({ success: true });
        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');
        let outcome: unknown;
        const pending = stopSessionAndMaybeArchive({
            address: address('session_stopping'), hideInactiveSessions: false, isPinned: false,
            archiveAfterStop: 'always',
            stopSession: async () => ({ success: false, code: 'session_stop_requested', recovery: 'wait_for_inactive' }),
            archiveSession, stopErrorMessage: 'stop failed', archiveErrorMessage: 'archive failed',
        }).then(() => { outcome = 'archived'; }, error => { outcome = error; });
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(outcome).toMatchObject({ message: 'archive failed' });
            expect(archiveSession).toHaveBeenCalledTimes(1);
        } finally {
            await vi.runOnlyPendingTimersAsync();
            await pending;
            vi.useRealTimers();
        }
    });

    afterEach(() => {
        expect(storage.getState().sessionArchiveOperations).toEqual({});
        standardCleanup();
        modalConfirmSpy.mockClear();
    });

    it('preserves independent attention retention in both Homes when an archive settles', async () => {
        for (const serverId of ['server-a', 'server-b']) {
            storage.getState().applyServerScopedSessionListRows(serverId, [
                createSessionListRenderableSessionFixture({ id: 'same-session', keepVisibleWhenInactive: true }),
            ], { source: 'ordinary', mode: 'replace' });
        }
        const stopSpy = vi.fn(async () => ({ success: true }));
        const archiveSpy = vi.fn(async () => ({ success: true }));

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');

        await stopSessionAndMaybeArchive({
            address: address('same-session', 'server-b'),
            hideInactiveSessions: true,
            isPinned: false,
            archiveAfterStop: 'always',
            stopSession: stopSpy,
            archiveSession: archiveSpy,
            stopErrorMessage: 'stop failed',
            archiveErrorMessage: 'archive failed',
        });
        for (const serverId of ['server-a', 'server-b']) {
            expect(storage.getState().sessionListRowsByServerId[serverId]?.['same-session']?.keepVisibleWhenInactive).toBe(true);
        }
    });

    it('stops without archiving when stop-only behavior is requested', async () => {
        const stopSpy = vi.fn(async () => ({ success: true }));
        const archiveSpy = vi.fn(async () => ({ success: true }));

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');

        await stopSessionAndMaybeArchive({
            address: address('session_1'),
            hideInactiveSessions: true,
            isPinned: false,
            archiveAfterStop: 'never',
            stopSession: stopSpy,
            archiveSession: archiveSpy,
            stopErrorMessage: 'stop failed',
            archiveErrorMessage: 'archive failed',
        });

        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(archiveSpy).not.toHaveBeenCalled();
    });

    it('settles archive progress when stopping fails', async () => {
        const stopSpy = vi.fn(async () => ({ success: false, message: 'boom' }));
        const archiveSpy = vi.fn(async () => ({ success: true }));

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');

        await expect(
            stopSessionAndMaybeArchive({
                address: address('session_2'),
                hideInactiveSessions: true,
                isPinned: false,
                archiveAfterStop: 'always',
                stopSession: stopSpy,
                archiveSession: archiveSpy,
                stopErrorMessage: 'stop failed',
                archiveErrorMessage: 'archive failed',
            }),
        ).rejects.toMatchObject({ message: 'boom' });

        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(archiveSpy).not.toHaveBeenCalled();
    });

    it('treats an accepted pending Stop as stop-only success', async () => {
        const stopSpy = vi.fn(async () => ({
            success: false,
            message: 'Stop requested; waiting for the session to become inactive',
            code: 'session_stop_requested',
            recovery: 'wait_for_inactive' as const,
        }));
        const archiveSpy = vi.fn(async () => ({ success: true }));

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');

        await expect(stopSessionAndMaybeArchive({
            address: address('session_requested'),
            hideInactiveSessions: false,
            isPinned: false,
            archiveAfterStop: 'never',
            stopSession: stopSpy,
            archiveSession: archiveSpy,
            stopErrorMessage: 'stop failed',
            archiveErrorMessage: 'archive failed',
        })).resolves.toBeUndefined();
        expect(archiveSpy).not.toHaveBeenCalled();
    });

    it('archives an accepted pending Stop when the Home already permits Archive', async () => {
        const stopSpy = vi.fn(async () => ({
            success: false,
            code: 'session_stop_requested',
            recovery: 'wait_for_inactive' as const,
        }));
        const archiveSpy = vi.fn(async () => ({ success: true }));

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');
        await expect(stopSessionAndMaybeArchive({
            address: address('session_requested_archive'),
            hideInactiveSessions: false,
            isPinned: false,
            archiveAfterStop: 'always',
            stopSession: stopSpy,
            archiveSession: archiveSpy,
            stopErrorMessage: 'stop failed',
            archiveErrorMessage: 'archive failed',
        })).resolves.toBeUndefined();
        expect(archiveSpy).toHaveBeenCalledTimes(1);
    });

    it('surfaces truthful recovery when session control is unavailable', async () => {
        const stopSpy = vi.fn(async () => ({
            success: false,
            message: 'RPC method not available',
            code: 'session_stop_control_unavailable',
            recovery: 'retry_when_runtime_available' as const,
        }));

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');

        await expect(stopSessionAndMaybeArchive({
            address: address('session_upgrade'),
            hideInactiveSessions: false,
            isPinned: false,
            archiveAfterStop: 'never',
            stopSession: stopSpy,
            archiveSession: vi.fn(async () => ({ success: true })),
            stopErrorMessage: 'stop failed',
            archiveErrorMessage: 'archive failed',
        })).rejects.toMatchObject({
            message: 'sessionInfo.stopSessionControlUnavailable',
        });
    });

    it('does not preserve visibility for stop-only sessions hidden by settings', async () => {
        const stopSpy = vi.fn(async () => ({ success: true }));
        const archiveSpy = vi.fn(async () => ({ success: true }));

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');

        await stopSessionAndMaybeArchive({
            address: address('session_3'),
            hideInactiveSessions: true,
            isPinned: false,
            archiveAfterStop: 'never',
            stopSession: stopSpy,
            archiveSession: archiveSpy,
            stopErrorMessage: 'stop failed',
            archiveErrorMessage: 'archive failed',
        });

        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(archiveSpy).not.toHaveBeenCalled();
    });

    it('archives immediately after stopping when explicitly requested', async () => {
        const stopSpy = vi.fn(async () => ({ success: true }));
        const archiveSpy = vi.fn(async () => ({ success: true }));

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');

        await stopSessionAndMaybeArchive({
            address: address('session_4'),
            hideInactiveSessions: false,
            isPinned: false,
            archiveAfterStop: 'always',
            stopSession: stopSpy,
            archiveSession: archiveSpy,
            stopErrorMessage: 'stop failed',
            archiveErrorMessage: 'archive failed',
        });

        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(archiveSpy).toHaveBeenCalledTimes(1);
    });

    it('uses the archive fallback message when a confirmed Stop has not settled at the Home', async () => {

        const stopSpy = vi.fn(async () => ({ success: true }));
        const archiveSpy = vi.fn(async () => ({
            success: false,
            message: '{"error":"session-active"}',
            code: 'session_active' as const,
        }));

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');

        await expect(
            stopSessionAndMaybeArchive({
                address: address('session_timeout'),
                hideInactiveSessions: false,
                isPinned: false,
                archiveAfterStop: 'always',
                stopSession: stopSpy,
                archiveSession: archiveSpy,
                stopErrorMessage: 'stop failed',
                archiveErrorMessage: 'archive failed',
            }),
        ).rejects.toMatchObject({ message: 'archive failed' });

        expect(archiveSpy).toHaveBeenCalledTimes(1);
    });

    it('settles archive progress when archive fails after stopping', async () => {
        const stopSpy = vi.fn(async () => ({ success: true }));
        const archiveSpy = vi.fn(async () => ({ success: false, message: 'archive boom' }));

        const { stopSessionAndMaybeArchive } = await import('./sessionStopArchiveFlow');

        await expect(
            stopSessionAndMaybeArchive({
                address: address('session_5'),
                hideInactiveSessions: false,
                isPinned: false,
                archiveAfterStop: 'always',
                stopSession: stopSpy,
                archiveSession: archiveSpy,
                stopErrorMessage: 'stop failed',
                archiveErrorMessage: 'archive failed',
            }),
        ).rejects.toMatchObject({ message: 'archive boom' });

    });
});


describe('shared archive admission across Home identity discovery', () => {
    it('admits one public stop-and-archive operation when its Home learns a stable identity', async () => {
        storage.setState(storage.getInitialState(), true);
        const home = await upsertServerProfile({ serverUrl: 'https://archive-discovery.example' });
        let releaseStop!: () => void;
        const stopped = new Promise<void>(resolve => { releaseStop = resolve; });
        let stopCount = 0;
        let archiveCount = 0;
        // Public effect adapters are controlled; the orchestration and real
        // SessionsDomain remain inside the process under test.
        const adapters = {
            hideInactiveSessions: true, isPinned: false, archiveAfterStop: 'always' as const,
            stopSession: async () => { stopCount += 1; await stopped; return { success: true }; },
            archiveSession: async () => { archiveCount += 1; return { success: true }; },
            stopErrorMessage: 'stop failed', archiveErrorMessage: 'archive failed',
        };
        const first = stopSessionAndMaybeArchive({ ...adapters, address: { serverId: home.id, sessionId: 'same-session' } });
        let second: ReturnType<typeof stopSessionAndMaybeArchive> | undefined;
        try {
            expect(stopCount).toBe(1);
            await setServerProfileIdentityForUrl(home.serverUrl, 'srv_archive_discovered');
            second = stopSessionAndMaybeArchive({ ...adapters, address: { serverId: 'srv_archive_discovered', sessionId: 'same-session' } });
            expect(stopCount).toBe(1);
        } finally {
            releaseStop();
            await Promise.all([first, second]);
        }
        expect(archiveCount).toBe(1);
        expect(storage.getState().sessionArchiveOperations).toEqual({});
    });
});
