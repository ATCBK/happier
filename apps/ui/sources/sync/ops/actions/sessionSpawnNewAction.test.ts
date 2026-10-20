import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS, type SessionSpawnNewResultV1 } from '@happier-dev/protocol';
import { t } from '@/text';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionCreationKeyV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

const boundary = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const sessionSpawnNewAction = await import('./sessionSpawnNewAction');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');

afterAll(() => boundary.dispose());

describe('Session directory preflight through the Action and Machine transport owners', () => {
    afterEach(async () => {
        vi.useRealTimers();
        await serverScopedRpcSocketPool.stopAll();
        await resetServerReachabilitySupervisors();
        resetScopedMachineTransportCacheForTests();
    });

    it('preserves the generic Machine setup deadline through the strict spawn Action consumer before any spawn is issued', async () => {
        boundary.resetRequests();
        const home = await boundary.addHome('https://spawn-preflight.test', 'spawn-account');
        const account = await captureLazyActionAccountContext(home.id);
        const reading = createDeferred<void>();
        boundary.setHttpResponder(async (input, init) => {
            if (new URL(String(input)).pathname !== '/v1/machines/machine-1') return null;
            reading.resolve();
            return await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('private request detail', 'AbortError')), { once: true });
            });
        });
        const input = { creationKey: SessionCreationKeyV1Schema.parse('preflight-deadline'), executionTarget: { serverId: home.id, machineId: 'machine-1' },
            directory: { kind: 'path' as const, path: '/workspace/project' },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            sessionSpawnNewDirectoryApprovalPreflight: sessionSpawnNewAction.createUiSessionSpawnNewDirectoryApprovalPreflight(account),
        }));
        vi.useFakeTimers();
        try {
            const action = sessionSpawnNewAction.executeSessionSpawnNewAction(input,
                { surface: 'ui', authority: 'present_user' }, executor);
            await Promise.race([reading.promise, action.then(() => { throw new Error('Directory preflight was bypassed'); })]);
            await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS);
            const result = await action;
            expect(result).toMatchObject({ ok: true, result: {
                type: 'error', code: 'spawn_failed', retryable: true,
                launchError: { kind: 'launch_error', code: 'MACHINE_RPC_TIMEOUT' },
            } });
            if (!result.ok) throw new Error('Expected a typed Session creation result');
            expect(SessionSpawnNewResultV1Schema.parse(result.result)).toEqual(result.result);
            expect(JSON.stringify(result)).not.toContain('private request detail');
            expect(boundary.requests).toEqual([]);
        } finally {
            account.dispose();
        }
    });

    it.each([
        { errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, code: 'incompatible_target' },
        { errorCode: RPC_ERROR_CODES.FORBIDDEN, code: 'permission_denied' },
    ] as const)('retains the permanent directory refusal $errorCode through the real RPC binding', async ({ errorCode, code }) => {
        boundary.resetRequests();
        const home = await boundary.addHome('https://spawn-preflight-refusal.test', 'spawn-account');
        const account = await captureLazyActionAccountContext(home.id);
        boundary.setRpcAckResponder(async request => {
            expect(request.method).toBe(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT);
            // A typed permanent refusal takes precedence over the bare Socket.IO timeout message.
            return { ok: false, errorCode, error: 'operation has timed out' };
        });
        const input = { creationKey: SessionCreationKeyV1Schema.parse('preflight-refusal'), executionTarget: { serverId: home.id, machineId: 'machine-1' },
            directory: { kind: 'path' as const, path: '/workspace/project' },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            sessionSpawnNewDirectoryApprovalPreflight: sessionSpawnNewAction.createUiSessionSpawnNewDirectoryApprovalPreflight(account),
        }));
        try {
            const result = await sessionSpawnNewAction.executeSessionSpawnNewAction(input,
                { surface: 'ui', authority: 'present_user' }, executor);
            expect(result).toMatchObject({ ok: true, result: { type: 'error', code, retryable: false } });
            expect(new Set(boundary.requests.map(request => request.method))).toEqual(new Set([RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT]));
            expect(JSON.stringify(result)).not.toContain('operation has timed out');
            if (!result.ok) throw new Error('Expected a typed Session creation refusal');
            expect(SessionSpawnNewResultV1Schema.parse(result.result)).toEqual(result.result);
        } finally {
            account.dispose();
        }
    });
});

type FailurePresentationResolver = (result: Readonly<{
    ok: false;
    errorCode: string;
    error: string;
}>) => 'update_required' | 'generic_failure';

type FailureMessageKeyResolver = (result: Readonly<{
    ok: false;
    errorCode: string;
    error: string;
}>) => 'newSession.actionMethodUnavailable' | 'newSession.failedToStart';

type ResultFailureMessageKeyResolver = (
    result: Exclude<SessionSpawnNewResultV1, Readonly<{ type: 'success' }>>,
) =>
    | 'newSession.launchStillPendingBody'
    | 'newSession.daemonRpcUnavailableBody'
    | 'newSession.failedToStart'
    | 'session.access.repairBody'
    | 'session.access.preparationKeyUnavailable'
    | 'teams.policy.externalSharingDisabled'
    | 'teams.policy.externalSharingAdmins';

describe('session.spawn_new Action failure presentation', () => {
    it('exposes only typed content-free approval staleness in the existing error code', () => {
        const failure = { ok: false as const, errorCode: 'approval_stale', error: 'private daemon detail' };
        expect(sessionSpawnNewAction.resolveSessionSpawnNewActionFailureMessage({ ...failure, details: { reason: 'home_changed' } }))
            .toContain('approval_stale:home_changed');
        for (const details of [{ reason: 'private daemon detail' }, { reason: 'home_changed', token: 'private daemon detail' }]) {
            const message = sessionSpawnNewAction.resolveSessionSpawnNewActionFailureMessage({ ...failure, details });
            expect(message).toContain('approval_stale');
            expect(message).not.toContain('home_changed');
            expect(message).not.toContain('private daemon detail');
        }
    });
    it('preserves first-input rejection and uncertainty codes in the existing diagnostic copy', () => {
        const resolve = sessionSpawnNewAction.resolveSessionSpawnNewInitialInputFailureMessage;
        expect(resolve({ status: 'outcomeUnknown', localId: 'first-input', code: 'session_input_admission_outcome_unknown' }, t('newSession.initialInputNotConfirmed')))
            .toBe(t('errors.errorWithCode', { message: t('newSession.initialInputNotConfirmed'), code: 'session_input_admission_outcome_unknown' }));
        expect(resolve({ status: 'rejected', code: 'session_input_storage_unavailable' }, t('session.pendingMessages.admissionRejected.storageUnavailable')))
            .toContain('session_input_storage_unavailable');
    });

    it('retains strict rejection and Action error codes in generic user-facing messages', () => {
        expect(sessionSpawnNewAction.resolveSessionSpawnNewResultFailureMessage({
            type: 'error', code: 'spawn_failed', retryable: false,
            launchError: { kind: 'launch_error', code: 'connected_service_credential_reconnect_required', message: 'Reconnect this account.' },
        })).toBe(t('connectedServices.diagnostics.body.connected_service_credential_reconnect_required'));
        expect(sessionSpawnNewAction.resolveSessionSpawnNewResultFailureMessage({
            type: 'error', code: 'creation_conflict', retryable: false,
        })).toContain('creation_conflict');
        const message = sessionSpawnNewAction.resolveSessionSpawnNewActionFailureMessage({
            ok: false, errorCode: 'action_account_scope_changed', error: 'private daemon detail',
        });
        expect(message).toContain('action_account_scope_changed');
        expect(message).not.toContain('private daemon detail');
        expect(sessionSpawnNewAction.resolveSessionSpawnNewResultFailureMessage({
            type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown',
        })).toBe(t('newSession.launchStillPendingBody'));
        expect(sessionSpawnNewAction.resolveSessionSpawnNewActionFailureMessage({
            ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, error: 'RPC method not available',
        })).toBe(t('newSession.actionMethodUnavailable'));
    });

    it('reserves update guidance for an unavailable Action method', () => {
        const resolveFailurePresentation = (
            sessionSpawnNewAction as unknown as Readonly<{
                resolveSessionSpawnNewActionFailurePresentation?: FailurePresentationResolver;
            }>
        ).resolveSessionSpawnNewActionFailurePresentation;

        expect(resolveFailurePresentation?.({
            ok: false,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            error: 'RPC method not available',
        })).toBe('update_required');
        expect(resolveFailurePresentation?.({
            ok: false,
            errorCode: 'action_method_unavailable',
            error: 'offline',
        })).toBe('generic_failure');

        const resolveFailureMessageKey = (
            sessionSpawnNewAction as unknown as Readonly<{
                resolveSessionSpawnNewActionFailureMessageKey?: FailureMessageKeyResolver;
            }>
        ).resolveSessionSpawnNewActionFailureMessageKey;
        expect(resolveFailureMessageKey?.({
            ok: false,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            error: 'RPC method not available',
        })).toBe('newSession.actionMethodUnavailable');
        expect(resolveFailureMessageKey?.({
            ok: false,
            errorCode: 'daemon_unavailable',
            error: 'offline',
        })).toBe('newSession.failedToStart');
    });

    it('keeps pending and server-proven machine-offline outcomes distinct from other typed rejections', () => {
        const resolveResultFailureMessageKey = (
            sessionSpawnNewAction as unknown as Readonly<{
                resolveSessionSpawnNewResultFailureMessageKey?: ResultFailureMessageKeyResolver;
            }>
        ).resolveSessionSpawnNewResultFailureMessageKey;

        expect(resolveResultFailureMessageKey?.({
            type: 'pending',
            retryWithSameCreationKey: true,
            outcome: 'unknown',
        })).toBe('newSession.launchStillPendingBody');
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'machine_offline',
            retryable: true,
        })).toBe('newSession.daemonRpcUnavailableBody');
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'target_unavailable',
            retryable: true,
        })).toBe('newSession.failedToStart');
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'organization_invalid',
            retryable: false,
        })).toBe('newSession.failedToStart');
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'recipient_key_unavailable',
            retryable: false,
        })).toBe('session.access.repairBody');
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'session_access_invalid_recipient_envelope',
            retryable: false,
        })).toBe('session.access.repairBody');
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'session_data_key_unavailable',
            retryable: false,
        })).toBe('session.access.preparationKeyUnavailable');
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'session_access_external_sharing_disabled',
            retryable: false,
        })).toBe('teams.policy.externalSharingDisabled');
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'session_access_external_sharing_requires_team_admin',
            retryable: false,
        })).toBe('teams.policy.externalSharingAdmins');
        // A Home whose Session sharing is off refuses access-bearing creation with
        // its own reason; the copy states that cause instead of a generic failure.
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'session_access_sharing_unavailable',
            retryable: false,
        })).toBe('session.collaboration.accessUnavailableReason');
    });
});
