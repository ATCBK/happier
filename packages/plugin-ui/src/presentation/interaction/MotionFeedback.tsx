import * as React from 'react';
import { Animated, Easing } from 'react-native';

import { useHappierUiAccessibility } from '../../environment/context.js';
import type { HappierStyleProp } from '../portableTypes.js';
import { HAPPIER_MOTION_V1 } from './motion.js';

export type MotionFeedbackProps = Readonly<{
  /** Change only when the operation this feedback acknowledges has completed. Mounting is static. */
  trigger: string | number;
  children: React.ReactNode;
  /** Hide decorative content whose semantic result is already presented elsewhere. */
  decorative?: boolean;
  style?: HappierStyleProp;
  testID?: string;
}>;

/** One restrained acknowledgement of a confirmed result, on the shared motion scale. */
export function HappierMotionFeedback({ trigger, children, decorative, style, testID }: MotionFeedbackProps): React.ReactElement {
  const { reducedMotion } = useHappierUiAccessibility();
  const progress = React.useRef(new Animated.Value(1)).current;
  const previousTrigger = React.useRef(trigger);

  React.useEffect(() => {
    if (trigger === previousTrigger.current || reducedMotion) {
      previousTrigger.current = trigger;
      progress.setValue(1);
      return undefined;
    }
    previousTrigger.current = trigger;
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: HAPPIER_MOTION_V1.slowMs,
      easing: Easing.bezier(...HAPPIER_MOTION_V1.standardBezier),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, reducedMotion, trigger]);

  return <Animated.View aria-hidden={decorative} accessibilityElementsHidden={decorative}
    importantForAccessibility={decorative ? 'no-hide-descendants' : 'auto'} testID={testID} style={[style, {
    opacity: progress,
    transform: [{ scale: progress.interpolate({ inputRange: [0, 0.55, 1], outputRange: [0.82, 1.08, 1] }) }],
  }]}>{children}</Animated.View>;
}
