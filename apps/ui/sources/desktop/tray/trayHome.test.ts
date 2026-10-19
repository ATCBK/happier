import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';

vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness'))
    .createSocketIoClientBoundary(importOriginal));

import {
    getActiveServerSnapshot,
    listServerProfiles,
    resolveSavedServerProfileByUrl,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';

import { resolveHomeDisplayNameForRelayUrl as readHomeNameForRelay } from '@/components/settings/server/homeDisplayName';

import { openHomeFromTrayRow } from './trayHome';
import { getAppliedActiveServerId, getAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/connectionManager';

await initializeAuthRouteRuntimeForTests();

/** Seeds the saved Homes at the persistence boundary (the test MMKV), the only way two can share an address. */
async function seedSavedHomes(servers: Record<string, ServerProfile>, activeServerId: string) {
    await seedPersistedHomeProfilesForTests({ profiles: Object.values(servers), activeServerId });
}

const home = (id: string, serverUrl: string, extra: Partial<ServerProfile> = {}): ServerProfile =>
    ({ id, name: id, serverUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1, ...extra });

describe('openHomeFromTrayRow (D11-3, A13-05)', () => {
    const refreshAuth = vi.fn(async () => {});

    beforeEach(() => {
        refreshAuth.mockClear();
    });

    it('switches to the one saved Home on that relay, refreshing the app\'s auth', async () => {
        await seedSavedHomes({ home: home('home', 'https://home.example.test'), work: home('work', 'https://work.example.test') }, 'home');

        await expect(openHomeFromTrayRow('https://work.example.test/', refreshAuth)).resolves.toBe('opened');

        expect(getActiveServerSnapshot().serverId).toBe('work');
        expect(getAppliedActiveServerId()).toBe('work');
        expect(refreshAuth).toHaveBeenCalled();
        expect(readHomeNameForRelay('https://work.example.test')).toBe('work');
    });

    it('registers a Home the app has not saved yet and switches to it (A12-02 parity)', async () => {
        await seedSavedHomes({ home: home('home', 'https://home.example.test') }, 'home');

        await expect(openHomeFromTrayRow('https://new.example.test', refreshAuth)).resolves.toBe('opened');

        const saved = listServerProfiles().find((profile) => profile.serverUrl.startsWith('https://new.example.test'));
        expect(saved).toBeDefined();
        expect(getActiveServerSnapshot().serverId).toBe(saved?.id);
    });

    it('picks nothing and names nothing when two saved Homes share that address', async () => {
        await seedSavedHomes({
            home: home('home', 'https://home.example.test'),
            first: home('first', 'https://shared.example.test', { serverIdentityId: 'srv_first', canonicalServerUrl: 'https://shared.example.test' }),
            second: home('second', 'https://shared.example.test', { serverIdentityId: 'srv_second', canonicalServerUrl: 'https://shared.example.test' }),
        }, 'home');
        expect(resolveSavedServerProfileByUrl('https://shared.example.test').kind).toBe('ambiguous');
        const applied = getAppliedActiveServerSnapshot();

        await expect(openHomeFromTrayRow('https://shared.example.test', refreshAuth)).resolves.toBe('ambiguous');

        expect(getActiveServerSnapshot().serverId).toBe('home');
        expect(getAppliedActiveServerSnapshot()).toBe(applied);
        expect(readHomeNameForRelay('https://shared.example.test')).toBeNull();
    });
});
