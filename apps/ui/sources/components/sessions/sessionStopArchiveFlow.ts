import { HappyError } from '@/utils/errors/errors';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import type { SessionStopRecovery } from '@/sync/ops/sessionStopContract';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

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

export function keepSessionVisibleWhenInactive(address: SessionAddress): void {
    const state = storage.getState();
    state.applyServerScopedSessionListRowPatches(address.serverId, [
        {
            sessionId: address.sessionId,
            patch: { keepVisibleWhenInactive: true },
        },
    ]);
}

export function clearSessionVisibleWhenInactive(address: SessionAddress): void {
    const state = storage.getState();
    state.applyServerScopedSessionListRowPatches(address.serverId, [
        {
            sessionId: address.sessionId,
            patch: { keepVisibleWhenInactive: false },
        },
    ]);
}

export async function stopSessionAndMaybeArchive(params: StopSessionAndMaybeArchiveParams): Promise<void> {
    const keepVisibleWhenStopping = params.archiveAfterStop === 'always';

    if (keepVisibleWhenStopping) {
        keepSessionVisibleWhenInactive(params.address);
    }

    const stopResult = await params.stopSession();
    // A preceding Stop may already have retired the runtime while this UI target still looks active.
    // The Home remains authoritative about whether Archive is now allowed.
    const canAttemptArchiveWithoutRuntime = params.archiveAfterStop === 'always'
        && stopResult.code === 'session_stop_not_found';
    if (!stopResult.success && !isAcceptedPendingSessionStop(stopResult) && !canAttemptArchiveWithoutRuntime) {
        if (keepVisibleWhenStopping) {
            clearSessionVisibleWhenInactive(params.address);
        }
        throw new HappyError(resolveSessionStopFailureMessage(stopResult, params.stopErrorMessage), false);
    }

    if (params.archiveAfterStop === 'never') {
        return;
    }

    try {
        const archiveResult = await params.archiveSession();
        if (!archiveResult.success) {
            const message = isSessionActiveArchiveResult(archiveResult)
                ? params.archiveErrorMessage
                : archiveResult.message || params.archiveErrorMessage;
            throw new HappyError(message, false, { code: archiveResult.code });
        }
    } finally {
        if (keepVisibleWhenStopping) {
            clearSessionVisibleWhenInactive(params.address);
        }
    }
}
