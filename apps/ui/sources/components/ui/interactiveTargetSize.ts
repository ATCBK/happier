import { Platform } from 'react-native';
import {
    HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE,
    isHappierCoarsePrimaryPointer,
    resolveHappierMinimumInteractiveTargetSize,
} from '@happier-dev/plugin-ui/environment';

/**
 * Whether the primary pointer is a finger: always on native, and on the web when the primary pointer
 * cannot hover (a phone or tablet browser). Controls take the platform touch floor only then; a
 * precise pointer keeps the dense desktop sizes. The web answer is read once: the primary pointer does
 * not change under a running app.
 */
export function isTouchPrimaryPointer(platform: string = Platform.OS): boolean {
    if (platform !== 'web') return true;
    // The shared hit-area owner reads the primary pointer once; core asks the same owner.
    return isHappierCoarsePrimaryPointer();
}

/**
 * The smallest hit region a control may have on this device: the platform touch floor (44, 48 on
 * Android) under a finger, the WCAG 2.2 pointer floor under a precise pointer. It is a hit region,
 * never a drawn size: a control keeps its own visual size and grows only its press frame to this.
 */
export function resolveMinimumInteractiveTargetSize(platform: string = Platform.OS): number {
    return isTouchPrimaryPointer(platform)
        ? resolveHappierMinimumInteractiveTargetSize(platform)
        : HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE;
}

/** The touch floor a control takes on this device, or `null` under a precise pointer. */
export function resolveTouchTargetFloorPx(platform: string = Platform.OS): 44 | 48 | null {
    return isTouchPrimaryPointer(platform) ? resolveHappierMinimumInteractiveTargetSize(platform) : null;
}
