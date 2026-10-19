import { HappyError } from '@/utils/errors/errors';
import { storage } from '@/sync/domains/state/storage';
import { delay } from '@/utils/timing/time';
import { t } from '@/text';
import type { SessionStopRecovery } from '@/sync/ops/sessionStopContract';

type SessionMutationResult = Readonly<{
    success: boolean;
    message?: string;
    code?: string;
    recovery?: SessionStopRecovery;
}>;

export type StopSessionAndMaybeArchiveParams = Readonly<{
    sessionId: string;
    hideInactiveSessions: boolean;
    isPinned: boolean;
    archiveAfterStop: 'never' | 'always';
    stopSession: () => Promise<SessionMutationResult>;
    archiveSession: () => Promise<SessionMutationResult>;
    stopErrorMessage: string;
    archiveErrorMessage: string;
}>;

function readSessionArchiveAfterStopRetryDelayMsFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SESSION_ARCHIVE_AFTER_STOP_RETRY_MS ?? '').trim();
    if (!raw) return 200;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 200;
    return Math.max(0, Math.min(5_000, parsed));
}

function readSessionArchiveAfterStopTimeoutMsFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SESSION_ARCHIVE_AFTER_STOP_TIMEOUT_MS ?? '').trim();
    if (!raw) return 75_000;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 75_000;
    return Math.max(0, Math.min(5 * 60_000, parsed));
}

export function isSessionActiveArchiveResult(result: SessionMutationResult): boolean {
    return result.success === false && result.code === 'session_active';
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

async function archiveAfterStopWithRetry(params: Readonly<{
    archiveSession: () => Promise<SessionMutationResult>;
    archiveErrorMessage: string;
}>): Promise<void> {
    let archiveResult = await params.archiveSession();
    const deadlineMs = Date.now() + readSessionArchiveAfterStopTimeoutMsFromEnv();
    const retryDelayMs = readSessionArchiveAfterStopRetryDelayMsFromEnv();

    while (isSessionActiveArchiveResult(archiveResult) && Date.now() < deadlineMs) {
        await delay(retryDelayMs);
        archiveResult = await params.archiveSession();
    }

    if (!archiveResult.success) {
        const message = isSessionActiveArchiveResult(archiveResult)
            ? params.archiveErrorMessage
            : archiveResult.message || params.archiveErrorMessage;
        throw new HappyError(message, false);
    }
}

export function clearSessionVisibleWhenInactive(sessionId: string): void {
    storage.getState().applySessionListRenderablePatches([
        {
            sessionId,
            patch: { keepVisibleWhenInactive: false },
        },
    ]);
}

/**
 * The single owner of the per-session "archiving" pending state. Every archive entry
 * point (row menu, swipe, header menu, info screen, bulk) commits through this module:
 * a direct archive via `archiveSessionWithPendingState`, a running session via
 * `stopSessionAndMaybeArchive`. The state lives on the session-list renderable so it
 * outlives the menu or sheet that started it; success removes the row through
 * `archivedAt`, failure reverts it here.
 */
function setSessionArchivePending(sessionId: string, pending: boolean, keepVisibleWhenInactive?: boolean): void {
    storage.getState().applySessionListRenderablePatches([
        {
            sessionId,
            patch: keepVisibleWhenInactive === undefined
                ? { archiving: pending }
                : { keepVisibleWhenInactive, archiving: pending },
        },
    ]);
}

export function isSessionArchivePending(sessionId: string): boolean {
    return storage.getState().sessionListRenderables[sessionId]?.archiving === true;
}

export async function archiveSessionWithPendingState<T>(
    sessionId: string,
    archiveSession: () => Promise<T>,
): Promise<T> {
    setSessionArchivePending(sessionId, true);
    try {
        return await archiveSession();
    } finally {
        setSessionArchivePending(sessionId, false);
    }
}

function isStopAcceptedAndPending(result: SessionMutationResult): boolean {
    return result.success === false
        && result.code === 'session_stop_requested'
        && result.recovery === 'wait_for_inactive';
}

/** The runtime is definitively not running the session, so there is nothing left to stop. */
function isStopTargetNotRunning(result: SessionMutationResult): boolean {
    return result.success === false && result.code === 'session_stop_not_found';
}

async function stopSessionOnly(params: StopSessionAndMaybeArchiveParams): Promise<void> {
    const stopResult = await params.stopSession();
    if (stopResult.success || isStopAcceptedAndPending(stopResult)) return;
    throw new HappyError(resolveSessionStopFailureMessage(stopResult, params.stopErrorMessage), false);
}

export async function stopSessionAndMaybeArchive(params: StopSessionAndMaybeArchiveParams): Promise<void> {
    if (params.archiveAfterStop === 'never') {
        await stopSessionOnly(params);
        return;
    }

    // Keep the row visible (it is about to go inactive) and show it archiving until the flow settles.
    setSessionArchivePending(params.sessionId, true, true);
    try {
        const stopResult = await params.stopSession();
        const canArchive = stopResult.success
            || isStopAcceptedAndPending(stopResult)
            || isStopTargetNotRunning(stopResult);
        if (!canArchive) {
            throw new HappyError(resolveSessionStopFailureMessage(stopResult, params.stopErrorMessage), false);
        }
        await archiveAfterStopWithRetry({
            archiveSession: params.archiveSession,
            archiveErrorMessage: params.archiveErrorMessage,
        });
    } finally {
        setSessionArchivePending(params.sessionId, false, false);
    }
}
