import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';

installTokenStorageWebPlatformMocks();
const profiles = await import('@/sync/domains/server/serverProfiles');
const { useNewSessionActiveServerSource } = await import('./useNewSessionActiveServerSource');
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;
const homeA = 'srv_source_a';
const homeB = 'srv_source_b';
const descriptor = { v: 1 as const, homeServerIdentityId: homeB,
    canonicalServerUrl: 'https://b.example.test', revision: 1,
    endpoints: [{ kind: 'https' as const, url: 'https://b.example.test' }] };

async function publishDescriptor() {
    return await profiles.adoptHomeProfile({ descriptor, suggestedName: 'Server B', source: 'qr',
        preserveUserLabel: true, preserveProfileSource: true, descriptorAuthority: 'current_connection_observation' });
}

describe('useNewSessionActiveServerSource', () => {
    beforeEach(async () => {
        browser = await installBrowserRuntimeForTests({ url: 'https://source.fixture.test' });
        await seedPersistedHomeProfilesForTests({ activeServerId: homeA, browserStorage: browser.storage,
            profiles: [
                { id: homeA, serverIdentityId: homeA, name: 'Server A', serverUrl: 'https://a.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1000 },
                { id: homeB, serverIdentityId: homeB, name: 'Server B', serverUrl: 'https://b.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 900 },
            ] });
    });
    afterEach(() => { standardCleanup(); browser?.restore(); browser = undefined; });

    it('ignores runtime-origin churn while preserving profile name changes', async () => {
        const hook = await renderHook(() => useNewSessionActiveServerSource());
        const first = hook.getCurrent();

        const target = profiles.captureActiveServerRuntimeTarget();
        await act(async () => {
            expect(profiles.publishActiveServerRuntimeOrigin({ target, leaseId: 'source-runtime',
                runtimeOrigin: 'https://runtime-a.example.test', carrier: 'https' })).toBe(true);
        });

        expect(hook.getCurrent()).toBe(first);

        await act(async () => {
            await profiles.adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: homeA,
                canonicalServerUrl: 'https://a.example.test', revision: 1,
                endpoints: [{ kind: 'https', url: 'https://a.example.test' }] },
                suggestedName: 'Server A renamed', source: 'qr', preserveUserLabel: false,
                descriptorAuthority: 'current_connection_observation' });
        });

        expect(profiles.getServerProfileById(homeA)?.name).toBe('Server A renamed');
        expect(hook.getCurrent()).not.toBe(first);
        expect(hook.getCurrent().serverProfiles.find(profile => profile.id === homeA)?.name).toBe('Server A renamed');
    });

    it('publishes same-identity Home descriptor admission without changing the authoring focus', async () => {
        const hook = await renderHook(() => useNewSessionActiveServerSource());
        const first = hook.getCurrent();
        expect(first.serverProfiles.find(profile => profile.id === homeB)?.homeConnectionDescriptor).toBeUndefined();

        await act(async () => { await publishDescriptor(); });

        // The real profile producer has admitted the descriptor. Its consumer
        // must not retain a preceding id/name-only projection of this Home.
        expect(profiles.getServerProfileById(homeB)?.homeConnectionDescriptor).toEqual(descriptor);
        expect(hook.getCurrent().serverProfiles.find(profile => profile.id === homeB)?.homeConnectionDescriptor).toEqual(descriptor);
        expect(hook.getCurrent().activeServerId).toBe(homeA);
        const admitted = hook.getCurrent();
        await act(async () => { await publishDescriptor(); });
        expect(hook.getCurrent()).toBe(admitted);

        await act(async () => { await profiles.removeServerProfile(homeB); });
        expect(hook.getCurrent().serverProfiles.some(profile => profile.id === homeB)).toBe(false);
        expect(hook.getCurrent().activeServerId).toBe(homeA);
    });
});
