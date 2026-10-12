import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/**
 * Stop-and-ease (plan 30 §10.3, lab `rp` K / KF): the lab's stated timings. No motion token has these
 * values (`fast` 140, `base` 220), so they live here, once. The meter's own 600 ms ease and 320 ms tone
 * cross-fade are `CapacityBar animated`'s.
 */
export const PROCESSES_MOTION = Object.freeze({
  /** 0–160 ms: the row lets go. */
  rowFadeMs: 160,
  /** 160–400 ms: the list closes over it; rows below rise together. */
  rowCloseMs: 240,
  /** Cleanup: rows collapse one after another. */
  cleanupStaggerMs: 60,
});

export const PROCESS_ROW_EXIT_MS =
  PROCESSES_MOTION.rowFadeMs + PROCESSES_MOTION.rowCloseMs;

const strongEaseOut = Easing.bezier(0.23, 1, 0.32, 1);

/**
 * A row leaving the tree: it fades, then its height closes so the rows below rise as one. Interruptible —
 * a row that comes back (the stop failed) returns along the same path. Reduced motion: no movement.
 */
export const ProcessRowPresence = React.memo(function ProcessRowPresence(
  props: Readonly<{ leaving: boolean; children: React.ReactNode }>,
) {
  const reducedMotion = useReducedMotionPreference();
  const opacity = useSharedValue(1);
  const height = useSharedValue<number | null>(null);
  const measured = React.useRef<number | null>(null);
  const onLayout = React.useCallback(
    (event: LayoutChangeEvent) => {
      if (!props.leaving) measured.current = event.nativeEvent.layout.height;
    },
    [props.leaving],
  );
  React.useEffect(() => {
    if (reducedMotion) {
      opacity.value = 1;
      height.value = null;
      return;
    }
    const full = measured.current;
    if (props.leaving) {
      opacity.value = withTiming(0, {
        duration: PROCESSES_MOTION.rowFadeMs,
        easing: reanimatedMotionTokens.easing.exit,
      });
      if (full !== null) {
        height.value = full;
        height.value = withDelay(
          PROCESSES_MOTION.rowFadeMs,
          withTiming(0, {
            duration: PROCESSES_MOTION.rowCloseMs,
            easing: reanimatedMotionTokens.easing.standard,
          }),
        );
      }
    } else if (opacity.value < 1 || height.value !== null) {
      // Back the way it left: height first, then the row.
      if (full !== null && height.value !== null) {
        height.value = withTiming(
          full,
          { duration: PROCESSES_MOTION.rowCloseMs, easing: strongEaseOut },
          (done) => {
            if (done) height.value = null;
          },
        );
      }
      opacity.value = withDelay(
        PROCESSES_MOTION.rowCloseMs,
        withTiming(1, { duration: PROCESSES_MOTION.rowFadeMs }),
      );
    }
  }, [height, opacity, props.leaving, reducedMotion]);
  const style = useAnimatedStyle(() =>
    height.value === null
      ? { opacity: opacity.value }
      : { opacity: opacity.value, height: height.value, overflow: 'hidden' },
  );
  return (
    <Animated.View
      style={style}
      pointerEvents={props.leaving ? 'none' : 'auto'}
    >
      <View onLayout={onLayout}>{props.children}</View>
    </Animated.View>
  );
});
