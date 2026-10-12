import * as React from 'react';
import {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { PLANET_MOMENT_TIMINGS } from '@happier-dev/brand/planet';

import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';

/** Loading's cover fade (plan R-11): Home is usable at once and the page lifts in 0.14 s, light or reduced motion. */
const COVER_FADE_MS = PLANET_MOMENT_TIMINGS.L4.FADE * 1000;

/**
 * The departing first-run setup frame's fade, played once over the shell that has just been released.
 *
 * Lane 03 releases the shell the moment Home readiness is derived; without this the frame was
 * replaced in a single commit — a hard cut out of the surface the user was reading. It is the Loading
 * moment's cover: the frame's page and its copy lift together over the brand's cover fade (a
 * smoothstep over 0.14 s), while the Loading planet, drawn between them, resolves and travels on.
 * Under reduced motion the same fade is the 140 ms cross-fade. `onSettled` fires when it lands.
 *
 * The returned style is shared by the frame's layers so they lift as one.
 */
export function usePersonalHomeSetupReveal(
  departing: boolean,
  onSettled: () => void,
) {
  const progress = useSharedValue(0);
  const onSettledRef = React.useRef(onSettled);
  onSettledRef.current = onSettled;

  React.useEffect(() => {
    if (!departing) {
      cancelAnimation(progress);
      progress.value = 0;
      return;
    }
    const settle = () => onSettledRef.current();
    progress.value = withTiming(
      1,
      { duration: COVER_FADE_MS, easing: reanimatedMotionTokens.easing.linear },
      (finished) => {
        'worklet';
        if (finished) runOnJS(settle)();
      },
    );
    return () => {
      cancelAnimation(progress);
    };
  }, [departing, progress]);

  return useAnimatedStyle(() => {
    const t = Math.min(1, Math.max(0, progress.value));
    return { opacity: 1 - t * t * (3 - 2 * t) };
  });
}
