import * as React from 'react';
import type { View, ViewStyle } from 'react-native';
import Animated, {
    Easing,
    runOnJS,
    type SharedValue,
    useAnimatedStyle,
    useSharedValue,
    withSequence,
    withTiming,
} from 'react-native-reanimated';

import { motionTokens } from './motionTokens';
import { reanimatedMotionTokens } from './reanimatedMotionTokens';

/** A rectangle in a container's coordinates. */
export type FlightRect = Readonly<{ x: number; y: number; w: number; h: number }>;

type Measurable = View & { measureLayout?: View['measureLayout'] };

/** Where `node` sits inside `container` (the same `measureLayout` the set-up morph uses); `null` when it can't be read. */
export function measureRectInContainer(node: View | null | undefined, container: View | null | undefined): Promise<FlightRect | null> {
    const measurable = node as Measurable | null | undefined;
    if (!measurable || !container || typeof measurable.measureLayout !== 'function') return Promise.resolve(null);
    return new Promise((resolve) => {
        try {
            measurable.measureLayout(
                container as never,
                (x, y, w, h) => resolve({ x, y, w, h }),
                () => resolve(null),
            );
        } catch {
            resolve(null);
        }
    });
}

/** The smallest rectangle holding every given one; `null` for none. */
export function unionFlightRects(rects: readonly (FlightRect | null)[]): FlightRect | null {
    const present = rects.filter((rect): rect is FlightRect => rect !== null);
    if (present.length === 0) return null;
    const left = Math.min(...present.map((rect) => rect.x));
    const top = Math.min(...present.map((rect) => rect.y));
    const right = Math.max(...present.map((rect) => rect.x + rect.w));
    const bottom = Math.max(...present.map((rect) => rect.y + rect.h));
    return { x: left, y: top, w: right - left, h: bottom - top };
}

export type RectFlightTimeline = Readonly<{ gatherMs: number; travelMs: number; landMs: number }>;

/**
 * Moves a snapshot of A to B's rect inside one container (Git lab SX: the commit's rows become a chip that lands
 * as the newest timeline node). Three steps on one shared clock: gather at A (0 → 1: a slight scale-up into
 * place), travel to B (1 → 2: transform only), land into B (2 → 3: shrink toward B's leading edge and fade).
 * Compositor-only; every new `play` jumps the running one to its end. Callers skip it under reduced motion and
 * cross-fade instead (`motionTokens.successMoment.reducedCrossFadeMs`).
 */
export function useRectFlight() {
    const clock = useSharedValue(0);
    const from = useSharedValue<FlightRect>({ x: 0, y: 0, w: 0, h: 0 });
    const to = useSharedValue<FlightRect>({ x: 0, y: 0, w: 0, h: 0 });
    const [active, setActive] = React.useState(false);
    const doneRef = React.useRef<(() => void) | null>(null);

    const finish = React.useCallback(() => {
        setActive(false);
        const done = doneRef.current;
        doneRef.current = null;
        done?.();
    }, []);

    const play = React.useCallback((source: FlightRect, target: FlightRect, timeline: RectFlightTimeline = motionTokens.successMoment): Promise<void> => {
        doneRef.current?.();
        from.value = source;
        to.value = target;
        clock.value = 0;
        setActive(true);
        const ease = reanimatedMotionTokens.easing.standard;
        return new Promise((resolve) => {
            doneRef.current = resolve;
            clock.value = withSequence(
                withTiming(1, { duration: timeline.gatherMs, easing: ease }),
                withTiming(2, { duration: timeline.travelMs, easing: ease }),
                withTiming(3, { duration: timeline.landMs, easing: Easing.in(Easing.quad) }, (finished) => {
                    'worklet';
                    if (finished) runOnJS(finish)();
                }),
            );
        });
    }, [clock, finish, from, to]);

    const style = useAnimatedStyle(() => {
        const t = clock.value;
        const travel = Math.min(1, Math.max(0, t - 1));
        const land = Math.min(1, Math.max(0, t - 2));
        const gather = Math.min(1, t);
        const x = from.value.x + (to.value.x - from.value.x) * travel;
        const y = from.value.y + (to.value.y - from.value.y) * travel;
        return {
            position: 'absolute',
            left: 0,
            top: 0,
            opacity: gather * (1 - land),
            transform: [
                { translateX: x },
                { translateY: y },
                { scale: (0.98 + 0.02 * gather) * (1 - 0.8 * land) },
            ],
            transformOrigin: 'left center',
        };
    });

    return { active, play, style };
}

/** The flying snapshot: an absolutely positioned layer the caller renders inside the measured container. */
export function RectFlightLayer(props: Readonly<{ style: ReturnType<typeof useRectFlight>['style']; children: React.ReactNode }>) {
    return (
        <Animated.View pointerEvents="none" style={props.style}>
            {props.children}
        </Animated.View>
    );
}

/** A rectangle in window coordinates (`measureInWindow`). */
export type WindowFlightRect = Readonly<{ x: number; y: number; width: number; height: number }>;

/** The enter's timing (MPG-32): the travel, then the trailing content's fade over its last part. */
export const ENTER_FROM_RECT_MS = 320;
export const ENTER_FROM_RECT_CONTENT_FADE_MS = 140;

/**
 * A destination that enters from where its origin was (a popover row → the machine page's header, lab
 * `MO` 3): FLIP on the destination only, no cross-surface element. Given the origin's window rect, the
 * target is measured (`onTarget`) and starts at the origin's top-left at the origin's scale, then runs to
 * identity on the travel timing with a strong ease-out, compositor-only. A `null` origin, or reduced
 * motion, applies no transform (reduced motion cross-fades instead). `ready` stays false only while an
 * origin waits for its target's measure, so the caller can hold the first frame at opacity 0.
 */
export function useEnterFromRect(origin: WindowFlightRect | null, options: Readonly<{ reducedMotion: boolean }>): Readonly<{
    style: ReturnType<typeof useAnimatedStyle<ViewStyle>>;
    contentStyle: ReturnType<typeof useAnimatedStyle<ViewStyle>>;
    onTarget: (target: WindowFlightRect | null) => void;
    ready: boolean;
}> {
    const travels = origin !== null && !options.reducedMotion;
    const progress = useSharedValue(travels ? 0 : 1);
    const fade = useSharedValue(origin !== null && options.reducedMotion ? 0 : 1);
    const dx = useSharedValue(0);
    const dy = useSharedValue(0);
    const scale = useSharedValue(1);
    const [ready, setReady] = React.useState(!travels);
    const started = React.useRef(false);
    React.useEffect(() => {
        if (origin === null || !options.reducedMotion || started.current) return;
        started.current = true;
        fade.value = withTiming(1, { duration: motionTokens.successMoment.reducedCrossFadeMs });
    }, [fade, options.reducedMotion, origin]);
    const onTarget = React.useCallback((target: WindowFlightRect | null) => {
        if (!travels || started.current) return;
        started.current = true;
        if (!target || target.height <= 0) {
            progress.value = 1;
            setReady(true);
            return;
        }
        startEnter({ origin: origin!, target, progress, dx, dy, scale });
        setReady(true);
    }, [dx, dy, origin, progress, scale, travels]);
    const style = useAnimatedStyle<ViewStyle>(() => {
        const remaining = 1 - progress.value;
        return {
            opacity: fade.value,
            transform: [
                { translateX: dx.value * remaining },
                { translateY: dy.value * remaining },
                { scale: 1 + (scale.value - 1) * remaining },
            ],
            transformOrigin: 'left top',
        };
    });
    const contentStyle = useAnimatedStyle<ViewStyle>(() => {
        const fadeFrom = 1 - ENTER_FROM_RECT_CONTENT_FADE_MS / ENTER_FROM_RECT_MS;
        return { opacity: fade.value * Math.max(0, Math.min(1, (progress.value - fadeFrom) / (1 - fadeFrom))) };
    });
    return { style, contentStyle, onTarget, ready };
}

function startEnter(input: Readonly<{
    origin: WindowFlightRect;
    target: WindowFlightRect;
    progress: SharedValue<number>;
    dx: SharedValue<number>;
    dy: SharedValue<number>;
    scale: SharedValue<number>;
}>): void {
    input.dx.value = input.origin.x - input.target.x;
    input.dy.value = input.origin.y - input.target.y;
    input.scale.value = input.origin.height / input.target.height;
    input.progress.value = 0;
    input.progress.value = withTiming(1, { duration: ENTER_FROM_RECT_MS, easing: reanimatedMotionTokens.easing.stageCamera });
}

