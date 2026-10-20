import { HappyError } from '@/utils/errors/errors';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import type { SessionStopRecovery } from '@/sync/ops/sessionStopContract';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { readSessionArchivePending } from '@/sync/domains/session/listing/sessionArchiveState';

type SessionMutationResult = Readonly<{
    success: boolean;
    message?: string;
    code?: string;
    recovery?: SessionStopRecovery;
}>;

/** Read the Session stop owner's result from the Action's JSON output. */
export function readSessionStopActionResponse(value: unknown): SessionMutationResult | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !('success' in value) || typeof value.success !== 'boolean') return null;
    const recovery = 'recovery' in value ? value.recovery : undefined;
    return {
        success: value.success,
        ...('message' in value && typeof value.message === 'string' ? { message: value.message } : {}),
        ...('code' in value && typeof value.code === 'string' ? { code: value.code } : {}),
        ...(recovery === 'wait_for_inactive' || recovery === 'retry_when_runtime_available' ? { recovery } : {}),
    };
}

export type StopSessionAndMaybeArchiveParams = Readonly<{
    address: SessionAddress;
    hideInactiveSessions: boolean;
    isPinned: boolean;
    archiveAfterStop: 'never' | 'always';
    stopSession: () => Promise<SessionMutationResult>;
    archiveSession: () => Promise<SessionMutationResult>;
    stopErrorMessage: string;
    archiveErrorMessage: string;
}>;

export function isSessionActiveArchiveResult(result: SessionMutationResult): boolean {
    return result.success === false && result.code === 'session_active';
}

export function isAcceptedPendingSessionStop(result: SessionMutationResult): boolean {
    return (
        result.success === false
        && result.code === 'session_stop_requested'
        && result.recovery === 'wait_for_inactive'
    );
}

export function resolveSessionStopFailureMessage(
    result: SessionMutationResult,
    fallbackMessage: string,
): string {
    if (result.recovery === 'retry_when_runtime_available') {
        return t('sessionInfo.stopSessionControlUnavailable');
    }
    return result.message || fallbackMessage;
}

export function isSessionArchivePending(address: SessionAddress): boolean {
    return readSessionArchivePending(storage.getState(), address);
}

/** Call after confirmation; every archive entry point shares synchronous admission. */
export async function archiveSessionWithPendingState<T>(
    address: SessionAddress,
    archiveSession: () => Promise<T>,
): Promise<T | false> {
    const operation = storage.getState().beginSessionArchive(address);
    if (!operation) return false;
    try {
        return await archiveSession();
    } finally {
        storage.getState().finishSessionArchive(operation);
    }
}

export async function stopSessionAndMaybeArchive(params: StopSessionAndMaybeArchiveParams): Promise<void | false> {
    const run = async () => {
        const stopResult = await params.stopSession();
        // A missing runner permits one authoritative Archive attempt. Accepted
        // Stop or disconnect alone does not establish process termination.
        const canAttemptArchiveWithoutRuntime = params.archiveAfterStop === 'always'
            && stopResult.code === 'session_stop_not_found';
        if (!stopResult.success && !isAcceptedPendingSessionStop(stopResult) && !canAttemptArchiveWithoutRuntime) {
            throw new HappyError(resolveSessionStopFailureMessage(stopResult, params.stopErrorMessage), false);
        }
        if (params.archiveAfterStop === 'never') return;
        const archiveResult = await params.archiveSession();
        if (!archiveResult.success) {
            const message = isSessionActiveArchiveResult(archiveResult)
                ? params.archiveErrorMessage
                : archiveResult.message || params.archiveErrorMessage;
            throw new HappyError(message, false, { code: archiveResult.code });
        }
    };
    return params.archiveAfterStop === 'always'
        ? archiveSessionWithPendingState(params.address, run)
        : run();
}
