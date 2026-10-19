import * as React from 'react';
import { Animated, Easing, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_DATA_METRICS, HAPPIER_MOTION_V1 } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { t } from '@/text';

import {
  resolveMachineResourceToneColor,
  type MachineResourceTone,
} from './machineSummaryStripModel';

export type MachinePressureLevel = 'calm' | 'elevated' | 'critical';

const LIT_PIPS: Readonly<Record<MachinePressureLevel, number>> = {
  calm: 1,
  elevated: 2,
  critical: 3,
};

/**
 * The one memory-pressure indicator (plan 20 §6.7, lab kit `pressure`): three pips and the word. Pressure
 * is a word, never only a colour; the pips light one, two or three steps. `small` sits beside a label
 * (calm), `large` takes a value's place when memory needs a look. The tone is the machine's published
 * attention, passed in; the level word is the reading.
 */
export const MachinePressureIndicator = React.memo(
  function MachinePressureIndicator(
    props: Readonly<{
      level: MachinePressureLevel;
      tone: MachineResourceTone;
      size: 'small' | 'large';
      /** Where the reading came from, for hover and assistive technology ("Pressure reported by macOS"). */
      source?: string | null;
      /** Quiet words after the level ("for 6 min"). */
      detail?: string | null;
      testID?: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    const ink =
      props.tone === 'calm'
        ? theme.colors.text.tertiary
        : resolveMachineResourceToneColor(props.tone, theme.colors);
    const word = t(LEVEL_KEYS[props.level]);
    const label = [
      t('machineVitals.memory.pressureLabel', { level: word }),
      props.detail,
      props.source,
    ]
      .filter(Boolean)
      .join(', ');
    const lit = LIT_PIPS[props.level];
    return (
      <View
        testID={props.testID}
        accessible
        accessibilityRole="text"
        accessibilityLabel={label}
        style={[styles.row, props.size === 'large' ? styles.rowLarge : null]}
      >
        <View
          style={styles.pips}
          aria-hidden
          importantForAccessibility="no-hide-descendants"
        >
          {[0, 1, 2].map((index) => (
            <Pip key={index} color={index < lit ? ink : theme.colors.border.default} />
          ))}
        </View>
        <Text
          numberOfLines={1}
          style={[
            props.size === 'large' ? styles.wordLarge : styles.wordSmall,
            {
              color:
                props.tone === 'calm'
                  ? props.size === 'large'
                    ? theme.colors.text.primary
                    : theme.colors.text.secondary
                  : ink,
            },
          ]}
        >
          {word}
        </Text>
        {props.detail ? (
          <Text numberOfLines={1} style={styles.detail}>
            {props.detail}
          </Text>
        ) : null}
      </View>
    );
  },
);

const LEVEL_KEYS = {
  calm: 'machineVitals.memory.levels.calm',
  elevated: 'machineVitals.memory.levels.elevated',
  critical: 'machineVitals.memory.levels.critical',
} as const satisfies Record<MachinePressureLevel, string>;

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    minWidth: 0,
  },
  rowLarge: {
    gap: theme.space.s10,
    alignItems: 'baseline',
  },
  pips: {
    flexDirection: 'row',
    gap: theme.space.s2,
    alignSelf: 'center',
  },
  pip: {
    width: 9,
    height: 4,
    borderRadius: 2,
  },
  wordSmall: {
    ...Typography.variant('meta'),
    ...Typography.default('medium'),
  },
  wordLarge: {
    ...Typography.default('semiBold'),
    fontSize: HAPPIER_DATA_METRICS.statValue.fontSize,
    lineHeight: HAPPIER_DATA_METRICS.statValue.lineHeight,
    letterSpacing: HAPPIER_DATA_METRICS.statValue.letterSpacing,
  },
  detail: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));

/**
 * One pip: crossing into a tone cross-fades its colour on the slow step together with the meter (lab `rv` AL
 * "Crossing into amber"); nothing pulses. Reduced motion changes it at once.
 */
function Pip(props: Readonly<{ color: string }>) {
  const reducedMotion = useReducedMotionPreference();
  const progress = React.useRef(new Animated.Value(1)).current;
  const pair = React.useRef({ from: props.color, to: props.color });
  if (pair.current.to !== props.color) {
    pair.current = { from: pair.current.to, to: props.color };
  }
  const { from, to } = pair.current;
  React.useEffect(() => {
    if (reducedMotion || from === to) { progress.setValue(1); return; }
    // Animated.View is already subscribed: reset only after this render commits.
    progress.setValue(0);
    const animation = Animated.timing(progress, { toValue: 1, duration: motionTokens.durationMs.slow,
      easing: Easing.bezier(...HAPPIER_MOTION_V1.standardBezier), useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [from, to, progress, reducedMotion]);
  const backgroundColor = React.useMemo(() => (from === to ? to : progress.interpolate({ inputRange: [0, 1], outputRange: [from, to] })), [from, progress, to]);
  return <Animated.View style={[styles.pip, { backgroundColor }]} />;
}

