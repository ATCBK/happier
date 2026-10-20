export type TurnEndpointPolicy = Readonly<{
    silenceMs: number;
    minSpeechMs: number;
}>;

function clampBoundedMs(value: unknown): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
    return Math.max(0, Math.min(5_000, n));
}

export function normalizeTurnEndpointPolicy(raw: {
    silenceMs?: unknown;
    minSpeechMs?: unknown;
}): TurnEndpointPolicy {
    return {
        silenceMs: clampBoundedMs(raw.silenceMs),
        minSpeechMs: clampBoundedMs(raw.minSpeechMs),
    };
}

export function computeTurnEndpointDelayMs(policy: TurnEndpointPolicy, speechElapsedMs: number): number {
    const elapsed = Math.max(0, Number.isFinite(speechElapsedMs) ? speechElapsedMs : 0);
    return Math.max(policy.silenceMs, policy.minSpeechMs - elapsed, 0);
}

/**
 * Schedules the hands-free end-of-turn once the recognizer reports end of speech. Returns a cancel
 * function; the callback never fires after cancellation.
 */
export function scheduleTurnEndpoint(params: {
    policy: TurnEndpointPolicy;
    speechElapsedMs: number;
    onEndpoint: () => void;
}): () => void {
    let cancelled = false;
    const fire = () => {
        if (cancelled) return;
        cancelled = true;
        params.onEndpoint();
    };
    const waitMs = computeTurnEndpointDelayMs(params.policy, params.speechElapsedMs);
    if (waitMs <= 0) {
        queueMicrotask(fire);
        return () => {
            cancelled = true;
        };
    }
    const timer = setTimeout(fire, waitMs);
    return () => {
        cancelled = true;
        clearTimeout(timer);
    };
}
