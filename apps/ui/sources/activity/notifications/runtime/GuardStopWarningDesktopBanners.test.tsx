import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';

const os = vi.hoisted(() => ({ send: vi.fn(async () => true) }));
// The desktop OS notification is the boundary; selection, wording and once-only delivery run for real.
vi.mock('../channels/sendTauriLocalNotification', () => ({ sendTauriLocalNotification: os.send }));

const { GuardStopWarningDesktopBanners } = await import('./GuardStopWarningDesktopBanners');

const before = storage.getState();
afterEach(() => { storage.setState(before); os.send.mockClear(); });

function stopping(stopAt: number): Session {
    return createSessionFixture({ id: 'tidy', active: true, serverId: 'home-a',
        metadata: { path: '/w', host: 'leeroy-mbp', homeDir: '/u', machineId: 'm', summary: { text: 'Tidy fixtures', updatedAt: 1 },
            sessionGuardStateV1: { v: 1, kind: 'stopping', stopAt, rule: 'idle_sessions' } } as Session['metadata'] });
}

function stoppingNamed(stopAt: number): Session {
    return createSessionFixture({ id: 'named', active: true, serverId: 'home-a',
        metadata: { path: '/w', host: 'leeroy-mbp', homeDir: '/u', machineId: 'm', name: 'Nightly sweep',
            sessionGuardStateV1: { v: 1, kind: 'stopping', stopAt, rule: 'idle_sessions' } } as Session['metadata'] });
}

describe('GuardStopWarningDesktopBanners', () => {
    it('names a Session the way the list and header do, not only by its summary', async () => {
        storage.setState({ sessions: { named: stoppingNamed(Date.now() + 5 * 60_000) } } as never);
        const screen = await renderScreen(<GuardStopWarningDesktopBanners />);
        await act(async () => { await Promise.resolve(); });
        expect(os.send).toHaveBeenCalledWith(expect.objectContaining({ title: 'Stopping “Nightly sweep” in 5 minutes' }));
        await screen.unmount?.();
    });

    it('announces a coming guard stop once on this computer, naming the session and when', async () => {
        const stopAt = Date.now() + 5 * 60_000;
        storage.setState({ sessions: { tidy: stopping(stopAt) } } as never);
        const screen = await renderScreen(<GuardStopWarningDesktopBanners />);
        await act(async () => { await Promise.resolve(); });
        expect(os.send).toHaveBeenCalledTimes(1);
        expect(os.send).toHaveBeenCalledWith({ title: 'Stopping “Tidy fixtures” in 5 minutes',
            body: 'It finished its work and wakes on your next message. Keep it running from the session.' });
        // The same warning again (any later store change) is not announced twice; a new stop time is.
        await act(async () => { storage.setState({ sessions: { tidy: stopping(stopAt) } } as never); });
        expect(os.send).toHaveBeenCalledTimes(1);
        await act(async () => { storage.setState({ sessions: { tidy: stopping(stopAt + 3_600_000) } } as never); });
        expect(os.send).toHaveBeenCalledTimes(2);
        await screen.unmount?.();
    });
});
