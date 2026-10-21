import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';

export type ResumeFailurePresentation = Readonly<
    | { kind: 'alert'; message: string; errorCode?: string }
    | { kind: 'directory_missing' }
>;

export function resolveResumeFailurePresentation(result: Readonly<{
    errorCode?: string | null;
    errorMessage?: string | null;
}>, fallbackMessage: string): ResumeFailurePresentation {
    const errorCode = typeof result.errorCode === 'string' ? result.errorCode.trim() : '';
    if (errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_DIRECTORY_MISSING) {
        return { kind: 'directory_missing' };
    }
    if (errorCode === SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED) {
        return { kind: 'alert', message: fallbackMessage, errorCode };
    }
    const message = typeof result.errorMessage === 'string' ? result.errorMessage.trim() : '';
    return { kind: 'alert', message: message || fallbackMessage, ...(errorCode ? { errorCode } : {}) };
}
