import { FURTHER_PLANET_MOMENT_TIMINGS } from '@happier-dev/brand/planet-moments';
import { motionTokens } from '@/components/ui/motion/motionTokens';

export type BackdropSettle = Readonly<{ kind: 'resettle' | 'crossfade'; durationMs: number; id: number }>;
type Frame = Readonly<{ localId: string | null; w: number; h: number }>;

/**
 * Whether a canvas's next render settles into place rather than replacing the frame it shows: only
 * for the picture the idle resettle announced (once per canvas), from a different picture at the same
 * size. The settle is the brand's blue-noise resettle (1.8 s); reduced motion cross-fades in the shared
 * reduced time. Anything else swaps as it always has.
 */
export function backdropSettle(input: Readonly<{
    enabled?: boolean;
    fact: Readonly<{ id: number; localId: string; reducedMotion: boolean }> | null;
    /** The last announcement this canvas played. */
    settled: number | null;
    shown: Frame | null;
    next: Frame;
}>): BackdropSettle | null {
    const { fact, shown, next } = input;
    if (input.enabled === false) return null;
    if (!fact || fact.id === input.settled || next.localId !== fact.localId) return null;
    if (!shown || shown.localId === next.localId || shown.w !== next.w || shown.h !== next.h) return null;
    return fact.reducedMotion
        ? { kind: 'crossfade', durationMs: motionTokens.atmosphere.reducedCrossFadeMs, id: fact.id }
        : { kind: 'resettle', durationMs: FURTHER_PLANET_MOMENT_TIMINGS.RESETTLE.DUR * 1000, id: fact.id };
}
