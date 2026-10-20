/**
 * The bound for an author-supplied External Sessions listener.
 *
 * Listener code is trusted but ordinary: it can throw, hang, or never settle.
 * Whichever transport carries the follow, the owner that awaits that callback
 * before acknowledging delivery has to stop waiting at the same ceiling, or a
 * single non-settling callback wedges the lifecycle above it.
 */
export const EXTERNAL_SESSION_FOLLOW_LISTENER_TIMEOUT_MS = 5_000;

/**
 * Awaits one unit of follow listener work under caller/invocation cancellation.
 * Author callbacks also use their ceiling. The host-owned terminal importer
 * passes no timeout: durable Home publication belongs to the containing follow
 * operation, and a slow acknowledgement is not source loss.
 *
 * The abandoned work keeps running inside the author's callback; its eventual
 * settlement is deliberately ignored rather than allowed to advance delivery.
 * `Promise.race` has already subscribed to it, so a late rejection is delivered
 * to this settled race and cannot surface as an unhandled rejection.
 */
export async function settleFollowListenerBounded(
    work: Promise<void>,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
        await Promise.race([
            work,
            ...(timeoutMs === undefined ? [] : [new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(Object.assign(new Error('plugin_external_follow_listener_deadline_exceeded'), {
                        code: 'plugin_external_follow_listener_deadline_exceeded',
                    })),
                    timeoutMs,
                );
                timer.unref?.();
            })]),
            ...(signal
                ? [new Promise<never>((_, reject) => {
                    onAbort = () => reject(new Error('plugin_operation_aborted'));
                    if (signal.aborted) onAbort();
                    else signal.addEventListener('abort', onAbort, { once: true });
                })]
                : []),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
}
