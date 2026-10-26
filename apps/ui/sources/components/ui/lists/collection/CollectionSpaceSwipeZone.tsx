import * as React from 'react';
import { View } from 'react-native';
import { usePresentationWindowDimensions } from '@/utils/platform/responsive';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';
import { scheduleOnRN } from 'react-native-worklets';

import { resolveCollectionSpaceSwipeCommit } from './collectionSpaceSwipe';
import { collectionTitleStyles } from './CollectionTitleButton';
import { Text } from '@/components/ui/text/Text';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { hapticsSelection } from '@/components/ui/theme/haptics';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/** Past the first or last space the zone follows with resistance (rubber band). */
const EDGE_RESISTANCE = 0.3;
const ACTIVATION_PX = 12;

/** One finger position shared by a list's swipe zones (title, strip) and the title that tracks it. */
export function useCollectionSpaceSwipeTrack(): SharedValue<number> {
  return useSharedValue(0);
}

/**
 * Phone space paging (lab `clspaces:swipe`) for every saved-space list (Sessions, Workflows, Discussions): a
 * swipe anywhere in the title and strip zone moves the shared track 1:1 (resisting past the first and last
 * space); only the title (`CollectionSpaceSwipeTitle`) follows it, with the neighbouring space's name peeking
 * in, while the strip and the header's buttons stay. On release it commits to the neighbour past 30 % of the
 * width or on a flick, settling with the release velocity. Rows keep their own swipe (Archive); only this zone
 * pages. Reduced motion commits on release without tracking.
 */
export const CollectionSpaceSwipeZone = React.memo(
  function CollectionSpaceSwipeZone(
    props: Readonly<{
      testID: string;
      track: SharedValue<number>;
      enabled: boolean;
      canPrevious: boolean;
      canNext: boolean;
      onCommit: (direction: -1 | 1) => void;
      children: React.ReactNode;
    }>,
  ) {
    const { width } = usePresentationWindowDimensions();
    const reducedMotion = useReducedMotionPreference();
    const translateX = props.track;
    const { canPrevious, canNext, onCommit } = props;
    const commit = React.useCallback(
      (direction: -1 | 1) => {
        void hapticsSelection();
        onCommit(direction);
      },
      [onCommit],
    );
    const gesture = React.useMemo(
      () =>
        Gesture.Pan()
          .enabled(props.enabled)
          .activeOffsetX([-ACTIVATION_PX, ACTIVATION_PX])
          .failOffsetY([-ACTIVATION_PX, ACTIVATION_PX])
          .onUpdate((event) => {
            if (reducedMotion) return;
            const blocked =
              (event.translationX > 0 && !canPrevious) ||
              (event.translationX < 0 && !canNext);
            translateX.value = blocked
              ? event.translationX * EDGE_RESISTANCE
              : event.translationX;
          })
          .onEnd((event) => {
            const direction = resolveCollectionSpaceSwipeCommit({
              translationX: event.translationX,
              velocityX: event.velocityX,
              width,
              canPrevious,
              canNext,
            });
            if (direction !== null) scheduleOnRN(commit, direction);
            translateX.value = withSpring(0, {
              ...reanimatedMotionTokens.spring.travel,
              velocity: event.velocityX,
            });
          }),
      [
        canNext,
        canPrevious,
        commit,
        props.enabled,
        reducedMotion,
        translateX,
        width,
      ],
    );
    return (
      <GestureDetector gesture={gesture}>
        <View testID={props.testID}>{props.children}</View>
      </GestureDetector>
    );
  },
);

/** How far (in px) the finger travels before the neighbour's name is fully in. */
const PEEK_FULL_PX = 96;

/**
 * The list title riding the swipe track (lab `clspaces:swipe`): it follows the finger and dims a little while
 * the neighbouring space's name, in the same title type, peeks in beside it from the side it will come from.
 * The peeks are decoration for the gesture only: hidden from assistive tech and from pointer input.
 */
export const CollectionSpaceSwipeTitle = React.memo(function CollectionSpaceSwipeTitle(
  props: Readonly<{
    track: SharedValue<number>;
    previousLabel: string | null;
    nextLabel: string | null;
    children: React.ReactNode;
  }>,
) {
  const titleStyles = collectionTitleStyles;
  const track = props.track;
  const rideStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: track.value }],
  }));
  const currentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(Math.abs(track.value), [0, PEEK_FULL_PX], [1, 0.45], Extrapolation.CLAMP),
  }));
  const previousStyle = useAnimatedStyle(() => ({
    opacity: interpolate(track.value, [0, PEEK_FULL_PX], [0, 0.6], Extrapolation.CLAMP),
  }));
  const nextStyle = useAnimatedStyle(() => ({
    opacity: interpolate(-track.value, [0, PEEK_FULL_PX], [0, 0.6], Extrapolation.CLAMP),
  }));
  const peek = (label: string | null, side: 'previous' | 'next', style: typeof nextStyle) => label ? (
    <Animated.View
      pointerEvents="none"
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.peek, side === 'previous' ? styles.previous : styles.next, style]}
    >
      <Text numberOfLines={1} style={[titleStyles.triggerLabel, titleStyles.phoneTriggerLabel]}>{label}</Text>
    </Animated.View>
  ) : null;
  return (
    <Animated.View style={[styles.ride, rideStyle]}>
      {peek(props.previousLabel, 'previous', previousStyle)}
      <Animated.View style={[styles.current, currentStyle]}>{props.children}</Animated.View>
      {peek(props.nextLabel, 'next', nextStyle)}
    </Animated.View>
  );
});

const styles = StyleSheet.create((theme) => ({
  ride: { flexShrink: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' },
  current: { flexShrink: 1, minWidth: 0 },
  peek: { position: 'absolute', top: 0, bottom: 0, justifyContent: 'center' },
  previous: { right: '100%', marginRight: theme.space.s16 },
  next: { left: '100%', marginLeft: theme.space.s16 },
}));
