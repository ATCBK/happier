/** Browser Web Locks are absent in jsdom; keep real Home transactions serialized by name. */
export function installBrowserStorageLockBoundary(): () => void {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'locks');
    const tails = new Map<string, Promise<unknown>>();
    const locks = {
        request<T>(name: string, callback: (lock: Readonly<{ name: string; mode: 'exclusive' }>) => T | PromiseLike<T>): Promise<T> {
            const result = (tails.get(name) ?? Promise.resolve()).then(() => callback({ name, mode: 'exclusive' }));
            tails.set(name, result.catch(() => undefined));
            return result;
        },
    };
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
    return () => {
        if (previous) Object.defineProperty(navigator, 'locks', previous);
        else Reflect.deleteProperty(navigator, 'locks');
    };
}
