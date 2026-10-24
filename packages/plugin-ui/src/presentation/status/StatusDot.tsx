import { useEffect, useRef } from 'react';
import { Animated, Platform, View, type ViewStyle } from 'react-native';
import { Circle, Path, Rect, Svg } from 'react-native-svg';
import type { HappierIconName } from '../content/Icon.js';

import { useHappierUiAnimationActivityInternal, useOptionalHappierUiAccessibility } from '../../environment/context.js';
import type { HappierStyleProp } from '../portableTypes.js';

/**
 * The single implementation owner for Happier's status dot (UI-T27).
 *
 * Extracted from `apps/ui/sources/components/ui/status/StatusDot.tsx` with its
 * measured behaviour intact: a stepped CSS pulse on web, a native
 * `Animated.loop` elsewhere, a static dot when the pulse is switched off, and
 * accessibility identity that either NAMES the status or hides the dot from
 * assistive technology entirely — a colour-only dot with no label is decoration
 * and must not be announced.
 *
 * `reducedMotion` is injected (§3.10.2), and only the pulsing path reads it.
 * Status dots mount by the hundred in virtualized lists, so a preference read
 * on the static path would make every row pay for a value it cannot use.
 */
const WEB_PULSE_TIMING_FUNCTION = 'steps(6, end)';
const DEFAULT_STATUS_DOT_SIZE = 6;

export type HappierStatusDotProps = Readonly<{
  color: string;
  isPulsing?: boolean;
  size?: number;
  style?: HappierStyleProp;
  testID?: string;
  /**
   * The semantic meaning of the colour. Present: the dot is announced as an
   * image with this label. Absent: it is hidden from assistive technology,
   * because an unnamed colour conveys nothing to a screen reader.
   */
  accessibilityLabel?: string;
  /** Keep the pulsing state visible while disabling the animation. */
  animationEnabled?: boolean;
  /**
   * A soft ring behind the dot, in this colour (a themed tint such as the
   * success state's background). The ring is concentric and twice the dot's
   * size; it is drawn under the dot and never intercepts input. This is the one
   * halo composition: services, launchpad and stream dots all draw it here.
   */
  halo?: string;
  /**
   * The resolved reduced-motion preference. When omitted the environment value
   * is used; when there is no environment the dot animates.
   */
  reducedMotion?: boolean;
  /**
   * A work state's glyph (lab `clstatus`): the shape carries the state, never colour alone — a shield with a
   * question for permission, a speech bubble for a question, an alert circle for failure, a stop circle, an
   * offline machine, an hourglass, a check circle for finished-unseen, an @ for a mention, a lock for denied
   * access. `new` keeps the dot (unread). `size` is the glyph box (14 in a list row's status slot); a token
   * without a status shape draws the dot. Working is the host's activity spinner, never a glyph.
   */
  glyph?: HappierIconName;
}>;

/** The status glyph shapes, on a 24 grid at the lab's 1.5 stroke (`clstatus`). */
const STATUS_GLYPH_PATHS: Partial<Record<HappierIconName, readonly string[]>> = Object.freeze({
  review: ['M12 3.5 5 6v5.6c0 4.1 2.9 7.4 7 8.9 4.1-1.5 7-4.8 7-8.9V6l-7-2.5Z', 'M10.1 9.7a2 2 0 0 1 3.8.7c0 1.3-1.9 1.6-1.9 2.9M12 15.9h.01'],
  attention: ['M4.5 5.5h15V16h-8.2l-4.3 3.4V16H4.5z', 'M10.2 9a1.9 1.9 0 0 1 3.6.7c0 1.2-1.8 1.5-1.8 2.6M12 14.3h.01'],
  failure: ['M12 7.6v5M12 16.2h.01'],
  pause: [],
  unavailable: ['M4.5 15V7A1.5 1.5 0 0 1 6 5.5h12A1.5 1.5 0 0 1 19.5 7v8M3 18.5h18', 'm4 3.5 16 16'],
  waiting: ['M7 3.5h10M7 20.5h10', 'M8 3.5c0 4.2 4 5.2 4 8.5s-4 4.3-4 8.5M16 3.5c0 4.2-4 5.2-4 8.5s4 4.3 4 8.5'],
  check: ['m8.6 12.2 2.3 2.3 4.6-4.8'],
  mention: ['M15.5 12v1.3a2.7 2.7 0 0 0 5.4 0V12a8.9 8.9 0 1 0-3.6 7.2'],
  denied: ['M8 10.5V8a4 4 0 0 1 8 0v2.5'],
});
/** Glyphs drawn around a full circle (failure, stop, finished) or with a circle inside (@, lock body). */
const STATUS_GLYPH_RING = new Set<HappierIconName>(['failure', 'pause', 'check']);

function HappierStatusGlyph(props: Readonly<{ glyph: HappierIconName; color: string; size: number }>) {
  const paths = STATUS_GLYPH_PATHS[props.glyph] ?? [];
  const stroke = { stroke: props.color, strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  return (
    <Svg width={props.size} height={props.size} viewBox="0 0 24 24">
      {STATUS_GLYPH_RING.has(props.glyph) ? <Circle cx={12} cy={12} r={8.5} {...stroke} /> : null}
      {props.glyph === 'pause' ? <Rect x={9.3} y={9.3} width={5.4} height={5.4} rx={1} {...stroke} /> : null}
      {props.glyph === 'mention' ? <Circle cx={12} cy={12} r={3.5} {...stroke} /> : null}
      {props.glyph === 'denied' ? <Rect x={6} y={10.5} width={12} height={9.5} rx={2} {...stroke} /> : null}
      {paths.map((d) => <Path key={d} d={d} {...stroke} />)}
    </Svg>
  );
}

/** Whether the shared status renderer draws this token as a glyph (otherwise it is the dot). */
function hasHappierStatusGlyph(glyph: HappierIconName | undefined): boolean {
  return glyph !== undefined && STATUS_GLYPH_PATHS[glyph] !== undefined;
}

function accessibilityProps(accessibilityLabel: string | undefined) {
  return accessibilityLabel
    ? {
      accessibilityRole: 'image' as const,
      accessibilityLabel,
    }
    : {
      'aria-hidden': true,
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants' as const,
    };
}

function dotStyle(color: string, size: number): ViewStyle {
  return {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: color,
  };
}

export function HappierStatusDot({ halo, glyph, ...props }: HappierStatusDotProps) {
  if (glyph !== undefined && hasHappierStatusGlyph(glyph)) {
    const size = props.size ?? 14;
    return (
      <View
        testID={props.testID}
        {...accessibilityProps(props.accessibilityLabel)}
        style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, props.style]}
      >
        <HappierStatusGlyph glyph={glyph} color={props.color} size={size} />
      </View>
    );
  }
  const dot = !props.isPulsing || props.animationEnabled === false
    ? <StaticStatusDot {...props} />
    : <MotionAwareStatusDot {...props} />;
  if (!halo) return dot;
  return (
    <View
      testID={props.testID ? `${props.testID}-halo` : undefined}
      pointerEvents="none"
      style={haloStyle(props.size ?? DEFAULT_STATUS_DOT_SIZE, halo)}
    >
      {dot}
    </View>
  );
}

function haloStyle(size: number, color: string): ViewStyle {
  const ring = size * 2;
  return {
    width: ring,
    height: ring,
    borderRadius: ring / 2,
    backgroundColor: color,
    alignItems: 'center',
    justifyContent: 'center',
  };
}

function MotionAwareStatusDot(props: HappierStatusDotProps) {
  const environmentAccessibility = useOptionalHappierUiAccessibility();
  const presentationActive = useHappierUiAnimationActivityInternal();
  const reducedMotion = props.reducedMotion ?? environmentAccessibility?.reducedMotion ?? false;

  if (reducedMotion || !presentationActive) {
    return <StaticStatusDot {...props} />;
  }
  if (Platform.OS === 'web') {
    return <WebStatusDot {...props} />;
  }
  return <PulsingStatusDot {...props} />;
}

function StaticStatusDot({
  color,
  size = DEFAULT_STATUS_DOT_SIZE,
  style,
  testID,
  accessibilityLabel,
}: HappierStatusDotProps) {
  return (
    <View
      testID={testID}
      {...accessibilityProps(accessibilityLabel)}
      style={[dotStyle(color, size), style]}
    />
  );
}

function WebStatusDot({
  color,
  isPulsing,
  size = DEFAULT_STATUS_DOT_SIZE,
  style,
  testID,
  animationEnabled = true,
  accessibilityLabel,
}: HappierStatusDotProps) {
  return (
    <View
      testID={testID}
      {...accessibilityProps(accessibilityLabel)}
      style={[
        dotStyle(color, size),
        isPulsing && animationEnabled ? webPulseStyle : null,
        style,
      ]}
    />
  );
}

function PulsingStatusDot({
  color,
  size = DEFAULT_STATUS_DOT_SIZE,
  style,
  testID,
  accessibilityLabel,
}: HappierStatusDotProps) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => {
      animation.stop();
    };
  }, [opacity]);

  return (
    <Animated.View
      testID={testID}
      {...accessibilityProps(accessibilityLabel)}
      style={[
        dotStyle(color, size),
        { opacity },
        style,
      ]}
    />
  );
}

type WebPulseStyle = ViewStyle & {
  animationDirection?: 'alternate';
  animationDuration?: string;
  animationIterationCount?: string;
  animationName?: string;
  animationTimingFunction?: string;
};

const webPulseStyle: WebPulseStyle = {
  animationDirection: 'alternate',
  animationDuration: '1000ms',
  animationIterationCount: 'infinite',
  animationName: 'happierStatusDotPulse',
  animationTimingFunction: WEB_PULSE_TIMING_FUNCTION,
};
