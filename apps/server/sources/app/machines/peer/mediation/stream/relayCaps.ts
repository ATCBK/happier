import { MachineLiveStreamRelayCapsV1Schema, type MachineLiveStreamRelayCaps, type MachineLiveStreamCapsV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';

export function normalizeMachineLiveStreamRelayCaps(raw: unknown): MachineLiveStreamRelayCaps | null {
    const parsed = MachineLiveStreamRelayCapsV1Schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

export function hasMachineLiveStreamRelayCaps(caps: MachineLiveStreamRelayCaps | null | undefined): boolean {
    return normalizeMachineLiveStreamRelayCaps(caps) !== null;
}

/** Explicit Home limits fill omitted viewer ceilings; an absent limit imposes no ceiling. */
export function resolveMachineLiveStreamRelayCaps(input: Readonly<{
    requested: MachineLiveStreamCapsV1;
    serverCaps: MachineLiveStreamRelayCaps;
}>): MachineLiveStreamCapsV1 | null {
    const caps: MachineLiveStreamCapsV1 = {};
    for (const key of ['maxBitrateBps', 'maxFramesPerSecond', 'maxFrameBytes', 'maxDurationMs', 'maxTotalBytes'] as const) {
        const requested = input.requested[key];
        const configured = input.serverCaps[key];
        if (requested !== undefined && configured !== undefined && requested > configured) return null;
        const effective = requested ?? configured;
        if (effective !== undefined) caps[key] = effective;
    }
    return caps;
}
