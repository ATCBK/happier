import { useMemo, useSyncExternalStore, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';
import {
  evaluateHappierCollectionMotionTrack,
  type HappierCollectionMotionTracks,
} from './collectionTable.js';
import type {
  HappierDisclosureBodyProps,
  HappierDisclosureMotion,
  HappierDisclosureMotionDriver,
} from './Disclosure.js';

/**
 * The Collection's motion seam (COLLECTION.md §8). The Collection decides WHAT moves and along which course
 * (`HappierCollectionMotionTracks`); the host decides how it animates. Happier core drives it with Reanimated
 * from its motion tokens, which stay host-private; plugin-ui carries no animation library.
 */

/** One animated progress value. It animates linearly in time; each track applies its own easing. */
export type HappierCollectionMotionValue = Readonly<{
  /** The current presentation value, so an interruption starts from what is on screen. */
  get: () => number;
  set: (value: number) => void;
  /** Animates from the presentation value; `finished` is false when a later call interrupted it. */
  animateTo: (target: number, durationMs: number, onFinished: (finished: boolean) => void) => void;
  cancel: () => void;
}>;

export type HappierCollectionAnimatedViewProps = Readonly<{
  value: HappierCollectionMotionValue;
  tracks: HappierCollectionMotionTracks;
  style?: HappierStyleProp;
  pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only';
  testID?: string;
  children?: ReactNode;
}>;

export type HappierCollectionMotionDriver = Readonly<{
  useValue: (initial: number) => HappierCollectionMotionValue;
  AnimatedView: ComponentType<HappierCollectionAnimatedViewProps>;
  /** The host's motion tokens: the table → split open, its close, and the reduced-motion cross-fade. */
  durationsMs: Readonly<{ open: number; close: number; reducedMotion: number }>;
}>;

/** The static style a set of tracks paints at one progress. */
export function resolveHappierCollectionTrackStyle(
  tracks: HappierCollectionMotionTracks,
  progress: number,
): HappierPortableStyle {
  const style: { -readonly [Key in keyof HappierPortableStyle]: HappierPortableStyle[Key] } = {};
  if (tracks.opacity) style.opacity = evaluateHappierCollectionMotionTrack(tracks.opacity, progress);
  const transform: Array<{ translateX: number } | { translateY: number }> = [];
  if (tracks.translateX) transform.push({ translateX: evaluateHappierCollectionMotionTrack(tracks.translateX, progress) });
  if (tracks.translateY) transform.push({ translateY: evaluateHappierCollectionMotionTrack(tracks.translateY, progress) });
  if (transform.length > 0) style.transform = transform;
  return style;
}

type InstantValue = HappierCollectionMotionValue & Readonly<{ subscribe: (listener: () => void) => () => void }>;

function createInstantValue(initial: number): InstantValue {
  let value = initial;
  const listeners = new Set<() => void>();
  const set = (next: number) => {
    if (next === value) return;
    value = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => value,
    set,
    animateTo: (target, _durationMs, onFinished) => {
      set(target);
      onFinished(true);
    },
    cancel: () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function InstantAnimatedView(props: HappierCollectionAnimatedViewProps): ReactElement {
  const value = props.value as InstantValue;
  const progress = useSyncExternalStore(value.subscribe, value.get, value.get);
  return (
    <View
      testID={props.testID}
      pointerEvents={props.pointerEvents}
      style={[props.style, resolveHappierCollectionTrackStyle(props.tracks, progress)]}
    >
      {props.children}
    </View>
  );
}

/**
 * Where no host drives motion (a hosted-web realm, a test), every change lands at once: the same end states,
 * no travel. It is the honest reduced experience, not an imitation of the host's curves.
 */
export const HAPPIER_COLLECTION_INSTANT_MOTION: HappierCollectionMotionDriver = Object.freeze({
  useValue: (initial: number) => useMemo(() => createInstantValue(initial), []),
  AnimatedView: InstantAnimatedView,
  durationsMs: Object.freeze({ open: 0, close: 0, reducedMotion: 0 }),
});

const INSTANT_DISCLOSURE_MOTION: HappierDisclosureMotion = Object.freeze({
  setHeight: () => {},
  animateHeight: (_to: number, _durationMs: number, onFinished: () => void) => onFinished(),
  setOpacity: () => {},
  animateOpacity: () => {},
  cancel: () => {},
});

function InstantDisclosureBody(props: HappierDisclosureBodyProps<HappierDisclosureMotion>): ReactElement {
  return <View testID={props.testID} style={props.style}>{props.children}</View>;
}

/** The disclosure's counterpart of {@link HAPPIER_COLLECTION_INSTANT_MOTION}: a peek opens and closes at once. */
export const HAPPIER_INSTANT_DISCLOSURE_MOTION: HappierDisclosureMotionDriver = Object.freeze({
  useMotion: () => INSTANT_DISCLOSURE_MOTION,
  Body: InstantDisclosureBody,
});
