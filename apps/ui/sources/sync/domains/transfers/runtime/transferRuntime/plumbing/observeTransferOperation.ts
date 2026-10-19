/** Stops observing transfer work without cancelling its separately owned effect or cleanup. */
export async function observeTransferOperation<T>(operation: Promise<T>, signal?: AbortSignal | null): Promise<T> {
    if (!signal) return await operation;
    return await new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(Object.assign(new Error('Transfer observation canceled'), {
                name: 'AbortError', code: 'TRANSFER_OBSERVATION_ABORTED',
            }));
        };
        // Both outcomes remain observed after cancellation, including a late
        // rejection. Cancellation is never reported as a successful effect.
        void operation.then(value => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, error => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
}
