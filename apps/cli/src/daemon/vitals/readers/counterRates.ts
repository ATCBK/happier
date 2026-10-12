export interface CounterReading {
    monotonicMs: number;
    counters: Readonly<Record<string, number>>;
}

/** One cadence-relative baseline rule for CPU, swap, events and network. */
export function createCounterRateReader() {
    let previous: CounterReading | undefined;
    return (current: CounterReading, intervalMs: number): { elapsedMs: number; deltas: Record<string, number> } | null => {
        const baseline = previous;
        const elapsedMs = baseline ? current.monotonicMs - baseline.monotonicMs : 0;
        if (baseline && elapsedMs >= 0 && elapsedMs < intervalMs / 2) return null;
        previous = current;
        if (!baseline || elapsedMs <= 0 || elapsedMs > intervalMs * 2) return null;
        const keys = Object.keys(current.counters);
        if (keys.length !== Object.keys(baseline.counters).length) return null;
        const deltas: Record<string, number> = {};
        for (const key of keys) {
            const value = current.counters[key];
            const old = baseline.counters[key];
            if (old === undefined || !Number.isFinite(value) || !Number.isFinite(old) || value < old) return null;
            deltas[key] = value - old;
        }
        return { elapsedMs, deltas };
    };
}
