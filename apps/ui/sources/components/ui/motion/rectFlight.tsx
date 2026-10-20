import * as React from 'react';
import type { View, ViewStyle } from 'react-native';
import Animated, {
    Easing,
    cancelAnimation,
    runOnJS,
    useAnimatedStyle,
    useDerivedValue,
    useSharedValue,
    withSequence,
    withSpring,
    withTiming,
} from 'react-native-reanimated';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { motionTokens } from './motionTokens';
import { reanimatedMotionTokens } from './reanimatedMotionTokens';
import { interpolateRectFlip, rectFlipFrame, rectFlipLegProgress, type RectFlipFrame, type RectFlipOrigin, type WindowFlightRect } from './rectFlipGeometry';

export { coverRectFlipOrigin, interpolateRectFlip } from './rectFlipGeometry';
export type { RectFlipFrame, RectFlipOrigin, WindowFlightRect } from './rectFlipGeometry';

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

/** The enter's timing (MPG-32): the travel, then the trailing content's fade over its last part. */
export const ENTER_FROM_RECT_MS = 320;
export const ENTER_FROM_RECT_CONTENT_FADE_MS = 140;

const IDENTITY_FLIP_RECT: WindowFlightRect = { x: 0, y: 0, width: 1, height: 1 };

/**
 * One reversible FLIP clock: progress is also the stage's backdrop opacity. `style` transforms a
 * destination-positioned image. For a cover-cropped origin, use `clipStyle` on the outer layer and
 * `clippedImageStyle` on its image (sized to target.width/height); both layers use transform only.
 */
export function useRectFlip(options: Readonly<{ reducedMotion?: boolean; initialProgress?: 0 | 1 }> = {}) {
    const preferredReducedMotion = useReducedMotionPreference();
    const reducedMotion = options.reducedMotion ?? preferredReducedMotion;
    const progress = useSharedValue<number>(options.initialProgress ?? 1);
    const from = useSharedValue<RectFlipFrame>(rectFlipFrame(IDENTITY_FLIP_RECT));
    const to = useSharedValue<RectFlipFrame>(rectFlipFrame(IDENTITY_FLIP_RECT));
    const target = useSharedValue(IDENTITY_FLIP_RECT);
    const closing = useSharedValue(false);
    const backdropFrom = useSharedValue(1);
    const fades = useSharedValue(reducedMotion);

    const openFrom = React.useCallback((origin: RectFlipOrigin | null, destination: WindowFlightRect, onComplete?: () => void) => {
        cancelAnimation(progress);
        target.value = destination;
        from.value = rectFlipFrame(reducedMotion || origin === null ? destination : origin);
        to.value = rectFlipFrame(destination);
        closing.value = false;
        fades.value = reducedMotion || origin === null;
        progress.value = 0;
        progress.value = withTiming(1, {
            duration: reducedMotion ? motionTokens.successMoment.reducedCrossFadeMs : origin === null ? motionTokens.overlay.modal.enterMs : ENTER_FROM_RECT_MS,
            easing: reanimatedMotionTokens.easing.stageCamera,
        }, (finished) => {
            'worklet';
            if (finished && onComplete) runOnJS(onComplete)();
        });
    }, [closing, fades, from, progress, reducedMotion, target, to]);

    const closeTo = React.useCallback((origin: RectFlipOrigin | null, closeOptions: Readonly<{ velocityY?: number; onComplete?: () => void }> = {}) => {
        cancelAnimation(progress);
        const current = interpolateRectFlip(from.value, to.value, rectFlipLegProgress(progress.value, closing.value, backdropFrom.value));
        const currentProgress = progress.value;
        const image = current.imageRect;
        const fallbackScale = 0.96;
        const fallbackImage = { x: image.x + image.width * (1 - fallbackScale) / 2, y: image.y + image.height * (1 - fallbackScale) / 2, width: image.width * fallbackScale, height: image.height * fallbackScale };
        const destination = origin === null ? {
            imageRect: fallbackImage,
            clipRect: {
                x: fallbackImage.x + (current.clipRect.x - image.x) * fallbackScale,
                y: fallbackImage.y + (current.clipRect.y - image.y) * fallbackScale,
                width: current.clipRect.width * fallbackScale,
                height: current.clipRect.height * fallbackScale,
            },
        } : rectFlipFrame(origin);
        from.value = current;
        to.value = reducedMotion ? current : destination;
        closing.value = true;
        backdropFrom.value = currentProgress;
        fades.value = reducedMotion || origin === null;
        const complete = closeOptions.onComplete;
        const done = (finished?: boolean) => {
            'worklet';
            if (finished && complete) runOnJS(complete)();
        };
        if (!reducedMotion && closeOptions.velocityY !== undefined) {
            const distance = to.value.imageRect.y - image.y;
            progress.value = withSpring(0, {
                ...reanimatedMotionTokens.spring.travel,
                velocity: distance === 0 ? 0 : -closeOptions.velocityY * currentProgress / distance,
            }, done);
        } else {
            progress.value = withTiming(0, {
                duration: reducedMotion ? motionTokens.successMoment.reducedCrossFadeMs : origin === null ? motionTokens.overlay.modal.exitMs : ENTER_FROM_RECT_MS,
                easing: reanimatedMotionTokens.easing.stageCamera,
            }, done);
        }
    }, [backdropFrom, closing, fades, from, progress, reducedMotion, to]);

    const frame = useDerivedValue(() => interpolateRectFlip(from.value, to.value, rectFlipLegProgress(progress.value, closing.value, backdropFrom.value)));
    const style = useAnimatedStyle<ViewStyle>(() => ({
        opacity: fades.value ? progress.value : 1,
        transformOrigin: 'left top',
        transform: [
            { translateX: frame.value.imageRect.x - target.value.x },
            { translateY: frame.value.imageRect.y - target.value.y },
            { scaleX: frame.value.imageRect.width / target.value.width },
            { scaleY: frame.value.imageRect.height / target.value.height },
        ],
    }));
    const clipStyle = useAnimatedStyle<ViewStyle>(() => ({
        position: 'absolute', left: target.value.x, top: target.value.y,
        width: target.value.width, height: target.value.height, overflow: 'hidden',
        opacity: fades.value ? progress.value : 1,
        transformOrigin: 'left top',
        transform: [
            { translateX: frame.value.clipRect.x - target.value.x },
            { translateY: frame.value.clipRect.y - target.value.y },
            { scaleX: frame.value.clipRect.width / target.value.width },
            { scaleY: frame.value.clipRect.height / target.value.height },
        ],
    }));
    const clippedImageStyle = useAnimatedStyle<ViewStyle>(() => ({
        transformOrigin: 'left top',
        transform: [
            { translateX: (frame.value.imageRect.x - frame.value.clipRect.x) * target.value.width / frame.value.clipRect.width },
            { translateY: (frame.value.imageRect.y - frame.value.clipRect.y) * target.value.height / frame.value.clipRect.height },
            { scaleX: frame.value.imageRect.width / frame.value.clipRect.width },
            { scaleY: frame.value.imageRect.height / frame.value.clipRect.height },
        ],
    }));
    return { progress, style, clipStyle, clippedImageStyle, frame, openFrom, closeTo, from, to, backdropFrom };
}

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
    const { progress, style, openFrom } = useRectFlip({ ...options, initialProgress: origin !== null ? 0 : 1 });
    const [ready, setReady] = React.useState(!travels);
    const started = React.useRef(false);
    React.useEffect(() => {
        if (origin === null || !options.reducedMotion || started.current) return;
        started.current = true;
        openFrom(IDENTITY_FLIP_RECT, IDENTITY_FLIP_RECT);
    }, [openFrom, options.reducedMotion, origin]);
    const onTarget = React.useCallback((target: WindowFlightRect | null) => {
        if (!travels || started.current) return;
        started.current = true;
        if (!target || target.height <= 0) {
            progress.value = 1;
            setReady(true);
            return;
        }
        // The header's established contract scales uniformly by height; media flights use both axes.
        openFrom({ ...origin!, width: target.width * origin!.height / target.height }, target);
        setReady(true);
    }, [openFrom, progress, origin, travels]);
    const reducedMotion = options.reducedMotion;
    const contentStyle = useAnimatedStyle<ViewStyle>(() => {
        const fadeFrom = 1 - ENTER_FROM_RECT_CONTENT_FADE_MS / ENTER_FROM_RECT_MS;
        return { opacity: reducedMotion ? progress.value : Math.max(0, Math.min(1, (progress.value - fadeFrom) / (1 - fadeFrom))) };
    });
    return { style, contentStyle, onTarget, ready };
}

