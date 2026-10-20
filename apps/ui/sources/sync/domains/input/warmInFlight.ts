export type WarmInFlightRequest<Result> = Readonly<{
    promise: Promise<Result>;
    controller: AbortController;
    callers: Set<symbol>;
}>;

export async function warmInFlight<Key, Result>(
    map: Map<Key, WarmInFlightRequest<Result>>,
    key: Key,
    load: (signal: AbortSignal) => Promise<Result>,
    signal?: AbortSignal,
): Promise<Result> {
    signal?.throwIfAborted();
    let request = map.get(key);
    if (!request) {
        const controller = new AbortController();
        const promise = (async () => {
            try {
                return await load(controller.signal);
            } finally {
                if (map.get(key)?.controller === controller) map.delete(key);
            }
        })();
        request = { promise, controller, callers: new Set() };
        map.set(key, request);
    }
    const shared = request;
    const caller = Symbol();
    shared.callers.add(caller);
    return await new Promise<Result>((resolve, reject) => {
        const finish = (apply: () => void) => {
            if (!shared.callers.delete(caller)) return;
            signal?.removeEventListener('abort', abort);
            if (shared.callers.size === 0 && map.get(key) === shared) {
                map.delete(key);
                shared.controller.abort();
            }
            apply();
        };
        const abort = () => finish(() => reject(signal?.reason));
        signal?.addEventListener('abort', abort, { once: true });
        shared.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
}
