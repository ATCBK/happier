/**
 * Cross-platform blur overlay for `SlideTransitionFrame` layers.
 *
 * Web → CSS `filter: blur(${px}px)` driven via `useAnimatedStyle`.
 * iOS → `expo-blur` intensity driven via `useAnimatedProps`.
 * Android → no blur overlay without an explicit content target; translation/fade remain.
 * The shared blur material owner loads the native SDK only where it is usable.
 */

import * as React from 'react';
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
    useAnimatedProps,
    useAnimatedStyle,
    type SharedValue,
} from 'react-native-reanimated';

import { getBlurViewComponent, isNativeBlurAvailable } from '@/components/ui/glass/blurMaterial';

import { resolveSlideLayerStyle, type SlideLayerRole } from './resolveSlideLayerStyle';

type AnimatedBlurViewProps = Readonly<{
    intensity?: number;
    style?: StyleProp<ViewStyle>;
    animatedProps?: object;
    testID?: string;
}>;

let cachedNativeBlurComponent: React.ComponentType<AnimatedBlurViewProps> | null = null;
function getAnimatedNativeBlurComponent(): React.ComponentType<AnimatedBlurViewProps> | null {
    if (cachedNativeBlurComponent) return cachedNativeBlurComponent;
    const BlurView = getBlurViewComponent();
    if (!BlurView) return null;
    cachedNativeBlurComponent = Animated.createAnimatedComponent(BlurView);
    return cachedNativeBlurComponent;
}

export type SlideTransitionBlurLayerProps = Readonly<{
    role: SlideLayerRole;
    progress: SharedValue<number>;
    distance: number;
    maxBlurPx: number;
    nativeBlurIntensityScale: number;
    testID?: string;
}>;

const blurOverlayStyle: ViewStyle = {
    ...StyleSheet.absoluteFillObject,
};

export function SlideTransitionBlurLayer(props: SlideTransitionBlurLayerProps): React.ReactElement | null {
    if (Platform.OS === 'web') {
        return <SlideTransitionBlurLayerWeb {...props} />;
    }
    if (!isNativeBlurAvailable()) return null;
    return <SlideTransitionBlurLayerNative {...props} />;
}

/**
 * Web-only style augmentation: React Native's `ViewStyle` does not type the
 * `backdrop-filter` / `-webkit-backdrop-filter` CSS properties, but RN-web
 * passes them through to the DOM verbatim. Narrow the surface to just the
 * fields we actually set instead of escaping to `any`.
 */
type WebBackdropFilterStyle = Pick<ViewStyle, 'opacity'> & Readonly<{
    backdropFilter?: string;
    WebkitBackdropFilter?: string;
}>;

function SlideTransitionBlurLayerWeb(props: SlideTransitionBlurLayerProps): React.ReactElement {
    const animatedStyle = useAnimatedStyle(() => {
        const layer = resolveSlideLayerStyle({
            role: props.role,
            progress: props.progress.value,
            distance: props.distance,
            maxBlur: props.maxBlurPx,
        });
        // Use `backdrop-filter` (not `filter`). `filter: blur` blurs the
        // overlay's own descendants — the overlay has none, so it would do
        // nothing. `backdrop-filter` blurs the painted content BEHIND the
        // overlay in the stacking context, which is exactly the slide content
        // rendered as a sibling inside the same animated layer container.
        const blurCss = `blur(${layer.blurPx}px)`;
        const style: WebBackdropFilterStyle = {
            backdropFilter: blurCss,
            WebkitBackdropFilter: blurCss,
            opacity: layer.blurPx === 0 ? 0 : 1,
        };
        return style;
    });

    return (
        <Animated.View
            pointerEvents="none"
            style={[blurOverlayStyle, animatedStyle]}
            testID={props.testID}
        />
    );
}

function SlideTransitionBlurLayerNative(props: SlideTransitionBlurLayerProps): React.ReactElement | null {
    const AnimatedBlurView = getAnimatedNativeBlurComponent();

    const animatedProps = useAnimatedProps(() => {
        const layer = resolveSlideLayerStyle({
            role: props.role,
            progress: props.progress.value,
            distance: props.distance,
            maxBlur: props.maxBlurPx,
        });
        const intensity = Math.min(100, Math.max(0, layer.blurPx * props.nativeBlurIntensityScale));
        return { intensity };
    });

    if (!AnimatedBlurView) return null;
    return (
        <AnimatedBlurView
            animatedProps={animatedProps as object}
            style={blurOverlayStyle}
            testID={props.testID}
        />
    );
}
