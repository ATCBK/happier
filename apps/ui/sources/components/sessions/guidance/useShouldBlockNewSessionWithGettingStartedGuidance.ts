import { useHasMachineForGettingStartedGuidance } from './useHasMachineForGettingStartedGuidance';

/**
 * New-session entry shows setup guidance instead of the composer only once it is known that the
 * selected Homes have no machine. Unknown machine lists must not block the composer.
 */
export function useShouldBlockNewSessionWithGettingStartedGuidance(enabled = true): boolean {
    return useHasMachineForGettingStartedGuidance(enabled) === false;
}
