import { armDeadlineTimer } from '@happier-dev/protocol/common/deadlineTimer';

export type WaitForChangeOutcome = 'changed' | 'deadline' | 'aborted';

/** Wait once; the caller rechecks its authoritative state after an event or deadline slice. */
export async function waitForChangeOrDeadline(input: Readonly<{
    waitForChange(signal: AbortSignal): Promise<void>;
    signal?: AbortSignal;
    remainingMs?: number;
    unref?: true;
}>): Promise<WaitForChangeOutcome> {
    if (input.signal?.aborted) return 'aborted';
    const waiting = new AbortController();
    let cancelDeadline: (() => void) | undefined;
    let onAbort: () => void = () => {};
    const cancelled = new Promise<WaitForChangeOutcome>(resolve => {
        onAbort = () => {
            resolve('aborted');
            waiting.abort(input.signal?.reason);
        };
        input.signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
        // Node timers have a signed 32-bit millisecond boundary. A longer
        // selected interval is rechecked, never shortened into an effect.
        const deadline = new Promise<WaitForChangeOutcome>(resolve => {
            if (input.remainingMs !== undefined) {
                cancelDeadline = armDeadlineTimer(Date.now() + Math.min(input.remainingMs, 2_147_483_647),
                    () => resolve('deadline'), input.unref ? { unref: true } : {});
            }
        });
        // Call synchronously so a subscription is installed before control returns to the caller.
        const changed = input.waitForChange(waiting.signal).then((): WaitForChangeOutcome => 'changed');
        const result = await Promise.race([cancelled, changed, deadline]);
        return input.signal?.aborted ? 'aborted' : result;
    } catch (error) {
        if (input.signal?.aborted) return 'aborted';
        throw error;
    } finally {
        cancelDeadline?.();
        waiting.abort();
        input.signal?.removeEventListener('abort', onAbort);
    }
}
