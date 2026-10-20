import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';

const SESSION_ARCHIVE_TIMEOUT_MS = 75_000;

export class SessionArchiveTimeoutError extends Error {
    constructor() {
        super('Session archive timed out');
        this.name = 'SessionArchiveTimeoutError';
    }
}

/** One archive-stage lifetime; Stop completes before this clock starts. */
export async function withSessionArchiveDeadline<T>(
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    const deadline = new AbortController();
    const cancellation = mergeAbortSignals([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(new SessionArchiveTimeoutError()), SESSION_ARCHIVE_TIMEOUT_MS);
    try {
        throwIfAborted(cancellation.signal);
        const result = await run(cancellation.signal);
        throwIfAborted(cancellation.signal);
        return result;
    } catch (error) {
        // Only the owned deadline gets this stable domain result. Account and
        // caller cancellation retain their existing reason and recovery.
        throwIfAborted(cancellation.signal);
        throw error;
    } finally {
        clearTimeout(timer);
        cancellation.dispose();
    }
}
