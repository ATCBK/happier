import type { NotificationPermissionJournal, NotificationPermissionRequest, NotificationPermissionState } from './notificationPermissionJournal';
import { withTimeout } from '@/utils/timing/time';

export type NotificationPermissionOutcome = Readonly<{
    status: Exclude<NotificationPermissionState, 'issued'> | 'ignored' | 'conflict';
    duplicate?: boolean;
}>;

export function createNotificationPermissionCoordinator(journal: NotificationPermissionJournal) {
    const inFlight = new Map<string, { action: 'allow' | 'deny'; promise: Promise<NotificationPermissionOutcome> }>();

    return function run(
        request: NotificationPermissionRequest,
        send: (onIssued: () => void, signal: AbortSignal) => Promise<unknown>,
        options: Readonly<{ explicitRetry?: boolean; allowExecution?: boolean }> = {},
    ): Promise<NotificationPermissionOutcome> {
        const key = journal.key(request);
        const pending = inFlight.get(key);
        if (pending) return pending.action === request.action
            ? pending.promise
            : Promise.resolve({ status: 'conflict' });

        const promise = (async (): Promise<NotificationPermissionOutcome> => {
            let issued = false;
            let finished = false;
            const lifetime = new AbortController();
            try {
                const previous = journal.read(request);
                if (previous) {
                    if (previous.action !== request.action) return { status: 'conflict' };
                    if (previous.state !== 'not_sent' || !options.explicitRetry) {
                        return { status: previous.state === 'issued' ? 'unconfirmed' : previous.state, duplicate: true };
                    }
                }
                if (options.allowExecution === false) return { status: 'not_sent' };
                journal.ensureCapacity(request);
                const result = await withTimeout(() => send(() => {
                    // Expo SDK 54 RNHeadlessAppLoader uses the app's ReactHost. Both
                    // entry points run in its JS runtime. This synchronous read/write
                    // has no await: persist BEFORE the existing RPC emits. This is not
                    // an inter-process CAS or an exactly-once delivery guarantee.
                    if (finished) throw new Error('Notification action execution ended');
                    const current = journal.read(request);
                    if (current && (current.action !== request.action || current.state !== 'not_sent')) {
                        throw new Error('Notification permission was already issued');
                    }
                    journal.write(request, 'issued');
                    issued = true;
                }, lifetime.signal), 30_000, 'notification permission RPC');
                if (!issued) return { status: 'not_sent' };
                const status = typeof result === 'object' && result !== null && 'ok' in result
                    ? result.ok === true ? 'confirmed' : result.ok === false ? 'rejected' : 'unconfirmed'
                    : 'unconfirmed';
                journal.write(request, status);
                return { status };
            } catch {
                const status = issued ? 'unconfirmed' : 'not_sent';
                // If persistence failed, leave any issued marker intact. A later
                // launch treats it as unconfirmed and cannot blindly replay it.
                try {
                    const current = journal.read(request);
                    if (!current || current.state === 'not_sent' || issued) journal.write(request, status);
                } catch {
                    // Caller reports a generic recovery signal, without sensitive errors.
                }
                return { status };
            } finally {
                // A timed-out async preflight can still resolve later. Its onIssued
                // callback must throw before it can emit after we released ownership.
                finished = true;
                // Disposal must not wait for a stalled crypto/native await to
                // reach the RPC's finally block. Issued work is never replayed.
                lifetime.abort();
            }
        })();
        inFlight.set(key, { action: request.action, promise });
        void promise.finally(() => { if (inFlight.get(key)?.promise === promise) inFlight.delete(key); });
        return promise;
    };
}
