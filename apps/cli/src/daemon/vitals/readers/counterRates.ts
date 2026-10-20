export interface CounterReading {
    monotonicMs: number;
    counters: Readonly<Record<string, number>>;
}

export function minimumCounterRateSpanMs(intervalMs: number): number {
    return intervalMs / 2;
}

// Two intervals of the always-on minute cadence (TA-20-6), independent of demand.
const MAX_COUNTER_RATE_SPAN_MS = 120_000;

/** Honest counter deltas over the newest eligible real observation's actual span. */
export function createCounterRateReader() {
    const readings: CounterReading[] = [];
    return (current: CounterReading, intervalMs: number): { elapsedMs: number; deltas: Record<string, number> } | null => {
        const previous = readings.at(-1);
        const keys = Object.keys(current.counters);
        // Check continuity against the latest observation, including short reads:
        // choosing an older baseline must never hide a reset or clock regression.
        if (previous && (current.monotonicMs < previous.monotonicMs
            || keys.length !== Object.keys(previous.counters).length
            || keys.some(key => !Number.isFinite(current.counters[key]) || !Number.isFinite(previous.counters[key])
                || current.counters[key] < previous.counters[key]))) {
            readings.length = 0;
        }
        while (readings.length && current.monotonicMs - readings[0].monotonicMs > MAX_COUNTER_RATE_SPAN_MS) readings.shift();
        let baseline: CounterReading | undefined;
        for (let index = readings.length - 1; index >= 0; index -= 1) {
            const reading = readings[index];
            if (current.monotonicMs - reading.monotonicMs >= minimumCounterRateSpanMs(intervalMs)) {
                baseline = reading;
                break;
            }
        }
        readings.push(current);
        if (!baseline) return null;
        const deltas: Record<string, number> = {};
        for (const key of keys) deltas[key] = current.counters[key] - baseline.counters[key];
        return { elapsedMs: current.monotonicMs - baseline.monotonicMs, deltas };
    };
}
