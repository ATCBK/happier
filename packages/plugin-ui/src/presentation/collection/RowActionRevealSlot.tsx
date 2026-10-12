import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Animated, Easing, Platform, View, type ViewStyle } from 'react-native';

import { useOptionalHappierUiAccessibility } from '../../environment/context.js';
import { HAPPIER_MOTION_V1 } from '../interaction/motion.js';
import type { HappierStyleProp } from '../portableTypes.js';

export type HappierRowActionRevealSlotProps = Readonly<{
  revealed: boolean;
  reserveWidth?: number;
  style?: HappierStyleProp;
  /** Notified when descendant focus enters/leaves, for hosts that mirror it. */
  onFocus?: () => void;
  onBlur?: () => void;
  /**
   * Reads the reduced-motion preference at the instant a reveal starts. A host with a shared preference
   * watch passes its non-subscribing read; without it the environment's resolved preference is used.
   */
  readReducedMotion?: () => boolean;
  testID?: string;
  children: ReactNode;
}>;

/**
 * The one reveal mechanism for a row's quiet actions (a message's pin/copy/fork, a tool row's pin, a
 * Projects row's menu, a public List row's overflow).
 *
 * Contract:
 * - the slot reserves its footprint, so revealing never shifts the row;
 * - only opacity animates, so a reveal can never move the content around it;
 * - a hidden slot is not clickable (`pointerEvents: none`), so it never swallows text selection or
 *   clicks in the corner it occupies;
 * - hidden actions stay in the accessibility tree and stay focusable, and the SLOT reveals itself on
 *   descendant focus, so no host can leave invisible-but-activatable actions behind. `onFocus`/`onBlur`
 *   only notify hosts that mirror the focus into their own hover state.
 */
export function HappierRowActionRevealSlot(props: HappierRowActionRevealSlotProps): ReactElement {
  // Platform.OS is fixed for the runtime: one implementation for the app's lifetime.
  return Platform.OS === 'web' ? <AnimatedRevealSlot {...props} /> : <StaticRevealSlot {...props} />;
}

function useRevealFocus(props: HappierRowActionRevealSlotProps) {
  const [focusWithin, setFocusWithin] = useState(false);
  return {
    revealed: props.revealed || focusWithin,
    onFocus: () => {
      setFocusWithin(true);
      props.onFocus?.();
    },
    onBlur: () => {
      setFocusWithin(false);
      props.onBlur?.();
    },
  };
}

const slotStyle: ViewStyle = { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' };

/**
 * Off web there is no hover, so the slot is a plain container: no animated value, no timing. Multiplied
 * by every row of a virtualized list, that machinery is pure overhead.
 */
function StaticRevealSlot(props: HappierRowActionRevealSlotProps): ReactElement {
  const { revealed, onFocus, onBlur } = useRevealFocus(props);
  return (
    <View
      testID={props.testID}
      onFocus={onFocus}
      onBlur={onBlur}
      pointerEvents={revealed ? 'auto' : 'none'}
      style={[slotStyle, props.reserveWidth != null ? { width: props.reserveWidth } : null, props.style, { opacity: revealed ? 1 : 0 }]}
    >
      {props.children}
    </View>
  );
}

const STANDARD_EASING = Easing.bezier(...HAPPIER_MOTION_V1.standardBezier);

/**
 * Web-only fade. A virtualized list mounts these slots by the hundred while scrolling, so a slot animates
 * nothing until an actual reveal happens. The `Animated.View` stays at rest too: swapping it for a plain
 * `View` would change the element type and remount the actions, dropping focus and pressed state.
 */
function AnimatedRevealSlot(props: HappierRowActionRevealSlotProps): ReactElement {
  const { revealed, onFocus, onBlur } = useRevealFocus(props);
  const environmentReducedMotion = useOptionalHappierUiAccessibility()?.reducedMotion === true;
  const readReducedMotion = props.readReducedMotion ?? (() => environmentReducedMotion);
  const readReducedMotionRef = useRef(readReducedMotion);
  readReducedMotionRef.current = readReducedMotion;
  const target = revealed ? 1 : 0;
  const opacityRef = useRef<Animated.Value | null>(null);
  if (opacityRef.current == null) opacityRef.current = new Animated.Value(target);
  const opacity = opacityRef.current;
  // The mounted value IS the mounted target: only a later reveal or hide is a transition.
  const settledTargetRef = useRef(target);

  useEffect(() => {
    if (settledTargetRef.current === target) return;
    settledTargetRef.current = target;
    if (readReducedMotionRef.current()) {
      opacity.setValue(target);
      return;
    }
    const animation = Animated.timing(opacity, {
      toValue: target,
      duration: HAPPIER_MOTION_V1.fastMs,
      easing: STANDARD_EASING,
      useNativeDriver: false,
    });
    // Settle on the exact target, so an interrupted reveal never leaves a half-faded action behind.
    animation.start((result?: { finished?: boolean }) => {
      if (result?.finished !== false) opacity.setValue(target);
    });
    return () => {
      animation.stop();
    };
  }, [opacity, target]);

  return (
    <Animated.View
      testID={props.testID}
      onFocus={onFocus}
      onBlur={onBlur}
      style={[
        slotStyle,
        props.reserveWidth != null ? { width: props.reserveWidth } : null,
        props.style,
        { pointerEvents: revealed ? ('auto' as const) : ('none' as const) },
        { opacity },
      ]}
    >
      {props.children}
    </Animated.View>
  );
}
