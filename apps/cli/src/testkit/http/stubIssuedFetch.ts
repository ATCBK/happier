import { vi } from 'vitest';
import { createDeferred } from '../async/deferred';

/**
 * Stub the global fetch and report once the expected number of requests were issued.
 *
 * A fake clock must advance only after the transport has issued its request and armed its
 * timers. Awaiting the returned promise orders that deterministically, instead of relying on
 * how many macrotasks the transport's lazy module loads happen to need.
 */
export function stubIssuedFetch<Args extends unknown[]>(
    handler: (...args: Args) => Promise<Response>,
    expectedRequests = 1,
): Promise<void> {
    const issued = createDeferred();
    let count = 0;
    vi.stubGlobal('fetch', (...args: Args): Promise<Response> => {
        count += 1;
        if (count === expectedRequests) issued.resolve();
        return handler(...args);
    });
    return issued.promise;
}
