import { orderedFadeMask } from './orderedFadeMask';

/** The web send's existing static mask and whole-lattice travel, shared with native. */
export function orderedDissolve(height: number, dpr: number) {
    const window = Math.round(height * 0.42);
    const mask = orderedFadeMask(2 * height + window, height, height + window, dpr);
    const travel = Math.ceil((height + window) / mask.period) * mask.period;
    return { mask, travel, steps: Math.round(travel / mask.period), from: height, to: height + window };
}
