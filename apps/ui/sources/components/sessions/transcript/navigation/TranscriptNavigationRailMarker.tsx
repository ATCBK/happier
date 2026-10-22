import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    resolveTranscriptNavigationRailMarkerTransitionStyle,
    transcriptNavigationRailMarkerMotionEquals,
    type TranscriptNavigationRailMarkerMotion,
} from './resolveTranscriptNavigationRailMotion';
import { isTranscriptNavigationEntryWaiting } from './transcriptNavigationFilters';
import type { TranscriptNavigationEntry } from './transcriptNavigationTypes';
import { useTranscriptNavigationEntryText } from './useTranscriptNavigationEntryText';

/** The trail speaks the pane's marker language: amber waits for you, red ended in failure. */
export type TranscriptNavigationRailMarkerTone = 'waiting' | 'failed' | null;

export function resolveTranscriptNavigationRailMarkerTone(entry: TranscriptNavigationEntry): TranscriptNavigationRailMarkerTone {
    if (isTranscriptNavigationEntryWaiting(entry)) return 'waiting';
    if (entry.facts?.lastToolFailed === true) return 'failed';
    return null;
}

type WebMarkerViewProps = React.ComponentPropsWithRef<typeof View> & {
    onClick?: () => void;
    onKeyDown?: (event: unknown) => void;
    onPointerEnter?: (event: unknown) => void;
    tabIndex?: number;
};

const WebMarkerView = View as unknown as React.ComponentType<WebMarkerViewProps>;

export type TranscriptNavigationRailMarkerProps = Readonly<{
    active: boolean;
    anchorId: string;
    index: number;
    label: string;
    entry?: TranscriptNavigationEntry;
    markerHeightPx: number;
    motion: TranscriptNavigationRailMarkerMotion;
    onFocusFromPointer: (index: number, event: unknown) => void;
    onPress: (index: number) => void;
    pinned: boolean;
    reducedMotion: boolean;
    tone?: TranscriptNavigationRailMarkerTone;
    topPx: number;
    visible: boolean;
}>;

function TranscriptNavigationRailMarkerComponent(props: TranscriptNavigationRailMarkerProps) {
    const styles = stylesheet;
    const entry = useTranscriptNavigationEntryText(props.entry);
    const { index, onFocusFromPointer, onPress } = props;
    const handlePointerEnter = React.useCallback((event: unknown) => {
        onFocusFromPointer(index, event);
    }, [index, onFocusFromPointer]);
    const handleClick = React.useCallback(() => {
        onPress(index);
    }, [index, onPress]);

    return (
        <WebMarkerView
            accessibilityLabel={entry?.label ?? props.label}
            accessibilityRole="button"
            accessibilityState={{
                selected: props.active,
            }}
            onClick={handleClick}
            onPointerEnter={handlePointerEnter}
            tabIndex={-1}
            testID={`transcript-navigation-rail.marker:${props.anchorId}`}
            style={[
                styles.markerHitArea,
                {
                    height: Math.max(12, props.markerHeightPx + 8),
                    top: props.topPx - 4,
                },
            ]}
        >
            <View
                testID={`transcript-navigation-rail.marker-line:${props.anchorId}`}
                style={[
                    styles.markerLine,
                    props.active ? styles.markerLineActive : null,
                    props.visible && !props.active ? styles.markerLineVisible : null,
                    !props.active && props.tone === 'waiting' ? styles.markerLineWaiting : null,
                    !props.active && props.tone === 'failed' ? styles.markerLineFailed : null,
                    resolveTranscriptNavigationRailMarkerTransitionStyle(props.reducedMotion),
                    {
                        height: props.markerHeightPx,
                        opacity: props.motion.opacity,
                        transform: [{ translateY: props.motion.translateYPx }],
                        width: props.motion.widthPx,
                    },
                ]}
            />
            {props.pinned ? (
                <View
                    testID={`transcript-navigation-rail.marker-pin:${props.anchorId}`}
                    style={[
                        styles.markerPin,
                        props.active ? styles.markerPinActive : null,
                    ]}
                />
            ) : null}
        </WebMarkerView>
    );
}

export const TranscriptNavigationRailMarker = React.memo(
    TranscriptNavigationRailMarkerComponent,
    (left, right) => (
        left.active === right.active &&
        left.anchorId === right.anchorId &&
        left.index === right.index &&
        left.label === right.label &&
        left.entry === right.entry &&
        left.markerHeightPx === right.markerHeightPx &&
        transcriptNavigationRailMarkerMotionEquals(left.motion, right.motion) &&
        left.onFocusFromPointer === right.onFocusFromPointer &&
        left.onPress === right.onPress &&
        left.pinned === right.pinned &&
        left.reducedMotion === right.reducedMotion &&
        (left.tone ?? null) === (right.tone ?? null) &&
        left.topPx === right.topPx &&
        left.visible === right.visible
    ),
);

const stylesheet = StyleSheet.create((theme) => ({
    markerHitArea: {
        alignItems: 'center',
        justifyContent: 'center',
        left: 0,
        position: 'absolute',
        width: 24,
    },
    markerLine: {
        // Full capsule so the line reads with rounded caps at every width.
        borderRadius: 999,
        backgroundColor: theme.colors.text.tertiary,
    },
    markerLineVisible: {
        backgroundColor: theme.colors.text.secondary,
    },
    markerLineWaiting: {
        backgroundColor: theme.colors.state.warning.foreground,
    },
    markerLineFailed: {
        backgroundColor: theme.colors.state.danger.foreground,
    },
    markerLineActive: {
        backgroundColor: theme.colors.accent.blue,
    },
    markerPin: {
        position: 'absolute',
        right: 3,
        width: 4,
        height: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.text.secondary,
    },
    markerPinActive: {
        backgroundColor: theme.colors.accent.blue,
    },
}));
