import * as React from 'react';
import type { ActionOperationFailureV1 } from '@happier-dev/protocol/actions/operations/v1';

import { actionOperationPresentationCoordinator } from '@/components/inbox/actionOperations/actionOperationPresentationRuntime';
import {
    readActionOperationDestinationServerId,
    readActionOperationDestinationSessionId,
    readActionOperationSessionSpawnNewInitialInput,
} from '@/components/inbox/actionOperations/actionOperationPresentation';
import { createNewSessionActionOperationOrigin } from '@/components/sessions/new/navigation/newSessionActionOperationOrigin';
import {
    presentCreatedNewSession,
    projectAcceptedNewSessionFirstTurn,
} from '@/components/sessions/new/navigation/presentCreatedNewSession';
import {
    clearCapturedNewSessionDraftAfterLaunch,
    preserveCreatedSessionDraftAfterUnacceptedFirstTurn,
    readCapturedNewSessionFirstTurnText,
} from '@/components/sessions/new/modules/newSessionDraftLifecycle';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { buildManualSessionCreationKey, readManualSessionSpawnOperation, readManualSessionSpawnOperationDetails } from '@/sync/domains/session/spawn/manualSessionSpawnOperation';
import { qualifyActionOperationSnapshot } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR } from '@/sync/runtime/sessionMessageDeliveryErrors';
import { captureExceptionIfEnabled } from '@/utils/system/sentry';
import { settleSpawnAttemptCustodyFromActionOperation } from '@/sync/domains/session/spawn/spawnAttemptNonceStore';
import type { SessionSpawnNewInitialInputDispositionV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type { QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import type { NewSessionLaunchApprovalNoticeState } from '@/components/sessions/new/components/NewSessionLaunchApprovalNotice';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

type NewSessionReentryRouter = Readonly<{
    replace(path: unknown, options?: unknown): void;
}>;

export type NewSessionLaunchApproval = Readonly<{
    /** The launch waiting on an approval, or null. */
    pending: Readonly<{ artifactId: string; serverId: string }> | null;
    notice: NewSessionLaunchApprovalNoticeState | null;
    /** The launch's front door deferred to an approval; this owner waits on it and settles the launch. */
    request: (approval: ActionApprovalContinuation) => void;
}>;

/**
 * A durable Action operation rejoined without its mounted creation completion: present the
 * created session once, then retire the draft and the launch custody. False when presentation was
 * abandoned because the surface went away.
 */
async function settleCreatedNewSessionLaunch(input: Readonly<{
    sessionId: string;
    destinationServerId: string;
    draftScope: ServerAccountScope;
    draftId: string;
    requestId: string;
    initialInputLocalId: string | null;
    capturedFirstTurnText: string | null;
    router: NewSessionReentryRouter;
    isStillActive: () => boolean;
    operation?: QualifiedActionOperation;
    disableDraftPersistence: () => void;
}>): Promise<boolean> {
    const { sessionId, destinationServerId, draftScope, requestId, initialInputLocalId, capturedFirstTurnText } = input;
    const presentation = await presentCreatedNewSession({
        sessionId,
        serverId: destinationServerId,
        accountId: draftScope.accountId,
        requestId: input.operation?.snapshot.requestId ?? requestId,
        router: input.router,
        isStillActive: input.isStillActive,
        ...(input.operation ? { operation: input.operation } : {}),
        prepareDestination: capturedFirstTurnText
            ? () => {
                if (initialInputLocalId) {
                    projectAcceptedNewSessionFirstTurn({
                        sessionId,
                        localId: initialInputLocalId,
                        text: capturedFirstTurnText,
                    });
                    return;
                }
                preserveCreatedSessionDraftAfterUnacceptedFirstTurn({
                    scope: {
                        serverId: destinationServerId,
                        accountId: draftScope.accountId,
                    },
                    sessionId,
                    draftText: capturedFirstTurnText,
                });
            }
            : undefined,
    });
    if (presentation !== 'opened') {
        if (presentation === 'unavailable') {
            throw new Error(CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR);
        }
        return false;
    }
    input.disableDraftPersistence();
    await clearCapturedNewSessionDraftAfterLaunch({
        scope: draftScope,
        draftId: input.draftId,
        launchUserAttemptId: requestId,
    });
    await settleSpawnAttemptCustodyFromActionOperation({
        scope: {
            serverId: destinationServerId,
            accountId: draftScope.accountId,
        },
        userAttemptId: requestId,
        createdSessionId: sessionId,
    });
    return true;
}

function readAcceptedInitialInputLocalId(initialInput: SessionSpawnNewInitialInputDispositionV1 | null | undefined): string | null {
    return initialInput?.status === 'accepted' || initialInput?.status === 'alreadyAccepted'
        ? initialInput.localId
        : null;
}

export function useNewSessionActionOperationReconciliation(params: Readonly<{
    draftId: string;
    requestId: string | null;
    draftScope: ServerAccountScope | null;
    localCreationInFlight: boolean;
    disableDraftPersistence: () => void;
    resetLaunchRequestId: (requestId: null) => void;
    onOperationFailure?: (failure: ActionOperationFailureV1) => void;
    router: NewSessionReentryRouter;
}>): Readonly<{ isCreatingFromOperation: boolean; launchApproval: NewSessionLaunchApproval }> {
    const readOperation = () => params.draftScope && params.requestId
        ? readManualSessionSpawnOperation(params.draftScope, params.requestId)
        : null;
    const operation = React.useSyncExternalStore(actionOperationStore.subscribe, readOperation, readOperation);
    const handledTerminalOperationIdRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!params.requestId || !params.draftScope) return;
        for (const requestId of [params.requestId, buildManualSessionCreationKey(params.requestId)]) {
            actionOperationPresentationCoordinator.register({
                serverId: params.draftScope.serverId,
                accountId: params.draftScope.accountId,
                requestId,
                onStart: 'current',
                origin: createNewSessionActionOperationOrigin(params.draftScope, params.draftId),
            });
        }
    }, [params.draftId, params.draftScope, params.requestId]);

    React.useEffect(() => {
        if (
            params.localCreationInFlight
            || !operation
            || operation.actionId !== 'session.spawn_new'
            || (operation.state !== 'failed' && operation.state !== 'cancelled')
            || handledTerminalOperationIdRef.current === operation.operationId
        ) {
            return;
        }
        handledTerminalOperationIdRef.current = operation.operationId;
        params.resetLaunchRequestId(null);
        if (operation.state === 'failed' && operation.error) {
            params.onOperationFailure?.(operation.error);
        }
    }, [operation, params.localCreationInFlight, params.onOperationFailure, params.resetLaunchRequestId]);

    React.useEffect(() => {
        if (
            params.localCreationInFlight
            || !params.requestId
            || !params.draftScope
            || !operation
            || operation.actionId !== 'session.spawn_new'
            || operation.state !== 'succeeded'
            || handledTerminalOperationIdRef.current === operation.operationId
        ) {
            return;
        }
        const requestId = params.requestId;
        const draftScope = params.draftScope;
        const capturedFirstTurnText = readCapturedNewSessionFirstTurnText({
            scope: draftScope,
            draftId: params.draftId,
            launchUserAttemptId: requestId,
        });
        handledTerminalOperationIdRef.current = operation.operationId;
        let cancelled = false;
        let completed = false;

        void (async () => {
            try {
                const settled = await readManualSessionSpawnOperationDetails(draftScope, operation, () => !cancelled);
                if (!settled) return;
                const sessionId = readActionOperationDestinationSessionId(settled);
                if (!sessionId) return;
                const destinationServerId = readActionOperationDestinationServerId(settled, draftScope.serverId)
                    ?? draftScope.serverId;
                const initialInputLocalId = readAcceptedInitialInputLocalId(readActionOperationSessionSpawnNewInitialInput(settled));
                completed = await settleCreatedNewSessionLaunch({
                    sessionId,
                    destinationServerId,
                    draftScope,
                    draftId: params.draftId,
                    requestId,
                    initialInputLocalId,
                    capturedFirstTurnText,
                    router: params.router,
                    isStillActive: () => !cancelled,
                    operation: qualifyActionOperationSnapshot(draftScope.serverId, settled),
                    disableDraftPersistence: params.disableDraftPersistence,
                });
            } catch (error) {
                handledTerminalOperationIdRef.current = null;
                captureExceptionIfEnabled(error, {
                    tags: {
                        area: 'new_session',
                        action: 'reconcile_action_operation_success',
                    },
                    extra: {
                        operationId: operation.operationId,
                        sessionId: readActionOperationDestinationSessionId(operation),
                    },
                });
            }
        })();

        return () => {
            cancelled = true;
            if (!completed && handledTerminalOperationIdRef.current === operation.operationId) {
                handledTerminalOperationIdRef.current = null;
            }
        };
    }, [
        operation,
        params.disableDraftPersistence,
        params.draftId,
        params.draftScope,
        params.localCreationInFlight,
        params.router,
    ]);

    // Retain the originating creation owner's continuation. Its result resumes that same
    // attachment/first-turn completion; this projection only observes the approval and shows it.
    const appRouter = useRouter();
    const approval = useActionApprovalContinuation({
        scopeKey: `new-session-launch:${params.draftScope?.serverId ?? ''}:${params.draftScope?.accountId ?? ''}:${params.draftId}`,
        serverId: params.draftScope?.serverId ?? '',
        onExecuted: noop,
    });
    const request = approval.requestApproval;
    const pendingServerId = params.draftScope?.serverId ?? null;
    const pendingArtifactId = approval.approvalPending && approval.approvalId && pendingServerId ? approval.approvalId : null;
    const openApproval = React.useCallback(() => {
        if (!pendingArtifactId || !pendingServerId) return;
        appRouter.pushRetainingCurrent(buildApprovalHref(pendingArtifactId, pendingServerId));
    }, [appRouter, pendingArtifactId, pendingServerId]);
    const notice = React.useMemo<NewSessionLaunchApprovalNoticeState | null>(() => (
        pendingArtifactId ? { summary: approval.approvalSummary, onOpen: openApproval } : null
    ), [approval.approvalSummary, openApproval, pendingArtifactId]);
    const launchApproval = React.useMemo<NewSessionLaunchApproval>(() => ({
        pending: pendingArtifactId && pendingServerId ? { artifactId: pendingArtifactId, serverId: pendingServerId } : null,
        notice,
        request,
    }), [notice, pendingArtifactId, pendingServerId, request]);

    return {
        isCreatingFromOperation: (operation?.actionId === 'session.spawn_new'
            && (operation.state === 'accepted' || operation.state === 'running'))
            || pendingArtifactId !== null,
        launchApproval,
    };
}

function noop(): void {}
