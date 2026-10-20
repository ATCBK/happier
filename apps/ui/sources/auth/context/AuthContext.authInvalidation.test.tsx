import React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createConcurrentCacheNetworkHarness } from '@/dev/testkit/harness/concurrentCacheNetworkHarness';

const homes = await createConcurrentCacheNetworkHarness('auth-invalidation');
const { AuthProvider, ConcurrentSessionCacheRuntime, getCurrentAuth } = await import('./AuthContext');
const connection = await import('@/sync/runtime/orchestration/connectionManager');
const { notifyAuthCredentialsInvalidated } = await import('@/sync/runtime/orchestration/authCredentialsInvalidation');
const { guardAccountEncryptionFirstKeyCredentialMutation } = await import('@/sync/ops/account/accountEncryptionFirstKeyExternalAuth');

async function recoveryFor(home: typeof homes.homeA) {
    expect(await homes.TokenStorage.setPendingExternalAuth({
        provider: 'github', proof: 'proof', secret: 'secret', serverId: home.id, serverUrl: home.serverUrl,
        accountEncryptionFirstKey: {
            accountId: home.accountId, requestDigest: 'aemrb1_' + 'A'.repeat(43), requestJson: '{}',
            pending: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
            migrationSubmissionAttempted: true,
        },
    })).toBe(true);
    const guarded = await guardAccountEncryptionFirstKeyCredentialMutation({ serverId: home.id, serverUrl: home.serverUrl });
    if (guarded.kind !== 'finish_encryption_setup') throw new Error('Expected retained first-key custody');
    return guarded.recovery;
}

describe('AuthContext credential invalidation handling', () => {
    beforeEach(async () => {
        await homes.reset();
        await connection.restoreConnectionToActiveServer({ token: homes.homeA.token });
    });
    afterEach(async () => {
        await standardCleanup();
        await connection.disconnectActiveServerConnection();
        for (const home of [homes.homeA, homes.homeB]) {
            const state = await homes.TokenStorage.readPendingExternalAuthStateForServerUrl(home.serverUrl, { serverId: home.id });
            if (state.value) await homes.TokenStorage.clearPendingExternalAuth({
                serverUrl: home.serverUrl, serverId: home.id, removeFirstKeyMigrationAttempted: state.value,
            });
        }
        await homes.cleanup();
    });
    afterAll(async () => { await homes.dispose(); });

    it('disconnects first-key rejected auth through the connection owner without stopping secondary-server continuity', async () => {
        const credentials = { token: homes.homeA.token };
        const screen = await renderScreen(<AuthProvider initialCredentials={credentials}>
            <ConcurrentSessionCacheRuntime><React.Fragment /></ConcurrentSessionCacheRuntime>
        </AuthProvider>);
        await vi.waitFor(() => expect(homes.network.socketBoundaries.some(socket => socket.serverUrl === homes.homeB.serverUrl)).toBe(true));
        await homes.ready();
        const secondary = homes.socket();
        expect(secondary.socket.connected).toBe(true);
        const disconnects = vi.mocked(secondary.socket.disconnect).mock.calls.length;
        const recovery = await recoveryFor(homes.homeA);
        const target = homes.profiles.getActiveServerSnapshot();

        await act(async () => { notifyAuthCredentialsInvalidated({ ...target, kind: 'first_key_recovery_required', recovery }); });
        await vi.waitFor(() => {
            expect(getCurrentAuth()?.isAuthenticated).toBe(false);
            expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(false);
        });
        expect(await homes.TokenStorage.getCredentialsForServerUrl(homes.homeA.serverUrl, { serverId: homes.homeA.id })).toEqual(credentials);
        expect(secondary.socket.disconnect).toHaveBeenCalledTimes(disconnects);
        const reads = homes.requests('/v2/sessions').filter(request => request.url.origin === homes.homeB.serverUrl).length;
        await homes.refresh();
        expect(homes.requests('/v2/sessions').filter(request => request.url.origin === homes.homeB.serverUrl).length).toBeGreaterThan(reads);
        await homes.ready();

        await screen.unmount();
        expect(secondary.socket.connected).toBe(false);
    });

    it('does not clear the focused Home when a delayed first-key invalidation belongs to another Home', async () => {
        const credentials = { token: homes.homeA.token };
        const screen = await renderScreen(<AuthProvider initialCredentials={credentials}><React.Fragment /></AuthProvider>);
        const applied = connection.getAppliedActiveServerSnapshot();
        const recovery = await recoveryFor(homes.homeB);

        await act(async () => { notifyAuthCredentialsInvalidated({
            kind: 'first_key_recovery_required', serverId: homes.homeB.id, serverUrl: homes.homeB.serverUrl, recovery,
        }); });
        expect(getCurrentAuth()).toMatchObject({ isAuthenticated: true, credentials });
        expect(connection.getAppliedActiveServerSnapshot()).toBe(applied);
        expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(true);
        await screen.unmount();
    });
});
