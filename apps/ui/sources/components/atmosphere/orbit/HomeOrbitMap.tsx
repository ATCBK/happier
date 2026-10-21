import * as React from 'react';
import {
  PixelRatio,
  Platform,
  Pressable,
  StyleSheet as RNStyleSheet,
  View,
} from 'react-native';
import Svg, { Circle as SvgCircle, Line as SvgLine, Text as SvgText } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PlanetCanvas } from '@/components/atmosphere/PlanetCanvas';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { placeOrbitMoonLabel, type HomeOrbitScene } from './homeOrbitScene';

// react-native-svg's web WebShape forwards CSS style; its native Circle/Line declarations omit it.
const Circle = SvgCircle as React.ComponentType<React.ComponentProps<typeof SvgCircle> & { style?: React.CSSProperties }>;
const Line = SvgLine as React.ComponentType<React.ComponentProps<typeof SvgLine> & { style?: React.CSSProperties }>;

/** Dots outside a preview fade to this strength; the previewed ones grow (lab L4 "reach map hover"). */
const PREVIEW_FADED_OPACITY = 0.16;
/** Ring marks and tethers outside a preview recede to this strength (lab hm-A "others recede to 22%"). */
const RING_PREVIEW_FADED_OPACITY = 0.22;
/** A mark with no tether (off, or not added yet) stands faded on the ring. */
const RING_UNTETHERED_OPACITY = 0.38;
const PREVIEW_DOT_SCALE = 1.7;
/** A moon's press target: the canonical pointer baseline around a few-px moon. */
const MOON_HIT_PX = 28;

export type HomeOrbitMapProps = Readonly<{
  scene: HomeOrbitScene;
  /** Moon key → machine name, drawn beside each moon. */
  labels?: Readonly<Record<string, string>>;
  /** Preview: dots not in the set fade (a hovered or focused row or card). */
  highlightKeys?: ReadonlySet<string> | null;
  /** A moon press (the machine filter). */
  onBodyPress?: (bodyKey: string) => void;
  /**
   * One-shot travel when a fact changes (Turn on sends skills out): the named dots leave the planet
   * for their orbits one after another, once per `id`; never looping, never on arrival.
   */
  travel?: Readonly<{ id: string; dotKeys: readonly string[] }> | null;
  /** A ring scene's mark, drawn centred on its place (an MCP server's mark, the "+N" count). */
  renderRingMark?: (key: string) => React.ReactNode;
  /** The map is art; the legend and the present sentence carry its facts. */
  accessibilityLabel: string;
  small?: boolean;
  testID?: string;
}>;

/**
 * The Home orbit map: orbits behind, the planet (PlanetCanvas, the brand scene at rest: no
 * re-typing), then the dots and moons in front. Static at rest; a preview fades the dots outside
 * it. Hidden from assistive technology: callers render the same facts as words.
 */
export const HomeOrbitMap = React.memo(function HomeOrbitMap(
  props: HomeOrbitMapProps,
) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const { scene, highlightKeys } = props;
  const ink = theme.colors.text.primary;
  const card = theme.colors.edge.cardFill;
  const amber = workStatusGlyphColor(theme.colors, 'attention');
  // The lab's lattice: at least 3 device px with crisp dots, never a dithered smudge at small sizes.
  const dpr = Math.min(2, PixelRatio.get() || 1);
  const planet = React.useMemo(
    () => ({
      theme: theme.dark ? ('dark' as const) : ('light' as const),
      R: scene.pr,
      cx: scene.canvas.size / 2,
      cy: scene.canvas.size / 2,
      view: { w: scene.canvas.size, h: scene.canvas.size },
      time: 0,
      rate: 0,
      pitch: Math.max(1.5, 3 / dpr),
      dpr,
    }),
    [dpr, scene.canvas.size, scene.pr, theme.dark],
  );
  const f = (value: number) => Number(value.toFixed(1));
  const previewing = highlightKeys != null;
  // Entering a preview takes the fast role; leaving is quicker (popover exit). Reduced motion: none.
  // react-native-svg forwards `style` to the DOM node on web; its CSS transition is not a ViewStyle key.
  const transition: SvgWebStyle =
    Platform.OS === 'web' && !reducedMotion
      ? ({
          transition: `opacity ${previewing ? motionTokens.durationMs.fast : motionTokens.overlay.popover.exitMs}ms ease-out, r ${previewing ? motionTokens.durationMs.fast : motionTokens.overlay.popover.exitMs}ms ease-out`,
        } as SvgWebStyle)
      : undefined;
  // The same fade for the ring's marks, which are views (react-native-web transition style keys).
  const markTransition =
    Platform.OS === 'web' && !reducedMotion
      ? ({
          transitionProperty: 'opacity',
          transitionDuration: `${previewing ? motionTokens.durationMs.fast : motionTokens.overlay.popover.exitMs}ms`,
          transitionTimingFunction: 'ease-out',
        } as object)
      : null;
  const travelStyle = useTravelStyle(props.travel ?? null, scene, reducedMotion);
  const labelStyle = Typography.variant('meta');
  const labelFontSize = labelStyle.fontSize ?? 12;
  const placedLabels = React.useMemo(() => {
    const placed: Record<string, ReturnType<typeof placeOrbitMoonLabel>> = {};
    for (const moon of scene.moons) {
      const label = props.labels?.[moon.key];
      if (label) placed[moon.key] = placeOrbitMoonLabel(moon, label, scene, labelFontSize);
    }
    return placed;
  }, [labelFontSize, props.labels, scene]);
  return (
    <View
      testID={props.testID}
      style={[styles.scene, { width: scene.width, height: scene.height }]}
    >
      <View
        pointerEvents="none"
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={RNStyleSheet.absoluteFill}
      >
        <Svg
          width={scene.width}
          height={scene.height}
          style={RNStyleSheet.absoluteFill}
        >
          {scene.orbits.map((orbit, index) => (
            <Circle
              key={index}
              cx={scene.px}
              cy={scene.py}
              r={orbit.r}
              fill="none"
              stroke={ink}
              strokeOpacity={orbit.off ? 0.15 : 0.26}
              strokeWidth={1.3}
              strokeLinecap="round"
              strokeDasharray={orbit.off ? '0 7' : '0 4.2'}
            />
          ))}
        </Svg>
        <PlanetCanvas
          width={scene.canvas.size}
          height={scene.canvas.size}
          options={planet}
          style={{
            position: 'absolute',
            left: scene.canvas.left,
            top: scene.canvas.top,
          }}
        />
        <Svg
          width={scene.width}
          height={scene.height}
          style={RNStyleSheet.absoluteFill}
        >
          {scene.ring?.marks.map((mark) => {
            if (mark.tether === 'none') return null;
            const lit = !previewing || highlightKeys.has(mark.key);
            const attention = mark.tether === 'attention';
            return (
              <Line
                key={`tether:${mark.key}`}
                x1={f(mark.from.x)}
                y1={f(mark.from.y)}
                x2={f(mark.to.x)}
                y2={f(mark.to.y)}
                stroke={attention ? amber : ink}
                strokeOpacity={attention ? 0.9 : previewing && lit ? 0.8 : 0.34}
                strokeWidth={attention ? 1.4 : 1.2}
                strokeLinecap="round"
                strokeDasharray={mark.tether === 'machine' ? '0 4' : attention ? '4 3.4' : undefined}
                opacity={lit ? 1 : RING_PREVIEW_FADED_OPACITY}
                style={transition}
              />
            );
          })}
          {scene.ring?.marks.map((mark) =>
            mark.tether === 'attention' ? (
              <Circle
                key={`beacon:${mark.key}`}
                cx={f(mark.x + 9)}
                cy={f(mark.y - 9)}
                r={2.6}
                fill={amber}
                opacity={!previewing || highlightKeys.has(mark.key) ? 1 : RING_PREVIEW_FADED_OPACITY}
                style={transition}
              />
            ) : null,
          )}
          {scene.dots.map((dot) => {
            const lit = !previewing || highlightKeys.has(dot.key);
            const grow = previewing && lit ? PREVIEW_DOT_SCALE : 1;
            const opacity = lit ? 1 : PREVIEW_FADED_OPACITY;
            const key = `${dot.bodyKey}:${dot.key}`;
            const style = travelStyle(dot) ?? transition;
            if (dot.tone === 'attention') {
              return (
                <React.Fragment key={key}>
                  <Circle
                    cx={f(dot.x)}
                    cy={f(dot.y)}
                    r={6}
                    fill={amber}
                    fillOpacity={0.22}
                    opacity={opacity}
                    style={style}
                  />
                  <Circle
                    cx={f(dot.x)}
                    cy={f(dot.y)}
                    r={2.7 * grow}
                    fill={amber}
                    opacity={opacity}
                    style={style}
                  />
                </React.Fragment>
              );
            }
            if (dot.tone === 'hollow') {
              return (
                <Circle
                  key={key}
                  cx={f(dot.x)}
                  cy={f(dot.y)}
                  r={1.9 * grow}
                  fill={card}
                  stroke={ink}
                  strokeOpacity={0.5}
                  strokeWidth={0.9}
                  opacity={opacity}
                  style={style}
                />
              );
            }
            return (
              <Circle
                key={key}
                cx={f(dot.x)}
                cy={f(dot.y)}
                r={(dot.tone === 'active' ? 2.2 : 1.9) * grow}
                fill={ink}
                fillOpacity={dot.tone === 'active' ? 0.7 : 0.26}
                opacity={opacity}
                style={style}
              />
            );
          })}
          {scene.moons.map((moon) => (
            <React.Fragment key={moon.key}>
              {moon.off ? (
                <Circle
                  cx={f(moon.x)}
                  cy={f(moon.y)}
                  r={moon.r}
                  fill={card}
                  stroke={ink}
                  strokeOpacity={0.34}
                  strokeWidth={1.1}
                  strokeDasharray="1.4 1.6"
                />
              ) : (
                // The card-coloured ring parts the orbit around the moon; its body is ink over the card.
                <>
                  <Circle
                    cx={f(moon.x)}
                    cy={f(moon.y)}
                    r={moon.r}
                    fill={card}
                    stroke={card}
                    strokeWidth={1.5}
                  />
                  <Circle
                    cx={f(moon.x)}
                    cy={f(moon.y)}
                    r={moon.r}
                    fill={ink}
                    fillOpacity={0.62}
                  />
                </>
              )}
              {placedLabels[moon.key] ? (
                <SvgText
                  x={placedLabels[moon.key]!.x}
                  textAnchor={placedLabels[moon.key]!.textAnchor}
                  y={f(moon.y + 4)}
                  fill={ink}
                  fillOpacity={moon.off ? 0.45 : 0.72}
                  fontFamily={labelStyle.fontFamily as string | undefined}
                  fontSize={labelStyle.fontSize}
                >
                  {placedLabels[moon.key]!.text}
                </SvgText>
              ) : null}
            </React.Fragment>
          ))}
        </Svg>
      </View>
      {scene.ring && props.renderRingMark ? (
        <View
          pointerEvents="none"
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={RNStyleSheet.absoluteFill}
        >
          {scene.ring.marks.map((mark) => {
            const lit = !previewing || highlightKeys.has(mark.key);
            const opacity = !lit
              ? RING_PREVIEW_FADED_OPACITY
              : mark.faded && !(previewing && lit)
                ? RING_UNTETHERED_OPACITY
                : 1;
            const size = scene.ring!.markSize;
            return (
              <View
                key={mark.key}
                style={[
                  styles.ringMark,
                  {
                    left: mark.x - size / 2,
                    top: mark.y - size / 2,
                    width: size,
                    height: size,
                    opacity,
                  },
                  markTransition,
                ]}
              >
                {props.renderRingMark!(mark.key)}
              </View>
            );
          })}
        </View>
      ) : null}
      {props.onBodyPress
        ? scene.moons.map((moon) => (
            <Pressable
              key={moon.key}
              testID={
                props.testID ? `${props.testID}.moon.${moon.key}` : undefined
              }
              accessibilityRole="button"
              accessibilityLabel={props.labels?.[moon.key] ?? moon.key}
              onPress={() => props.onBodyPress?.(moon.key)}
              style={[
                styles.moonHit,
                {
                  left: moon.x - MOON_HIT_PX / 2,
                  top: moon.y - MOON_HIT_PX / 2,
                },
              ]}
            />
          ))
        : null}
    </View>
  );
});

/** A web-only CSS style on an SVG element (transition, transform-box), typed as the element's style prop. */
type SvgWebStyle = React.CSSProperties | undefined;

type TravelPhase = Readonly<{ id: string; at: 'from' | 'go' }> | null;

/**
 * The travel moment on web: each named dot starts at the planet's centre, small and clear, and moves
 * out to its orbit on the travel spring's duration, `successMoment.fillStaggerMs` after the one before
 * (P5 §4.6). Reduced motion keeps the places and cross-fades the dots in instead. The phase ends
 * after the last dot lands, so a later render never replays it.
 */
function useTravelStyle(
  travel: Readonly<{ id: string; dotKeys: readonly string[] }> | null,
  scene: HomeOrbitScene,
  reducedMotion: boolean,
) {
  const [phase, setPhase] = React.useState<TravelPhase>(null);
  const travelId = travel?.id ?? null;
  const count = travel?.dotKeys.length ?? 0;
  React.useLayoutEffect(() => {
    if (Platform.OS !== 'web' || travelId === null || count === 0) return;
    setPhase({ id: travelId, at: 'from' });
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setPhase({ id: travelId, at: 'go' }));
    });
    const doneMs = reducedMotion
      ? motionTokens.successMoment.reducedCrossFadeMs
      : motionTokens.spring.travel.durationMs +
        motionTokens.successMoment.fillStaggerMs * (count - 1);
    const done = setTimeout(() => setPhase(null), doneMs + 50);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(done);
    };
  }, [count, reducedMotion, travelId]);
  const order = React.useMemo(
    () => new Map((travel?.dotKeys ?? []).map((key, index) => [key, index])),
    [travel?.dotKeys],
  );
  return React.useCallback(
    (dot: Readonly<{ key: string; x: number; y: number }>): SvgWebStyle => {
      if (!phase || phase.id !== travelId) return undefined;
      const index = order.get(dot.key);
      if (index === undefined) return undefined;
      if (reducedMotion) {
        return phase.at === 'from'
          ? { opacity: 0 }
          : ({
              transition: `opacity ${motionTokens.successMoment.reducedCrossFadeMs}ms ease-out`,
            } as SvgWebStyle);
      }
      if (phase.at === 'from') {
        return {
          transform: `translate(${scene.px - dot.x}px, ${scene.py - dot.y}px) scale(0.4)`,
          opacity: 0,
          transformBox: 'fill-box',
          transformOrigin: 'center',
        } as SvgWebStyle;
      }
      const delay = index * motionTokens.successMoment.fillStaggerMs;
      return {
        transform: 'translate(0px, 0px) scale(1)',
        transformBox: 'fill-box',
        transformOrigin: 'center',
        transition: `transform ${motionTokens.spring.travel.durationMs}ms ${motionTokens.easingCss.standard} ${delay}ms, opacity ${motionTokens.durationMs.fast}ms ease-out ${delay}ms`,
      } as SvgWebStyle;
    },
    [order, phase, reducedMotion, scene.px, scene.py, travelId],
  );
}

const styles = StyleSheet.create(() => ({
  scene: { position: 'relative', flexShrink: 0, overflow: 'hidden' },
  ringMark: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  moonHit: {
    position: 'absolute',
    width: MOON_HIT_PX,
    height: MOON_HIT_PX,
    borderRadius: MOON_HIT_PX / 2,
  },
}));
