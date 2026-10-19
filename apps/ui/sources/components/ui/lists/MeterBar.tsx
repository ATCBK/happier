import * as React from 'react';
import { Animated, Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { HappierProgress } from '@happier-dev/plugin-ui/presentation';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

export type MeterTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface MeterBarProps {
    tone: MeterTone;
    /**
     * Visual fill in 0..1 (clamped); the bar decides nothing about what it means. Progress
     * consumers pass the done/consumed fraction; quota rows do not use `MeterBar` directly —
     * `UsageMeterRow` owns quota rows and fills them with what is left.
     */
    fillFraction: number;
    caption?: React.ReactNode;
    /** Track height in px (default 6). */
    height?: number;
    trackColor?: string;
    /** A host surface may bind an existing neutral text fill instead of a state tint. */
    fillColor?: string;
    /** Animate transfer progress through native-supported transforms. */
    animated?: boolean;
    /** Optional visible floor for positive fills; zero remains empty. */
    minimumVisibleFraction?: number;
    fillOpacity?: number;
    /** A projected share is drawn hatched; measured fills stay solid. */
    fillPattern?: 'solid' | 'hatched';
    /**
     * When the bar reports progress (not a capacity), its accessible name. The bar then exposes
     * `progressbar` semantics with the fill as a 0–100 value.
     */
    progressAccessibilityLabel?: string;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}

const DEFAULT_TRACK_HEIGHT_PX = 6;

const stylesheet = StyleSheet.create((theme) => ({
    caption: {
        color: theme.colors.text.secondary,
        marginTop: theme.space.s4,
        fontSize: 12,
        lineHeight: 16,
    },
}));

function AnimatedMeterFill(props: Readonly<{ percentage: number; color: string; testID?: string }>) {
    const reducedMotion = useReducedMotionPreference();
    const fraction = props.percentage / 100;
    const value = React.useRef(new Animated.Value(fraction)).current;
    React.useEffect(() => {
        if (reducedMotion) {
            value.setValue(fraction);
            return;
        }
        const animation = Animated.timing(value, {
            toValue: fraction, duration: motionTokens.durationMs.fast,
            easing: motionTokens.easing.standard, useNativeDriver: Platform.OS !== 'web',
        });
        animation.start();
        return () => animation.stop();
    }, [fraction, reducedMotion, value]);
    return <Animated.View testID={props.testID} style={{ width: '100%', height: '100%',
        backgroundColor: props.color, transformOrigin: 'left', transform: [{ scaleX: value }] }} />;
}

export const MeterBar = React.memo<MeterBarProps>((props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const height = props.height ?? DEFAULT_TRACK_HEIGHT_PX;
    const presentationTheme = usePluginUiTheme(theme);
    const fill = Number.isFinite(props.fillFraction) ? props.fillFraction : 0;
    // Read the token directly — never apply a runtime opacity/rgba transform to a
    // theme token (web var-ification turns such transforms into silent no-ops).
    const fillColor = props.fillColor ?? theme.colors.state[props.tone].foreground;
    const trackColor = props.trackColor ?? (theme.dark ? theme.colors.surface.pressedOverlay : theme.colors.border.default);

    return (
        <View
            testID={props.testID}
            style={props.style}
        >
            <HappierProgress
                testID={props.testID ? `${props.testID}:track` : undefined}
                fillTestID={props.testID ? `${props.testID}:fill` : undefined}
                renderFill={props.animated ? (percentage) => (
                    <AnimatedMeterFill percentage={percentage} color={fillColor}
                        testID={props.testID ? `${props.testID}:fill` : undefined} />
                ) : undefined}
                value={fill}
                label={props.progressAccessibilityLabel ?? ''}
                semantics={props.progressAccessibilityLabel ? 'progress' : 'none'}
                theme={presentationTheme}
                height={height}
                fillColor={fillColor}
                minimumVisibleFraction={fill > 0 ? props.minimumVisibleFraction : undefined}
                fillOpacity={props.fillOpacity}
                fillPattern={props.fillPattern}
                trackColor={trackColor}
                style={{ width: '100%' }}
            />
            {props.caption != null ? (
                typeof props.caption === 'string' || typeof props.caption === 'number' ? (
                    <Text
                        testID={props.testID ? `${props.testID}:caption` : undefined}
                        style={styles.caption}
                    >
                        {props.caption}
                    </Text>
                ) : (
                    props.caption
                )
            ) : null}
        </View>
    );
});

MeterBar.displayName = 'MeterBar';
