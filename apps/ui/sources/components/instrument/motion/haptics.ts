import { hapticsMedium, hapticsSelection } from '@/components/ui/theme/haptics';

/** The caller's motion preferences choose when to tick; the adapter owns device output policy. */
export function instrumentSelectionTick(enabled: boolean): void {
    if (enabled) void hapticsSelection();
}

/** A firmer tick when an instrument crosses a meaningful threshold. */
export function instrumentThresholdImpact(enabled: boolean): void {
    if (enabled) void hapticsMedium();
}
