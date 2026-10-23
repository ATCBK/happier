import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';

const { sessionRpc, connectSocket } = vi.hoisted(() => ({ sessionRpc: vi.fn(), connectSocket: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => connectSocket(...args) }));

// The socket boundary returns the CLI application acknowledgment; all permission
// dispatch, scope selection and local state recovery below it remain real.
vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: { sessionRPC: (...args: unknown[]) => sessionRpc(...args) },
}));

import { sessionAllow, sessionAllowWithPermissionUpdates, sessionDeny } from './sessions';
import { dispatchSessionPermissionDecision, sessionPermissionDecisionWithServerAccountScope } from './sessionPermissionDecision';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createServerFetchWithReachabilityProbe, createSocketHarness, createSessionFixture } from '@/dev/testkit';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { resetScopedSessionDataKeyCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';

const initialStorageState = storage.getState();

function buildSession(sessionId: string): Session {
    return createSessionFixture({
        id: sessionId, active: true, activeAt: 1, metadata: null, metadataVersion: 0,
        agentState: null, agentStateVersion: 0, thinking: true, thinkingAt: 1,
    });
}

describe('sessionDeny', () => {
    afterEach(() => {
        serverScopedRpcSocketPool.resetForTests();
        resetScopedSessionDataKeyCacheForTests();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    beforeEach(() => {
        storage.setState(initialStorageState, true);
        sessionRpc.mockReset();
    });

    it('clears local thinking state after a deny/abort permission decision', async () => {
        const sessionId = 's_permission_deny';
        storage.getState().applySessions([buildSession(sessionId)]);
        storage.getState().markSessionOptimisticThinking(sessionId);
        sessionRpc.mockResolvedValue({ ok: true });

        await sessionDeny(sessionId, 'perm_1', undefined, undefined, 'abort');

        const session = storage.getState().sessions[sessionId];
        expect(session?.thinking).toBe(false);
        expect(session?.optimisticThinkingAt ?? null).toBeNull();
        expect(typeof session?.thinkingGraceUntil).toBe('number');
        expect(sessionRpc).toHaveBeenCalledWith(
            sessionId, 'permission',
            expect.objectContaining({ id: 'perm_1', approved: false, decision: 'abort' }),
            expect.any(Object),
        );
    });

    it('preserves thinking, optimistic thinking and grace when the CLI rejects the decision', async () => {
        const sessionId = 's_permission_rejected';
        storage.getState().applySessions([buildSession(sessionId)]);
        storage.getState().markSessionOptimisticThinking(sessionId);
        const before = storage.getState().sessions[sessionId];
        sessionRpc.mockResolvedValue({ ok: false, errorCode: 'permission_request_not_found' });

        await sessionDeny(sessionId, 'missing');

        expect(storage.getState().sessions[sessionId]).toBe(before);
    });

    it('does not infer acceptance from a transport-only acknowledgment', async () => {
        const sessionId = 's_permission_unknown';
        storage.getState().applySessions([buildSession(sessionId)]);
        const before = storage.getState().sessions[sessionId];
        sessionRpc.mockResolvedValue(undefined);

        await sessionDeny(sessionId, 'perm_1');

        expect(storage.getState().sessions[sessionId]).toBe(before);
    });

    it('preserves a newly active account when a previous account decision finishes', async () => {
        const sessionId = 's_permission_account_changed';
        const serverId = getActiveServerId();
        storage.setState({ profileScope: { serverId, accountId: 'account-before' } });
        storage.getState().applySessions([buildSession(sessionId)]);
        const before = storage.getState().sessions[sessionId];
        sessionRpc.mockImplementation(async () => {
            storage.setState({ profileScope: { serverId, accountId: 'account-after' } });
            return { ok: true };
        });

        await sessionDeny(sessionId, 'perm_1');

        expect(storage.getState().sessions[sessionId]).toBe(before);
    });

    it('returns the raw rejected occurrence acknowledgment without legacy fallback or local recovery', async () => {
        const sessionId = 's_permission_occurrence';
        storage.getState().applySessions([buildSession(sessionId)]);
        const before = storage.getState().sessions[sessionId];
        const rejected = { ok: false, errorCode: 'permission_request_not_found' };
        sessionRpc.mockResolvedValue(rejected);
        const request = { id: 'reused', occurrenceId: 'old-occurrence', approved: false };

        const result = await dispatchSessionPermissionDecision({ sessionId, request });

        expect(result).toBe(rejected);
        expect(storage.getState().sessions[sessionId]).toBe(before);
        expect(sessionRpc).toHaveBeenCalledWith(
            sessionId, 'session.permission.respondToOccurrence.v1',
            request, expect.any(Object),
        );
        expect(sessionRpc.mock.calls.map((call) => call[1])).toEqual([
            'session.permission.respondToOccurrence.v1',
        ]);
    });

    it('retains foreground session approval policy and provider permission updates without clearing thinking', async () => {
        const sessionId = 's_permission_allow';
        storage.getState().applySessions([buildSession(sessionId)]);
        const before = storage.getState().sessions[sessionId];
        sessionRpc.mockResolvedValue({ ok: true });

        await sessionAllow(sessionId, 'exec', 'acceptEdits', ['Bash'], 'approved_execpolicy_amendment', { command: ['git', 'status'] });
        await sessionAllowWithPermissionUpdates(sessionId, 'suggestion', {
            decision: 'approved_for_session',
            updatedPermissions: [{ type: 'addRules', rules: ['Bash(git status)'] }],
        });

        expect(storage.getState().sessions[sessionId]).toBe(before);
        expect(sessionRpc).toHaveBeenCalledWith(sessionId, 'permission', expect.objectContaining({
            id: 'exec', approved: true, mode: 'acceptEdits', allowedTools: ['Bash'],
            decision: 'approved_execpolicy_amendment', execPolicyAmendment: { command: ['git', 'status'] },
        }), expect.any(Object));
        expect(sessionRpc).toHaveBeenCalledWith(sessionId, 'permission', expect.objectContaining({
            id: 'suggestion', approved: true, decision: 'approved_for_session',
            updatedPermissions: [{ type: 'addRules', rules: ['Bash(git status)'] }],
        }), expect.any(Object));
    });

    it.each([
        { accountId: 'account-target', ack: { ok: true }, recovers: true },
        { accountId: 'account-target', ack: { ok: false }, recovers: false },
        { accountId: 'account-other', ack: { ok: true }, recovers: false },
    ])('recovers explicit-account decisions only after acceptance in the active account: $accountId/$ack.ok', async ({ accountId, ack, recovers }) => {
        const sessionId = 's_explicit_permission';
        const serverId = getActiveServerId();
        storage.setState({ profileScope: { serverId, accountId } });
        storage.getState().applySessions([buildSession(sessionId)]);
        storage.getState().markSessionOptimisticThinking(sessionId);
        const before = storage.getState().sessions[sessionId];
        const tokenPayload = btoa(JSON.stringify({ sub: 'account-target' }));
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: `e30.${tokenPayload}.signature` });
        const sessionResponse = V2SessionByIdResponseSchema.parse({
            session: {
                id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
                archivedAt: null, metadata: 'metadata', metadataVersion: 1, agentState: null, agentStateVersion: 0,
                pendingCount: 0, pendingVersion: 0, encryptionMode: 'plain', dataEncryptionKey: null,
            },
        });
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async () => new Response(JSON.stringify(sessionResponse), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        }))));
        const events = createSocketHarness<Record<string, unknown>>();
        const emitWithAck = vi.fn(async () => ({ ok: true, result: ack }));
        connectSocket.mockReturnValue({
            ...events,
            connected: true,
            connect: () => {},
            disconnect: () => {},
            timeout: () => ({ emitWithAck }),
            emitWithAck,
        });

        const result = await sessionPermissionDecisionWithServerAccountScope({
            scope: { serverId, accountId: 'account-target' }, sessionId, requestId: 'permission',
            occurrenceId: 'current-occurrence', action: 'deny', networkMode: 'background-task',
        });

        expect(result).toBe(ack);
        if (recovers) {
            expect(storage.getState().sessions[sessionId].thinking).toBe(false);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt).toBeNull();
        } else {
            expect(storage.getState().sessions[sessionId]).toBe(before);
        }
        expect(emitWithAck).toHaveBeenCalledWith('rpc-call', expect.objectContaining({
            method: `${sessionId}:session.permission.respondToOccurrence.v1`,
            params: expect.objectContaining({ id: 'permission', occurrenceId: 'current-occurrence', approved: false }),
        }));
    });
});
