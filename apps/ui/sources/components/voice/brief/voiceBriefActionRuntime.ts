import { getVoiceSessionPresentedAttemptId } from '@/voice/session/voiceSessionStore';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';

export type VoiceBriefOperation = 'request' | 'retry' | 'stop' | 'close';
export type VoiceBriefOperationInput = Readonly<{ expectedAttemptId?: string }>;
export type VoiceBriefOperationOutcome =
    | Readonly<{ ok: true; result: Readonly<{ status: 'waiting' | 'sent' | 'refused' | 'stopped' | 'closed'; attemptId: string | null }> }>
    | Readonly<{ ok: false; errorCode: 'voice_brief_unavailable' | 'stale_voice_attempt' | 'voice_brief_not_retryable' | 'voice_brief_stop_unavailable' }>;

type MountedBriefOperation = (operation: VoiceBriefOperation) => VoiceBriefOperationOutcome;
let mountedBrief: MountedBriefOperation | null = null;
let mountedHomeRequest: (() => VoiceBriefOperationOutcome) | null = null;
let pendingHomeRequest: Readonly<{
    owner: () => VoiceBriefOperationOutcome;
    accountLifetime: ReturnType<typeof captureActiveServerAccountScopeCurrentness>;
    attemptId: string | null;
}> | null = null;

/** The same demand-mounted Brief serves the Home button and Actions in this client/window. */
export function registerVoiceBriefOperations(execute: MountedBriefOperation): () => void {
    mountedBrief = execute;
    return () => { if (mountedBrief === execute) mountedBrief = null; };
}

/** Home supplies only presentation demand; it never builds Inbox context or starts media. */
export function registerVoiceBriefHomeRequest(request: () => VoiceBriefOperationOutcome): () => void {
    mountedHomeRequest = request;
    return () => {
        if (mountedHomeRequest === request) mountedHomeRequest = null;
        if (pendingHomeRequest?.owner === request) pendingHomeRequest = null;
    };
}

/** Continue the admitted Home request after its Inbox owner has demand-mounted, without re-admission. */
export function resumeVoiceBriefHomeRequest(): VoiceBriefOperationOutcome | null {
    if (!pendingHomeRequest || !mountedBrief) return null;
    const request = pendingHomeRequest;
    pendingHomeRequest = null;
    if (request.owner !== mountedHomeRequest || !request.accountLifetime.isCurrent()) {
        return { ok: false, errorCode: 'voice_brief_unavailable' };
    }
    if (request.attemptId !== getVoiceSessionPresentedAttemptId()) return { ok: false, errorCode: 'stale_voice_attempt' };
    return mountedBrief('request');
}

export function voiceBriefOperationResult(status: 'waiting' | 'sent' | 'refused' | 'stopped' | 'closed'): VoiceBriefOperationOutcome {
    return { ok: true, result: { status, attemptId: getVoiceSessionPresentedAttemptId() } };
}

export function executeVoiceBriefOperation(operation: VoiceBriefOperation, input: VoiceBriefOperationInput = {}): VoiceBriefOperationOutcome {
    if (input.expectedAttemptId !== undefined && input.expectedAttemptId !== getVoiceSessionPresentedAttemptId()) {
        return { ok: false, errorCode: 'stale_voice_attempt' };
    }
    if (mountedBrief) return mountedBrief(operation);
    if (operation === 'request' && mountedHomeRequest) {
        const request = { owner: mountedHomeRequest, accountLifetime: captureActiveServerAccountScopeCurrentness(),
            attemptId: getVoiceSessionPresentedAttemptId() };
        pendingHomeRequest = request;
        const outcome = mountedHomeRequest();
        if (!outcome.ok && pendingHomeRequest === request) pendingHomeRequest = null;
        return outcome;
    }
    return { ok: false, errorCode: 'voice_brief_unavailable' };
}
