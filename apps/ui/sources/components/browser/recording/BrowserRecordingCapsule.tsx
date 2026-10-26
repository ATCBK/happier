import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    capsule: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minHeight: 30,
        paddingLeft: theme.space.s10,
        paddingRight: theme.space.s2,
        borderRadius: 15,
        backgroundColor: theme.colors.state.danger.background,
    },
    elapsed: {
        ...Typography.variant('meta'),
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
}));

function formatElapsed(totalSeconds: number): string {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * A running recording, docked in the chrome row: "● 0:42 · Stop" (lab `browser` Q notes). The one
 * place red speaks in the browser chrome, and only while something is being recorded; an idle
 * recorder lives in the `⋯` menu. The elapsed time ticks in this leaf, so the second hand never
 * re-renders the shell. Discarding the recording is the menu's job, beside Record.
 */
export function BrowserRecordingCapsule(props: Readonly<{
    recording: BrowserRecordingSessionV1;
    onStop?: (recording: BrowserRecordingSessionV1) => void;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const running = props.recording.status === 'recording';
    const tickingSeconds = useElapsedTime(running ? props.recording.startedAtMs : null);
    const elapsed = formatElapsed(running ? tickingSeconds : Math.floor(props.recording.durationMs / 1_000));
    const { onStop, recording } = props;
    return (
        <View
            testID={`${props.testID}-status-recording`}
            style={stylesheet.capsule}
            accessibilityLabel={t('browserPresence.recording.elapsedA11y', { elapsed })}
        >
            <StatusDot color={theme.colors.state.danger.foreground} size={8} />
            <Text style={stylesheet.elapsed}>{elapsed}</Text>
            <IconButton
                testID={`${props.testID}-stop`}
                iconName="stop"
                variant="plain"
                accessibilityLabel={t('browserRecording.actions.stop')}
                tooltip={t('browserRecording.actions.stop')}
                size={26}
                interactiveTargetGapPx={8}
                disabled={!onStop}
                onPress={() => onStop?.(recording)}
            />
        </View>
    );
}
