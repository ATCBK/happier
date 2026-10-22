import { vi } from 'vitest';

type TimerRecord = Readonly<{ kind: 'timeout' | 'interval'; delayMs: number; consumer: string | null }>;

/** Install after fake timers and before mounting the surface. Unknown callers remain visible. */
export function installTimerCensus(identify: (stack: string) => string | null = () => null) {
    const timers = new Map<unknown, TimerRecord>();
    const originalTimeout = globalThis.setTimeout;
    const originalInterval = globalThis.setInterval;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalClearInterval = globalThis.clearInterval;
    const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
        const handle = originalTimeout(function (this: unknown) {
            timers.delete(handle);
            callback.apply(this, args);
        }, delay);
        timers.set(handle, { kind: 'timeout', delayMs: delay ?? 0, consumer: identify(new Error().stack ?? '') });
        return handle;
    });
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
        const handle = originalInterval(callback, delay, ...args);
        timers.set(handle, { kind: 'interval', delayMs: delay ?? 0, consumer: identify(new Error().stack ?? '') });
        return handle;
    });
    const clearTimeout = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(handle => {
        timers.delete(handle);
        originalClearTimeout(handle);
    });
    const clearInterval = vi.spyOn(globalThis, 'clearInterval').mockImplementation(handle => {
        timers.delete(handle);
        originalClearInterval(handle);
    });
    return {
        read: (): readonly TimerRecord[] => [...timers.values()].map(timer => ({ ...timer })),
        stop: () => {
            timeout.mockRestore(); interval.mockRestore(); clearTimeout.mockRestore(); clearInterval.mockRestore();
            timers.clear();
        },
    };
}
