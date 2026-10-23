/** Wait for a real observable publication; the enclosing test owns its deadline. */
export function waitForTestEvent(
    subscribe: (notify: () => void) => () => void,
    assertion: () => void,
): Promise<void>;
export function waitForTestEvent<T>(
    subscribe: (notify: () => void) => () => void,
    read: () => T,
    predicate: (value: T) => boolean,
): Promise<T>;
export function waitForTestEvent<T>(
    subscribe: (notify: () => void) => () => void,
    read: () => T,
    predicate?: (value: T) => boolean,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let unsubscribe: (() => void) | undefined;
        let settled = false;
        const inspect = () => {
            if (settled) return;
            try {
                const value = read();
                if (predicate && !predicate(value)) return;
                settled = true;
                unsubscribe?.();
                resolve(value);
            } catch (error) {
                // Assertion form retains the caller's exact contract. Only an
                // unmet assertion waits for another event; programmer errors fail.
                if (!predicate && error instanceof Error && error.name === 'AssertionError') return;
                settled = true;
                unsubscribe?.();
                reject(error);
            }
        };
        unsubscribe = subscribe(inspect);
        if (settled) unsubscribe();
        else inspect();
    });
}
