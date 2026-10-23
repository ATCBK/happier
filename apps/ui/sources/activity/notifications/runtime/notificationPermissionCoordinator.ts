import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type NotificationPermissionRequest = ServerAccountScope & Readonly<{
    sessionId: string;
    requestId: string;
    occurrenceId: string;
    action: 'allow' | 'deny';
}>;
export type NotificationPermissionOutcome = Readonly<{
    status: 'not_sent' | 'confirmed' | 'rejected' | 'unconfirmed' | 'ignored' | 'conflict';
}>;

/** Coordinates active callbacks only. The CLI owns permission admission and settlement. */
export function createNotificationPermissionCoordinator() {
    const inFlight = new Map<string, { action: 'allow' | 'deny'; promise: Promise<NotificationPermissionOutcome> }>();

    return function run(
        request: NotificationPermissionRequest,
        send: (onIssued: () => void, signal: AbortSignal) => Promise<unknown>,
        options: Readonly<{ allowExecution?: boolean; signal?: AbortSignal }> = {},
    ): Promise<NotificationPermissionOutcome> {
        const key = JSON.stringify([request.serverId, request.accountId, request.sessionId, request.requestId, request.occurrenceId]);
        const pending = inFlight.get(key);
        if (pending) return pending.action === request.action ? pending.promise : Promise.resolve({ status: 'conflict' });
        // Observing a cached response must never acquire execution ownership.
        if (options.allowExecution === false || options.signal?.aborted) return Promise.resolve({ status: 'not_sent' });

        const promise = (async (): Promise<NotificationPermissionOutcome> => {
            let issued = false;
            let finished = false;
            const lifetime = new AbortController();
            const onAbort = () => lifetime.abort();
            options.signal?.addEventListener('abort', onAbort, { once: true });
            let rejectAborted: (() => void) | undefined;
            const aborted = new Promise<never>((_, reject) => {
                rejectAborted = () => reject(new Error('Notification action ended'));
                lifetime.signal.addEventListener('abort', rejectAborted, { once: true });
            });
            try {
                const result = await Promise.race([send(() => {
                    if (finished || lifetime.signal.aborted) throw new Error('Notification action ended');
                    issued = true;
                }, lifetime.signal), aborted]);
                if (!issued) return { status: 'not_sent' };
                const status = typeof result === 'object' && result !== null && 'ok' in result
                    ? result.ok === true ? 'confirmed' : result.ok === false ? 'rejected' : 'unconfirmed'
                    : 'unconfirmed';
                return { status };
            } catch {
                return { status: issued ? 'unconfirmed' : 'not_sent' };
            } finally {
                finished = true;
                options.signal?.removeEventListener('abort', onAbort);
                if (rejectAborted) lifetime.signal.removeEventListener('abort', rejectAborted);
                lifetime.abort();
            }
        })();
        inFlight.set(key, { action: request.action, promise });
        void promise.finally(() => { if (inFlight.get(key)?.promise === promise) inFlight.delete(key); });
        return promise;
    };
}
