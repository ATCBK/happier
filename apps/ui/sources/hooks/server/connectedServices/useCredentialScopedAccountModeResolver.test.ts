import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';

import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import '@/sync/syncEngine';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { useAccountEncryptionMode } from '@/components/settings/account/useAccountEncryptionMode';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';

const credentials = { token: 'account-mode-token', secret: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url') };

async function installModeBoundary(read: () => Response, readCurrentness = () => Response.json(createPlainAccountEncryptionCurrentnessFixture())) {
    await upsertAndActivateServer({ serverUrl: 'https://mode-resolver.test' });
    const requests: string[] = [];
    setRuntimeFetch(async input => {
        const path = new URL(String(input)).pathname;
        requests.push(path);
        if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
        if (path === '/v1/account/encryption/currentness') return readCurrentness();
        if (path === '/v1/account/encryption') return read();
        throw new Error(`Unexpected mode boundary: ${path}`);
    });
    return requests;
}

describe('useCredentialScopedAccountModeResolver', () => {
    afterEach(async () => {
        standardCleanup();
        invalidateAccountEncryptionModeCache();
        resetRuntimeFetch();
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
        const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        await stopAllEndpointSupervisorsForTests();
    });

    it('recovers after a failed read instead of caching the fallback mode', async () => {
        let reads = 0;
        await installModeBoundary(() => ++reads === 1 ? Response.json({ error: 'forbidden' }, { status: 403 })
            : Response.json({ mode: 'plain', updatedAt: 1 }));
        const { useCredentialScopedAccountModeResolver } = await import('./useCredentialScopedAccountModeResolver');
        const hook = await renderHook(() => useCredentialScopedAccountModeResolver({
            credentials,
            credentialScope: 'scope-a',
        }));

        await expect(hook.getCurrent()()).resolves.toBe('e2ee');
        await expect(hook.getCurrent()()).resolves.toBe('plain');
        expect(reads).toBe(2);

        await hook.unmount();
    });

    it('resolves each demand through the owner instead of retaining a successful mode in the hook', async () => {
        let mode: 'plain' | 'e2ee' = 'plain';
        let reads = 0;
        await installModeBoundary(() => { reads += 1; return Response.json({ mode, updatedAt: reads }); });
        const { useCredentialScopedAccountModeResolver } = await import('./useCredentialScopedAccountModeResolver');
        const hook = await renderHook(() => useCredentialScopedAccountModeResolver({ credentials, credentialScope: 'scope-a' }));
        await expect(hook.getCurrent()()).resolves.toBe('plain');
        mode = 'e2ee';
        invalidateAccountEncryptionModeCache();
        await expect(hook.getCurrent()()).resolves.toBe('e2ee');
        expect(reads).toBe(2);
        await hook.unmount();
    });

    it.each(['socket disconnect', 'Account replacement'] as const)('withdraws the mounted mode on %s when a fresh read refuses', async retirement => {
        const { installDisconnectedServerSocketBoundary, configureConnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        let liveSocket: import('socket.io-client').Socket | undefined;
        installDisconnectedServerSocketBoundary(socket => {
            liveSocket = socket;
            configureConnectedServerSocketBoundary(socket);
        });
        let denied = false;
        const requests = await installModeBoundary(() => denied ? Response.json({ error: 'forbidden' }, { status: 403 })
            : Response.json({ mode: 'plain', updatedAt: 1 }), () => denied ? Response.json({ error: 'forbidden' }, { status: 403 })
            : Response.json(createPlainAccountEncryptionCurrentnessFixture()));
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        let activeCredentials = { token: createAccountTokenForTests('mode-account') };
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const target = getActiveServerSnapshot();
        const runtime = await loadSyncSingletonForTests();
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        apiSocket.initialize({ endpoint: target.serverUrl, token: activeCredentials.token, credentials: activeCredentials,
            serverId: target.serverId, generation: target.generation }, null);
        try {
            await vi.waitFor(() => expect(liveSocket?.connected).toBe(true));
            await expect(apiSocket.getAccountEncryptionObservationBinding(activeCredentials)!.read()).resolves.toMatchObject({ mode: 'plain' });
            const { getCachedAccountEncryptionMode } = await import('@/sync/api/account/apiAccountEncryptionMode');
            expect(getCachedAccountEncryptionMode(activeCredentials)).toBe('plain');
            const wrapper: React.ComponentType<React.PropsWithChildren> = ({ children }) =>
                React.createElement(InjectedAuthProvider, { credentials: activeCredentials, children });
            const hook = await renderHook(() => useAccountEncryptionMode(), { wrapper });
            try {
                await vi.waitFor(() => expect(hook.getCurrent()).toBe('plain'));
                const { useCredentialScopedAccountModeResolver } = await import('./useCredentialScopedAccountModeResolver');
                const resolver = await renderHook(() => useCredentialScopedAccountModeResolver({
                    credentials: activeCredentials, credentialScope: 'mode-account',
                }));
                try {
                    await Promise.all(Array.from({ length: 10 }, () => resolver.getCurrent()()));
                    expect(requests.filter(path => path === '/v1/account/encryption/currentness')).toHaveLength(1);
                    expect(requests.filter(path => path === '/v1/account/encryption')).toHaveLength(0);
                    const { UpdateContainerSchema } = await import('@happier-dev/protocol/updates');
                    const update = UpdateContainerSchema.parse({ id: 'mode-change', seq: 2, createdAt: 2,
                        body: { t: 'update-account', id: 'mode-account', encryptionCurrentness: {
                            mode: 'e2ee', version: 2, updatedAt: 2, signingKeyFingerprint: 'signing-key',
                            contentKeyFingerprint: 'content-key', recipientEnvelopeReadiness: { status: 'available' },
                        } },
                    });
                    await act(async () => {
                        for (const listener of liveSocket!.listenersAny()) listener('update', update);
                    });
                    await expect(resolver.getCurrent()()).resolves.toBe('e2ee');
                    expect(hook.getCurrent()).toBe('e2ee');
                    expect(requests.filter(path => path === '/v1/account/encryption/currentness')).toHaveLength(1);
                    expect(requests.filter(path => path === '/v1/account/encryption')).toHaveLength(0);
                } finally { await resolver.unmount(); }
                denied = true;
                if (retirement === 'socket disconnect') {
                    await act(async () => { liveSocket!.disconnect(); });
                } else {
                    activeCredentials = { token: createAccountTokenForTests('replacement-account') };
                    await hook.rerender();
                }
                expect(hook.getCurrent()).toBeNull();
            } finally { await hook.unmount(); }
        } finally { apiSocket.disconnect(); runtime.dispose(); }
    });
});
