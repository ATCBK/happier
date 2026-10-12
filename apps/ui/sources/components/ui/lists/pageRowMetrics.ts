import { isTouchPrimaryPointer as isSharedTouchPrimaryPointer } from '@/components/ui/interactiveTargetSize';

export {
    HAPPIER_PAGE_ROW_TOUCH_MIN_HEIGHT_PX as PAGE_ROW_TOUCH_MIN_HEIGHT_PX,
    resolveHappierPageRowMetrics as resolvePageRowMetrics,
    resolveHappierPageRowDensityInput as resolvePageRowDensityInput,
    type HappierPageRowDensity as PageRowDensity,
    type HappierPageRowShape as PageRowShape,
    type HappierPageRowMetrics as PageRowMetrics,
} from '@happier-dev/plugin-ui/presentation';

/** The app's pointer owner supplies the presentation resolver's touch fact. */
export function isTouchPrimaryPointer(): boolean {
    return isSharedTouchPrimaryPointer();
}
