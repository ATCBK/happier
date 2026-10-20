import { RPC_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SessionLookupByTagsResponseV2Schema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionMessageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { normalizeSessionCreationOrganizationPlacementV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { SessionSpawnNewResultV1Schema, type SessionSpawnNewInitialInputDispositionV1, type SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { projectSessionFollowSourceKeyPreparationAfterSetV1, type SessionFollowSourceKeyPreparationResultV1, SessionFollowSourceKeyPreparationResultV1Schema, SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_ACTION_ERROR_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { SessionCreationTargetPreparationResultV1Schema, needsSessionCreationDirectoryApprovalPreflightV1,
    projectSessionCreationDirectoryApprovalV1,
} from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import type { ActionOperationFailureV1, ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { ApprovalStaleFailureDetailsSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { UiActionExecutorContext } from './defaultActionExecutor';
import type { SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { SessionRequesterBootstrapV1, SessionRequesterBootstrapRpcRequestV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createSpawnAttemptKeyForSessionSpawnNewInput } from '@/sync/domains/session/spawn/spawnAttemptKey';
import {
    acquireSpawnAttemptCustody,
    clearSpawnAttemptCustody,
    markSpawnAttemptCreated,
    markSpawnAttemptSubmitted,
    type PersistedSpawnAttempt,
} from '@/sync/domains/session/spawn/spawnAttemptNonceStore';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readSpawnSessionRpcTimeoutMsFromEnv } from '@/sync/domains/session/spawn/spawnSessionRpcTimeout';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { isMachineRpcTimeoutError, MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@/sync/runtime/orchestration/serverScopedRpc/machineRpcTimeoutError';
import { isSocketIoAckTimeoutError, readRpcRequestDisposition } from '@happier-dev/sync-client';
import { parseToken } from '@/utils/auth/parseToken';

import { createFrontDoorActionExecute, requireActionSuccess } from './frontDoorRuntimeActionExecutor';
import { captureLazyActionAccountContext, withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';
import { prepareSessionFollowSourceKey } from '@/components/sessions/follow/prepareSessionFollowSourceKey';
import { t } from '@/text';
import { buildManualSessionCreationKey, readManualSessionSpawnOperation, readManualSessionSpawnOperationDetails } from '@/sync/domains/session/spawn/manualSessionSpawnOperation';
import { recordBugReportUserAction } from '@/utils/system/bugReportActionTrail';
export { buildManualSessionCreationKey } from '@/sync/domains/session/spawn/manualSessionSpawnOperation';

export type StrictSessionSpawnNewInput = SessionSpawnNewInputV2 & Readonly<{
    creationKey: NonNullable<SessionSpawnNewInputV2['creationKey']>;
}>;

export type SessionSpawnNewActionResult =
    | Readonly<{ ok: true; result: SessionSpawnNewResultV1 }>
    | Extract<ActionExecuteResult, Readonly<{ ok: false }>>;

/** Read-only target preparation precedes the UI Artifact, as it does for CLI approvals. */
export function createUiSessionSpawnNewDirectoryApprovalPreflight(
    account: LazyActionAccountContext | null,
): NonNullable<ActionExecutorDeps['sessionSpawnNewDirectoryApprovalPreflight']> {
    return async ({ input, signal }) => {
        if (!needsSessionCreationDirectoryApprovalPreflightV1(input)) return { type: 'not_required' };
        if (!account) return { type: 'error', result: { type: 'error', code: 'permission_denied', retryable: false } };
        account.assertCurrent();
        const raw = await withActionAccountRequestSignal(account, signal, ownedSignal => machineRpcWithServerScope<unknown, { directory: SessionSpawnNewInputV2['directory'] }>({
            serverId: input.executionTarget.serverId, accountId: account.accountId,
            machineId: input.executionTarget.machineId, method: RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
            payload: { directory: input.directory }, signal: ownedSignal,
        }));
        account.assertCurrent();
        const prepared = SessionCreationTargetPreparationResultV1Schema.safeParse(raw);
        if (!prepared.success) return { type: 'error', result: { type: 'error', code: 'incompatible_target', retryable: false,
            incompatibleTarget: { reason: 'target_preparation_invalid_result' } } };
        if (!prepared.data.ok) return { type: 'error', result: { type: 'error',
            code: prepared.data.code === 'invalid_directory' ? 'invalid_input' : 'spawn_failed',
            retryable: prepared.data.code !== 'invalid_directory' } };
        const approval = projectSessionCreationDirectoryApprovalV1(input.executionTarget, prepared.data);
        return approval ? { type: 'approval_required', approval } : { type: 'not_required' };
    };
}

export type ManualSessionSpawnNewActionCustody = PersistedSpawnAttempt;

/** A waiting private-key transfer is not a failed creation; consume only its validated committed DTO. */
export function readCommittedSessionSpawnNewActionResult(action: SessionSpawnNewActionResult):
    Extract<SessionSpawnNewResultV1, Readonly<{ type: 'success' }>> | null {
    if (action.ok) return action.result.type === 'success' ? action.result : null;
    if (action.errorCode !== SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_ACTION_ERROR_V1) return null;
    const details = action.details;
    if (!details || typeof details !== 'object') return null;
    const record = details as Readonly<Record<string, unknown>>;
    if (record.status !== 'waiting' || record.edgeCommitted !== true) return null;
    const preparation = SessionFollowSourceKeyPreparationResultV1Schema.safeParse({ kind: 'waiting', reason: record.reason });
    const committed = SessionSpawnNewResultV1Schema.safeParse(record.source);
    return preparation.success && committed.success && committed.data.type === 'success' ? committed.data : null;
}

/**
 * The one step that asks for a Session to be created. The UI's own Action executor is the
 * default; a presentation host that owns creation itself (the embed's new chat, plan 05 §4.3.5)
 * supplies its own. Custody, creation identity and retry stay with the manual launch owner.
 */
export type SessionSpawnNewActionExecutor = (
    input: StrictSessionSpawnNewInput,
    context: UiActionExecutorContext,
) => Promise<SessionSpawnNewActionResult>;

export type ManualSessionSpawnNewActionExecutionResult =
    | Readonly<{
        status: 'executed';
        action: SessionSpawnNewActionResult;
        custody: ManualSessionSpawnNewActionCustody;
    }>
    | Readonly<{
        status: 'custody_unavailable';
        reason: 'corrupt' | 'lock_unavailable';
    }>;

export type SessionSpawnNewActionFailurePresentation =
    | 'update_required'
    | 'generic_failure';

export type SessionSpawnNewActionFailureMessageKey =
    | 'newSession.actionMethodUnavailable'
    | 'newSession.failedToStart';

export type SessionSpawnNewResultFailureMessageKey =
    | 'connectedServices.diagnostics.body.connected_service_credential_reconnect_required'
    | 'connectedServices.diagnostics.body.connected_service_credential_refresh_unavailable'
    | 'newSession.launchStillPendingBody'
    | 'newSession.daemonRpcUnavailableBody'
    | 'session.access.repairBody'
    | 'session.access.preparationKeyUnavailable'
    | 'teams.policy.externalSharingDisabled'
    | 'teams.policy.externalSharingAdmins'
    | 'session.collaboration.accessUnavailableReason'
    | 'newSession.failedToStart';

/**
 * Keeps the strict creation callers on one typed compatibility presentation.
 * An older CLI can reject the Action method before it sees a spawn request;
 * that is distinct from an ordinary creation failure and never authorizes a
 * private-RPC retry.
 */
export function resolveSessionSpawnNewActionFailurePresentation(
    result: Extract<SessionSpawnNewActionResult, Readonly<{ ok: false }>>,
): SessionSpawnNewActionFailurePresentation {
    return result.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        ? 'update_required'
        : 'generic_failure';
}

export function resolveSessionSpawnNewActionFailureMessageKey(
    result: Extract<SessionSpawnNewActionResult, Readonly<{ ok: false }>>,
): SessionSpawnNewActionFailureMessageKey {
    return resolveSessionSpawnNewActionFailurePresentation(result) === 'update_required'
        ? 'newSession.actionMethodUnavailable'
        : 'newSession.failedToStart';
}

/**
 * Projects the strict action result without discarding its originating typed
 * outcome. Only an explicit `machine_offline` result claims unavailable
 * daemon transport; a caller deadline is a neutral spawn failure.
 */
export function resolveSessionSpawnNewResultFailureMessageKey(
    result: Exclude<SessionSpawnNewResultV1, Readonly<{ type: 'success' }>>,
): SessionSpawnNewResultFailureMessageKey {
    if (result.type === 'pending') {
        return 'newSession.launchStillPendingBody';
    }
    if (result.code === 'spawn_failed' && result.launchError?.code === 'connected_service_credential_reconnect_required') {
        return 'connectedServices.diagnostics.body.connected_service_credential_reconnect_required';
    }
    if (result.code === 'spawn_failed' && result.launchError?.code === 'connected_service_credential_refresh_unavailable') {
        return 'connectedServices.diagnostics.body.connected_service_credential_refresh_unavailable';
    }
    if (
        result.code === 'recipient_key_unavailable'
        || result.code === 'session_access_invalid_recipient_envelope'
    ) {
        return 'session.access.repairBody';
    }
    if (result.code === 'session_data_key_unavailable') {
        return 'session.access.preparationKeyUnavailable';
    }
    if (result.code === 'session_access_external_sharing_disabled') {
        return 'teams.policy.externalSharingDisabled';
    }
    if (result.code === 'session_access_external_sharing_requires_team_admin') {
        return 'teams.policy.externalSharingAdmins';
    }
    if (result.code === 'session_access_sharing_unavailable') {
        return 'session.collaboration.accessUnavailableReason';
    }
    return result.code === 'machine_offline'
        ? 'newSession.daemonRpcUnavailableBody'
        : 'newSession.failedToStart';
}

/** Keep localized recovery guidance while exposing the typed cause of otherwise generic failures. */
export function resolveSessionSpawnNewActionFailureMessage(
    result: Extract<SessionSpawnNewActionResult, Readonly<{ ok: false }>>,
): string {
    const key = resolveSessionSpawnNewActionFailureMessageKey(result);
    const message = t(key);
    return key === 'newSession.failedToStart'
        ? t('errors.errorWithCode', { message, code: sessionSpawnFailureDisplayCode(result) })
        : message;
}

function sessionSpawnFailureDisplayCode(failure: Readonly<{ errorCode: string; details?: unknown }>): string {
    const stale = failure.errorCode === 'approval_stale' ? ApprovalStaleFailureDetailsSchema.safeParse(failure.details) : null;
    return stale?.success ? `${failure.errorCode}:${stale.data.reason}` : failure.errorCode;
}

export function resolveSessionSpawnNewResultFailureMessage(
    result: Exclude<SessionSpawnNewResultV1, Readonly<{ type: 'success' }>>,
): string {
    const key = resolveSessionSpawnNewResultFailureMessageKey(result);
    const message = t(key);
    return result.type !== 'pending' && key === 'newSession.failedToStart'
        ? t('errors.errorWithCode', { message, code: result.code })
        : message;
}

/** Present a terminal operation failure through the same localized spawn-failure owner as the direct Action path. */
export function resolveSessionSpawnNewOperationFailureMessage(
    failure: ActionOperationFailureV1,
): string {
    return t('errors.errorWithCode', {
        message: t('newSession.failedToStart'),
        code: sessionSpawnFailureDisplayCode(failure),
    });
}

/** First-input admission is separate from creation; retain its diagnostic without claiming rejection. */
export function resolveSessionSpawnNewInitialInputFailureMessage(
    initialInput: Extract<SessionSpawnNewInitialInputDispositionV1, { status: 'rejected' | 'outcomeUnknown' }>,
    message: string,
): string {
    return t('errors.errorWithCode', { message, code: initialInput.code });
}

/**
 * UI's sole public ordinary Session-creation client. The Action executor owns
 * transport, trusted caller stamping, approvals, cancellation, and typed
 * method-unavailable results; callers supply only strict V2 authored input.
 */
export async function executeSessionSpawnNewAction(
    input: StrictSessionSpawnNewInput,
    context: UiActionExecutorContext,
    executor?: Parameters<typeof createFrontDoorActionExecute>[0],
): Promise<SessionSpawnNewActionResult> {
    const result = await createFrontDoorActionExecute(executor)('session.spawn_new', input, context);
    if (!result.ok) return result;
    requireActionSuccess(result);
    return {
        ok: true,
        result: SessionSpawnNewResultV1Schema.parse(result.result),
    };
}

/**
 * The Action executor's daemon transport for one strict spawn request.
 *
 * Creating a Session is a spawn lifecycle, so it waits for the daemon for the
 * spawn budget every other spawn path uses (the Home relay honours the same
 * value), not the generic 30 s machine RPC default: a daemon stalled past that
 * default still creates the Session and admits the first message.
 *
 * When the deadline passes after the request was emitted, the daemon may
 * already hold the Session. That is an unknown outcome, not a failure — the
 * same settlement the daemon reports for its own lost acknowledgements — and
 * only a retry with the same creation key can resolve it. Before issuance, a
 * timeout is a retryable failure because no creation request reached the daemon.
 */
export async function dispatchSessionSpawnNewToMachine(params: Readonly<{
    payload: SessionSpawnNewInputV2;
    requesterBootstrap?: SessionRequesterBootstrapV1;
    signal?: AbortSignal;
}>): Promise<SessionSpawnNewResultV1> {
    const startedAtMs = Date.now();
    let issued = false;
    let issuedAtMs: number | undefined;
    const readPhaseTiming = () => {
        const nowMs = Date.now();
        return {
            phase: issued ? 'response' : 'setup',
            issued,
            elapsedMs: Math.max(0, nowMs - startedAtMs),
            phaseElapsedMs: Math.max(0, nowMs - (issuedAtMs ?? startedAtMs)),
        };
    };
    try {
        const payload: SessionSpawnNewInputV2 | SessionRequesterBootstrapRpcRequestV1 = params.requesterBootstrap
            ? { kind: 'requester_session_bootstrap_v1', input: params.payload, requesterBootstrap: params.requesterBootstrap }
            : params.payload;
        const result = await machineRpcWithServerScope<SessionSpawnNewResultV1, typeof payload>({
            serverId: params.payload.executionTarget.serverId,
            machineId: params.payload.executionTarget.machineId,
            method: RPC_METHODS.SESSION_SPAWN_NEW,
            payload,
            ...(params.requesterBootstrap ? {
                accountId: parseToken(params.requesterBootstrap.credentials.token),
                // A Plain Account still has private authentication; the installed
                // requester wrapper protects it without requiring an Account DEK.
                requireEncryptedPayload: true,
            } : {}),
            timeoutMs: readSpawnSessionRpcTimeoutMsFromEnv(),
            signal: params.signal,
            onIssued: () => { issued = true; issuedAtMs = Date.now(); },
        });
        if (result?.type === 'error') {
            const refusal = SessionSpawnNewResultV1Schema.safeParse(result);
            if (refusal.success && refusal.data.type === 'error') {
                recordBugReportUserAction('session.spawn_new.daemon_refusal', {
                    metadata: { ...readPhaseTiming(), resultCode: refusal.data.code },
                });
            }
        }
        return result;
    } catch (error) {
        const record = error && typeof error === 'object' ? error as Readonly<Record<string, unknown>> : null;
        const code = readRpcErrorCode(error) ?? record?.code;
        // Only known diagnostic constants may enter the existing local trail.
        // Messages, stacks, payloads and arbitrary token-shaped names/codes stay private.
        const errorCode = Object.values(RPC_ERROR_CODES).some(value => value === code)
            || code === MACHINE_RPC_TIMEOUT_ERROR_CODE || code === 'MACHINE_RPC_ABORTED' || code === 'SOCKET_RPC_ABORTED'
            ? String(code) : 'unknown';
        const errorName = typeof record?.name === 'string'
            && ['Error', 'RpcError', 'AbortError', 'TimeoutError', 'TypeError', 'RangeError', 'AxiosError'].includes(record.name)
            ? record.name : 'unknown';
        recordBugReportUserAction('session.spawn_new.transport_failure', {
            metadata: {
                ...readPhaseTiming(), errorName, errorCode,
                requestDisposition: readRpcRequestDisposition(error) ?? 'unknown',
                transportScope: record?.scope === 'active' || record?.scope === 'scoped' ? record.scope : 'unknown',
            },
        });
        // A scoped-rpc socket recycled after the emit clears the acknowledgement with
        // RPC_OUTCOME_UNKNOWN: like a timeout, the daemon may already be creating the Session.
        if (isSocketIoAckTimeoutError(error) || isMachineRpcTimeoutError(error) || code === RPC_ERROR_CODES.OUTCOME_UNKNOWN) {
            return issued
                ? { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' }
                : { type: 'error', code: 'spawn_failed', retryable: true };
        }
        throw error;
    }
}

/** The durable creation result remains explicit when the attached lead's private material cannot be prepared. */
export async function dispatchSessionSpawnNewWithManagerPreparation(params: Readonly<{
    payload: SessionSpawnNewInputV2;
    requesterBootstrap?: SessionRequesterBootstrapV1;
    signal?: AbortSignal;
}>): Promise<SessionSpawnNewResultV1 | Extract<ActionExecuteResult, Readonly<{ ok: false }>>> {
    const committed = await dispatchSessionSpawnNewToMachine(params);
    const manager = params.payload.manager;
    if (committed.type !== 'success' || !manager) return committed;
    let preparation: SessionFollowSourceKeyPreparationResultV1;
    try {
        preparation = await prepareSessionFollowSourceKey({
            serverId: params.payload.executionTarget.serverId,
            sourceSessionId: committed.sessionId,
            destinationSessionId: manager.sessionId,
            signal: params.signal,
        });
    } catch {
        preparation = { kind: 'waiting', reason: 'runner_unreachable' };
    }
    const projected = projectSessionFollowSourceKeyPreparationAfterSetV1({ source: committed }, preparation);
    return 'ok' in projected ? projected : committed;
}

/** The operation, rather than Session existence, owns accepted startup and first-input settlement. */
export function projectManualSessionSpawnOperationResult(operation: ActionOperationSnapshotV1): SessionSpawnNewActionResult {
    if (operation.state === 'succeeded') {
        return { ok: true, result: SessionSpawnNewResultV1Schema.parse(operation.result) };
    }
    if (operation.state === 'failed' || operation.state === 'cancelled') {
        return { ok: false, errorCode: operation.error?.errorCode ?? 'action_cancelled', error: operation.error?.error ?? 'action_cancelled',
            ...(operation.error?.details ? { details: operation.error.details } : {}) };
    }
    return { ok: true, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' } };
}

/**
 * Reconcile an acknowledgement, never create or re-admit input. The authenticated
 * owner-only tag read proves this attempt's committed Session; its first-input
 * local id separately proves admission. A missing input receipt stays unknown.
 */
async function reconcileManualSessionCreation(
    input: StrictSessionSpawnNewInput,
    custody: PersistedSpawnAttempt,
    sourceAccountLifetime?: Pick<ServerAccountScopeLifetime, 'isCurrent'>,
): Promise<SessionSpawnNewActionResult | null> {
    let account: LazyActionAccountContext | undefined;
    const isSourceCurrent = () => sourceAccountLifetime?.isCurrent() !== false;
    try {
        if (!isSourceCurrent()) return null;
        account = await captureLazyActionAccountContext(custody.scope.serverId);
        if (account.accountId !== custody.scope.accountId || !isSourceCurrent()) return null;
        const response = await account.request('/v2/sessions/lookup-by-tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags: [deriveSessionCreationTagV1({
                callerCreationNamespace: 'user', creationKey: input.creationKey,
            })] }),
        }, { retry: 'none' });
        if (!response.ok) return null;
        const lookup = SessionLookupByTagsResponseV2Schema.safeParse(await response.json());
        account.assertCurrent();
        if (!isSourceCurrent() || !lookup.success || lookup.data.sessions.length !== 1) return null;
        const session = lookup.data.sessions[0]!;
        if (session.archivedAt != null) return null;
        let initialInput: SessionSpawnNewInitialInputDispositionV1 = { status: 'notRequested' };
        if (input.initialInput) {
            initialInput = { status: 'outcomeUnknown', localId: custody.firstTurnLocalId, code: 'session_input_admission_outcome_unknown' };
            try {
                const receipt = await account.request(`/v2/sessions/${encodeURIComponent(session.id)}/messages/by-local-id/${encodeURIComponent(custody.firstTurnLocalId)}`,
                    undefined, { retry: 'none' });
                if (receipt.ok) {
                    const body: unknown = await receipt.json();
                    const message = SessionMessageV1Schema.safeParse(body && typeof body === 'object' && 'message' in body ? body.message : null);
                    if (message.success && message.data.localId === custody.firstTurnLocalId && message.data.messageRole === 'user') {
                        initialInput = { status: 'alreadyAccepted', localId: custody.firstTurnLocalId };
                    }
                }
            } catch {
                // A first-input read cannot undo the independently proven create.
            }
        }
        account.assertCurrent();
        if (!isSourceCurrent()) return null;
        return { ok: true, result: SessionSpawnNewResultV1Schema.parse({
            type: 'success', disposition: 'rejoined', sessionId: session.id,
            executionTarget: input.executionTarget,
            organizationPlacement: normalizeSessionCreationOrganizationPlacementV1(input.organizationPlacement),
            initialInput,
        }) };
    } catch {
        // Unavailable evidence preserves the original Action outcome and custody.
        return null;
    } finally {
        account?.dispose();
    }
}

/**
 * Runs the canonical manual Action through the existing crash-stable custody
 * owner. The store is local recovery state only: Action request identity and
 * `creationKey` remain the sole executable/durable Session identities.
 */
export async function executeManualSessionSpawnNewAction(
    input: StrictSessionSpawnNewInput,
    context: UiActionExecutorContext,
    params: Readonly<{
        scope: ServerAccountScope;
        machineHomeDir: string;
        userAttemptId: string;
        seedNonce?: string | null;
        sourceAccountLifetime?: Pick<ServerAccountScopeLifetime, 'isCurrent'>;
        executeAction?: SessionSpawnNewActionExecutor;
    }>,
): Promise<ManualSessionSpawnNewActionExecutionResult> {
    const userAttemptId = params.userAttemptId.trim();
    const expectedCreationKey = buildManualSessionCreationKey(userAttemptId);
    if (input.creationKey !== expectedCreationKey) {
        throw new Error('Manual Session creation identity does not match launch custody');
    }
    if (context.actionRequestId !== userAttemptId) {
        throw new Error('Manual Session Action request identity does not match launch custody');
    }
    if (
        input.executionTarget.machineId !== input.executionTarget.machineId.trim()
        || input.executionTarget.serverId !== params.scope.serverId
    ) {
        throw new Error('Manual Session execution target does not match launch custody');
    }
    const targetFingerprint = createSpawnAttemptKeyForSessionSpawnNewInput(
        input,
        params.machineHomeDir,
    );
    const acquired = await acquireSpawnAttemptCustody({
        scope: params.scope,
        machineId: input.executionTarget.machineId,
        targetFingerprint,
        userAttemptId,
        seedNonce: params.seedNonce,
    });
    if (acquired.status !== 'acquired') {
        return { status: 'custody_unavailable', reason: acquired.status };
    }
    const submitted = await markSpawnAttemptSubmitted({
        scope: params.scope,
        machineId: input.executionTarget.machineId,
        targetFingerprint,
        userAttemptId,
        nonce: acquired.record.nonce,
    });
    if (!submitted) {
        return { status: 'custody_unavailable', reason: 'lock_unavailable' };
    }

    const observedOperation = acquired.reused ? readManualSessionSpawnOperation(params.scope, userAttemptId) : null;
    const operation = observedOperation
        ? await readManualSessionSpawnOperationDetails(params.scope, observedOperation,
            () => params.sourceAccountLifetime?.isCurrent() !== false)
        : null;
    const observed = operation ? projectManualSessionSpawnOperationResult(operation) : null;
    const reconciled = !observed && acquired.reused && acquired.record.submissionState === 'submitted'
        ? await reconcileManualSessionCreation(input, submitted, params.sourceAccountLifetime)
        : null;
    // Custody acquisition and reconciliation may outlive the originating draft's
    // Account authority. Fence actual issuance after those reads have settled.
    const sourceAdmissionRetired = params.sourceAccountLifetime !== undefined && !params.sourceAccountLifetime.isCurrent();
    let action: SessionSpawnNewActionResult = sourceAdmissionRetired
        ? { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' }
        : observed ?? reconciled ?? await (params.executeAction ?? executeSessionSpawnNewAction)(input, {
            ...context,
            expectedAccountId: params.scope.accountId,
        });
    if (!observed && ((!action.ok && action.errorCode === 'action_failed') || (action.ok && action.result.type === 'pending' && action.result.outcome === 'unknown'))) {
        action = await reconcileManualSessionCreation(input, submitted, params.sourceAccountLifetime) ?? action;
    }
    let custody = submitted;
    const committed = readCommittedSessionSpawnNewActionResult(action);
    if (committed
        && committed.executionTarget.serverId === input.executionTarget.serverId
        && committed.executionTarget.machineId === input.executionTarget.machineId) {
        custody = await markSpawnAttemptCreated({
            scope: params.scope,
            machineId: input.executionTarget.machineId,
            targetFingerprint,
            userAttemptId,
            nonce: submitted.nonce,
            createdSessionId: committed.sessionId,
        }) ?? submitted;
    }
    const terminalWithoutCommittedSession = sourceAdmissionRetired || (
        !action.ok && action.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
    ) || (
        action.ok && action.result.type === 'error' && action.result.retryable === false
    );
    if (terminalWithoutCommittedSession) {
        await clearSpawnAttemptCustody({
            scope: submitted.scope,
            machineId: submitted.machineId,
            targetFingerprint: submitted.targetFingerprint,
            userAttemptId: submitted.userAttemptId,
            nonce: submitted.nonce,
        });
    }
    return { status: 'executed', action, custody };
}

/** Clears custody only after the caller has durably consumed the Action result. */
export async function completeManualSessionSpawnNewActionCustody(
    custody: ManualSessionSpawnNewActionCustody,
): Promise<boolean> {
    return await clearSpawnAttemptCustody({
        scope: custody.scope,
        machineId: custody.machineId,
        targetFingerprint: custody.targetFingerprint,
        userAttemptId: custody.userAttemptId,
        nonce: custody.nonce,
    });
}
