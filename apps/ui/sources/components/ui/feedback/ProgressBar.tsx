import * as React from 'react';
import { Animated, Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { resolveMotionPresentation } from '@/components/ui/motion/reducedMotionTable';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

const BAR_HEIGHT = 4;

const stylesheet = StyleSheet.create((theme) => ({
    track: {
        height: BAR_HEIGHT,
        borderRadius: 999,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    fill: {
        width: '100%',
        height: BAR_HEIGHT,
        borderRadius: 999,
        backgroundColor: theme.colors.text.link,
        // The fill scales from its leading edge, so `scaleX` reads as width without animating layout.
        transformOrigin: 'left',
    },
}));

function clampFraction(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

/**
 * A determinate progress bar. `progress` is a fraction from 0 to 1.
 *
 * The fill animates `scaleX`, which React Native's native driver supports; a native-driven `width`
 * animation throws on device. Under reduced motion the fill moves to each value without gliding.
 */
export function ProgressBar(props: Readonly<{ progress: number; testID?: string; accessibilityLabel?: string }>): React.ReactElement {
    const styles = stylesheet;
    const progress = clampFraction(props.progress);
    const reducedMotion = useReducedMotionPreference();
    const fill = React.useRef(new Animated.Value(progress)).current;

    React.useEffect(() => {
        if (resolveMotionPresentation('progressFill', reducedMotion) !== 'animate') {
            fill.setValue(progress);
            return;
        }
        const animation = Animated.timing(fill, {
            toValue: progress,
            duration: motionTokens.durationMs.fast,
            easing: motionTokens.easing.standard,
            useNativeDriver: Platform.OS !== 'web',
        });
        animation.start();
        return () => animation.stop();
    }, [fill, progress, reducedMotion]);

    return (
        <View
            testID={props.testID}
            style={styles.track}
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={props.accessibilityLabel}
            accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
        >
            <Animated.View style={[styles.fill, { transform: [{ scaleX: fill }] }]} />
        </View>
    );
}
