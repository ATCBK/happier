import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SystemTaskProgressCard } from '@/components/systemTasks/SystemTaskProgressCard';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import type { NormalizedSetupDetail } from '../bootstrap/personalHomeBootstrapTypes';

const styles = StyleSheet.create((theme) => ({
    root: { gap: theme.space.s10 },
    code: { ...Typography.variant('meta'), ...Typography.mono(), color: theme.colors.text.secondary },
    message: {  color: theme.colors.text.secondary, ...Typography.variant('body'),  },
}));

const SENSITIVE_ASSIGNMENT = /\b(authorization(?!\s*[:=]?\s*bearer\b)|bearer|token|seed|secret|password|credential|api[-_]?key)\b(\s*[:=]\s*)([^\s;,]+)/gi;
const BEARER_VALUE = /\bauthorization\s*[:=]?\s*bearer\s+[^\s;,]+/gi;
const HIGH_ENTROPY_VALUE = /\b(?:[a-f0-9]{32,}|[A-Za-z0-9_-]{40,}={0,2})\b/g;

export function sanitizePersonalHomeDiagnosticMessage(message: string): string {
    return message
        .replace(BEARER_VALUE, 'Authorization: Bearer [redacted]')
        .replace(SENSITIVE_ASSIGNMENT, (_match, label: string, separator: string) => `${label}${separator}[redacted]`)
        .replace(HIGH_ENTROPY_VALUE, '[redacted]');
}

function sanitizeTaskSnapshot(snapshot: SystemTaskRunState): SystemTaskRunState {
    return {
        ...snapshot,
        latestMessage: snapshot.latestMessage == null
            ? null
            : sanitizePersonalHomeDiagnosticMessage(snapshot.latestMessage),
        currentStepId: snapshot.currentStepId == null
            ? null
            : sanitizePersonalHomeDiagnosticMessage(snapshot.currentStepId),
        events: snapshot.events.map((event) => ({
            ...event,
            ...(event.stepId ? { stepId: sanitizePersonalHomeDiagnosticMessage(event.stepId) } : {}),
            ...(event.message ? { message: sanitizePersonalHomeDiagnosticMessage(event.message) } : {}),
            // Prompt payloads can contain temporary URLs or credentials. The Personal Home
            // disclosure needs progress diagnostics, not actionable secret-bearing payloads.
            data: undefined,
        })),
        result: null,
    };
}

export const PersonalHomeDiagnosticDetails = React.memo(function PersonalHomeDiagnosticDetails(props: Readonly<{
    detail?: NormalizedSetupDetail;
    activeTask?: SystemTaskRunState | null;
}>) {
    const task = React.useMemo(
        () => props.activeTask ? sanitizeTaskSnapshot(props.activeTask) : null,
        [props.activeTask],
    );
    return (
        <View style={styles.root}>
            {props.detail?.code ? (
                <Text testID="personal-home-diagnostic-code" style={styles.code}>
                    {sanitizePersonalHomeDiagnosticMessage(props.detail.code)}
                </Text>
            ) : null}
            {props.detail?.message ? (
                <Text testID="personal-home-diagnostic-message" style={styles.message}>
                    {sanitizePersonalHomeDiagnosticMessage(props.detail.message)}
                </Text>
            ) : null}
            {task ? <SystemTaskProgressCard snapshot={task} /> : null}
        </View>
    );
});
