import { describe, expect, it, vi } from 'vitest';

const sessionRpcWithServerAccountScopeMock = vi.hoisted(() => vi.fn());
const sessionRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerAccountScope: sessionRpcWithServerAccountScopeMock,
    sessionRpcWithServerScope: sessionRpcWithServerScopeMock,
}));

import { preparePendingMessageComposerAdmission } from './pendingMessageComposerAdmission';

describe('pendingMessageComposerAdmission exact Account lifetime', () => {
    it('does not issue preparation for an already cancelled composer owner', async () => {
        sessionRpcWithServerAccountScopeMock.mockResolvedValue({ ok: false, error: 'unavailable', errorCode: 'unavailable' });
        const cancellation = new AbortController();
        cancellation.abort();
        await expect(preparePendingMessageComposerAdmission('session-b', {
            localId: 'pending-b', text: 'edited', structuredInput: { v: 1 },
        }, {
            signal: cancellation.signal,
            accountLifetime: {
                scope: { serverId: 'server-b', accountId: 'account-b' },
                isCurrent: () => true,
                onRetire: () => ({ dispose() {} }),
            },
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(sessionRpcWithServerAccountScopeMock).not.toHaveBeenCalled();
    });

    it('does not accept a prepare response after the captured Account credentials retire', async () => {
        let current = true;
        const retireCallbacks = new Set<() => void>();
        const lifetime = {
            scope: { serverId: 'server-b', accountId: 'account-b' },
            isCurrent: () => current,
            onRetire: (callback: () => void) => {
                retireCallbacks.add(callback);
                return { dispose: () => retireCallbacks.delete(callback) };
            },
        };
        let resolveRpc!: (value: unknown) => void;
        sessionRpcWithServerAccountScopeMock.mockImplementationOnce(() => new Promise((resolve) => {
            resolveRpc = resolve;
        }));

        const preparing = preparePendingMessageComposerAdmission('session-b', {
            localId: 'pending-b',
            text: 'edited',
            structuredInput: { v: 1 },
        }, {
            serverId: 'server-b',
            accountLifetime: lifetime,
        });
        await vi.waitFor(() => expect(sessionRpcWithServerAccountScopeMock).toHaveBeenCalledTimes(1));

        current = false;
        for (const retire of retireCallbacks) retire();
        resolveRpc({ ok: false, error: 'stale', errorCode: 'stale' });

        await expect(preparing).rejects.toMatchObject({ code: 'session_account_scope_retired' });
        expect(sessionRpcWithServerAccountScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-b',
            scope: lifetime.scope,
            signal: expect.any(AbortSignal),
            onIssued: expect.any(Function),
        }));
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
    });
});
