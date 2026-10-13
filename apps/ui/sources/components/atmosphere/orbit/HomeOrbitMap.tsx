import * as React from 'react';
import {
  PixelRatio,
  Platform,
  Pressable,
  StyleSheet as RNStyleSheet,
  View,
} from 'react-native';
import Svg, { Circle, Text as SvgText } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PlanetCanvas } from '@/components/atmosphere/PlanetCanvas';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import type { HomeOrbitScene } from './homeOrbitScene';

/** Dots outside a preview fade to this strength; the previewed ones grow (lab L4 "reach map hover"). */
const PREVIEW_FADED_OPACITY = 0.16;
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
  const transition =
    Platform.OS === 'web' && !reducedMotion
      ? {
          transition: `opacity ${previewing ? motionTokens.durationMs.fast : motionTokens.overlay.popover.exitMs}ms ease-out, r ${previewing ? motionTokens.durationMs.fast : motionTokens.overlay.popover.exitMs}ms ease-out`,
        }
      : undefined;
  const travelStyle = useTravelStyle(props.travel ?? null, scene, reducedMotion);
  const labelStyle = Typography.variant('meta');
  const labelFontSize = labelStyle.fontSize ?? 12;
  const placedLabels = React.useMemo(() => {
    const placed: Record<string, ReturnType<typeof placeMoonLabel>> = {};
    for (const moon of scene.moons) {
      const label = props.labels?.[moon.key];
      if (label) placed[moon.key] = placeMoonLabel(moon, label, scene.width, labelFontSize);
    }
    return placed;
  }, [labelFontSize, props.labels, scene.moons, scene.width]);
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
                  fontWeight={labelStyle.fontWeight as string | undefined}
                >
                  {placedLabels[moon.key]!.text}
                </SvgText>
              ) : null}
            </React.Fragment>
          ))}
        </Svg>
      </View>
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
    (dot: Readonly<{ key: string; x: number; y: number }>) => {
      if (!phase || phase.id !== travelId) return undefined;
      const index = order.get(dot.key);
      if (index === undefined) return undefined;
      if (reducedMotion) {
        return phase.at === 'from'
          ? { opacity: 0 }
          : {
              transition: `opacity ${motionTokens.successMoment.reducedCrossFadeMs}ms ease-out`,
            };
      }
      if (phase.at === 'from') {
        return {
          transform: `translate(${scene.px - dot.x}px, ${scene.py - dot.y}px) scale(0.4)`,
          opacity: 0,
          transformBox: 'fill-box',
          transformOrigin: 'center',
        };
      }
      const delay = index * motionTokens.successMoment.fillStaggerMs;
      return {
        transform: 'translate(0px, 0px) scale(1)',
        transformBox: 'fill-box',
        transformOrigin: 'center',
        transition: `transform ${motionTokens.spring.travel.durationMs}ms ${motionTokens.easingCss.standard} ${delay}ms, opacity ${motionTokens.durationMs.fast}ms ease-out ${delay}ms`,
      };
    },
    [order, phase, reducedMotion, scene.px, scene.py, travelId],
  );
}

/** Inter's average advance at the meta size, as a share of the font size: enough to keep a label inside the map. */
const LABEL_ADVANCE_EM = 0.56;
const LABEL_GAP_PX = 6;

/**
 * A moon's name sits on the side with room: after the moon, or before it when the map's edge is
 * closer than the name; a name longer than either side's room ends in an ellipsis instead of being cut.
 */
function placeMoonLabel(
  moon: Readonly<{ x: number; r: number }>,
  label: string,
  width: number,
  fontSize: number,
): Readonly<{ x: number; textAnchor: 'start' | 'end'; text: string }> {
  const advance = fontSize * LABEL_ADVANCE_EM;
  const after = width - (moon.x + moon.r + LABEL_GAP_PX);
  const before = moon.x - moon.r - LABEL_GAP_PX;
  const needed = label.length * advance;
  const useAfter = needed <= after || after >= before;
  const room = useAfter ? after : before;
  const fits = Math.max(1, Math.floor(room / advance));
  const text = label.length <= fits ? label : `${label.slice(0, Math.max(1, fits - 1))}…`;
  return useAfter
    ? { x: Math.round((moon.x + moon.r + LABEL_GAP_PX) * 10) / 10, textAnchor: 'start', text }
    : { x: Math.round((moon.x - moon.r - LABEL_GAP_PX) * 10) / 10, textAnchor: 'end', text };
}

const styles = StyleSheet.create(() => ({
  scene: { position: 'relative', flexShrink: 0, overflow: 'hidden' },
  moonHit: {
    position: 'absolute',
    width: MOON_HIT_PX,
    height: MOON_HIT_PX,
    borderRadius: MOON_HIT_PX / 2,
  },
}));
