import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import type { ExternalSessionsRpcErrorCode } from '@happier-dev/protocol/sessions/external/rpcErrorCodes';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { t } from '@/text';

export type ExternalSessionBrowseOperation = 'list' | 'link' | 'delete';

function fallbackMessage(operation: ExternalSessionBrowseOperation): string {
    switch (operation) {
        case 'link':
            return t('externalSessions.browseLinkFailed');
        case 'delete':
            return t('externalSessions.browseDeleteCandidateFailed');
        case 'list':
            return t('externalSessions.browseFailedToLoad');
    }
}

/**
 * The body for a typed External Sessions failure. `retryable: false` is the host's word that repeating
 * the same request will not help, so the copy must not send the person to a Retry that is not offered.
 */
export function resolveExternalSessionBrowseRpcErrorMessage(
    errorCode: ExternalSessionsRpcErrorCode,
    operation: ExternalSessionBrowseOperation,
    options?: Readonly<{ retryable?: boolean }>,
): string {
    const agentFailed = () => t(options?.retryable === false
        ? 'externalSessions.browseAgentFailedNoRetry'
        : 'externalSessions.browseAgentFailed');
    switch (errorCode) {
        case 'machine_offline':
            return t('newSession.machineOfflineInlineBody');
        case 'agent_unavailable':
            return t('externalSessions.browseAgentUnavailable');
        case 'agent_timeout':
            return t('externalSessions.browseAgentTimedOut');
        case 'agent_error':
            return agentFailed();
        case 'internal_error':
            // A host fault while reading an Agent's sessions has the same next step as the Agent's own fault.
            return operation === 'list' ? agentFailed() : fallbackMessage(operation);
        case 'invalid_request':
            return operation === 'list' ? t('externalSessions.browseSourceInvalid') : fallbackMessage(operation);
    }
}

export function resolveExternalSessionBrowseThrownErrorMessage(
    error: unknown,
    operation: ExternalSessionBrowseOperation,
): string {
    const rpcErrorCode = readRpcErrorCode(error);
    const transportCode = error && typeof error === 'object'
        ? (error as { code?: unknown }).code
        : null;
    if (transportCode === 'MACHINE_RPC_TIMEOUT') {
        return resolveExternalSessionBrowseRpcErrorMessage('agent_timeout', operation);
    }
    if (
        rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        || rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND
        || transportCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        || transportCode === RPC_ERROR_CODES.METHOD_NOT_FOUND
    ) {
        return t('newSession.daemonRpcUnavailableBody');
    }
    return resolveExternalSessionBrowseRpcErrorMessage('internal_error', operation, { retryable: true });
}
