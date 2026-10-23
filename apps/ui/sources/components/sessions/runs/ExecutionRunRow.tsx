import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { isExecutionRunActive, type ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import {
    readExecutionRunAgentActivityStatus,
    resolveAgentActivityStatusPresentation,
} from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import { resolveWorkStatusTone, WORK_STATUS_PILL_VARIANT } from '@/components/work/status/resolveWorkStatusTone';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { t } from '@/text';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { resolveExecutionRunSelectionLabel, resolveRunNativeModelLabel, type RunNativeModelCatalog } from './resolveExecutionRunSelectionLabel';
import { useExecutionRunSourceLabel } from './useExecutionRunSourceLabel';
import { useProviderSettingsForServer } from '@/providers/hooks/useProviderSettings';


export type ExecutionRunRowRun =
    Pick<ExecutionRunPublicState, 'runId' | 'intent' | 'backendTarget' | 'status' | 'display'>
    & Partial<Pick<ExecutionRunPublicState, 'startedAtMs' | 'finishedAtMs' | 'runClass' | 'turnInFlight' | 'resolvedSelection'>>;

function ExecutionRunScopedSubtitle(props: Readonly<{
    backendTarget: ExecutionRunRowRun['backendTarget'];
    selection: NonNullable<ExecutionRunPublicState['resolvedSelection']>;
    serverId: string;
    subtitle: string;
    nativeModelCatalog?: RunNativeModelCatalog;
}>) {
    const { theme } = useUnistyles();
    const connections = useProviderSettingsForServer(props.serverId).connections;
    const sourceLabel = useExecutionRunSourceLabel(props.selection, props.serverId);
    const selectionLabel = resolveExecutionRunSelectionLabel(props.selection, (connectionId) => (
        connections.find(connection => connection.id === connectionId)?.displayName ?? null
    ), sourceLabel, resolveRunNativeModelLabel(props.backendTarget, props.nativeModelCatalog, props.selection));
    return <Text style={[styles.subtitle, { color: theme.colors.text.secondary }]} numberOfLines={1}>
        {[selectionLabel, props.subtitle].filter(Boolean).join(' · ')}
    </Text>;
}

export const ExecutionRunRow = React.memo((props: Readonly<{
    run: ExecutionRunRowRun;
    onPress?: () => void;
    subtitle?: string;
    serverId?: string | null;
    nativeModelCatalog?: RunNativeModelCatalog;
    rightAccessory?: React.ReactNode;
    selected?: boolean;
}>) => {
    const { theme } = useUnistyles();
    const { run, onPress } = props;
    const actionable = typeof onPress === 'function';
    const interactiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const subtitle = typeof props.subtitle === 'string' ? props.subtitle : run.runId;
    const selectionLabel = resolveExecutionRunSelectionLabel(run.resolvedSelection, () => null, null,
        resolveRunNativeModelLabel(run.backendTarget, props.nativeModelCatalog, run.resolvedSelection));
    const backendLabel = resolveExecutionRunBackendLabel(run.backendTarget);
    // The run's state in the roster's words (sessionAgentActivityPresentation) and the shared tone (I3).
    const activityStatus = readExecutionRunAgentActivityStatus(run.status);
    const status = resolveWorkStatusTone({
        kind: 'agent_activity',
        facts: { status: activityStatus, word: resolveAgentActivityStatusPresentation(activityStatus, isExecutionRunActive(run)).label },
    });
    const title =
        (run.display && typeof run.display === 'object' && typeof (run.display as any).title === 'string' && String((run.display as any).title).trim().length > 0)
            ? String((run.display as any).title).trim()
            : (run.display && typeof run.display === 'object' && typeof (run.display as any).participantLabel === 'string' && String((run.display as any).participantLabel).trim().length > 0)
                ? String((run.display as any).participantLabel).trim()
                : backendLabel ? `${run.intent} · ${backendLabel}` : run.intent;

    return (
        <Pressable
            // A row without `onPress` is a read-only summary. Announcing it as a
            // button — or padding it out to a touch target — would promise an
            // interaction this host did not wire.
            {...(actionable
                ? {
                    accessibilityRole: 'button' as const,
                    accessibilityLabel: title,
                    accessibilityHint: t('runs.openRun'),
                }
                : {})}
            accessibilityState={{ selected: props.selected === true, disabled: !onPress }}
            onPress={onPress}
            disabled={!onPress}
            style={({ pressed }) => ({
                padding: theme.space.s12,
                borderRadius: 12,
                backgroundColor: theme.colors.surface.inset,
                borderWidth: 1,
                borderColor: props.selected ? theme.colors.text.link : theme.colors.border.default,
                gap: theme.space.s8,
                opacity: pressed ? motionTokens.press.opacitySubtle : 1,
                ...(actionable
                    ? { minWidth: interactiveTargetSize, minHeight: interactiveTargetSize, justifyContent: 'center' as const }
                    : {}),
            })}
        >
            <View style={styles.row}>
                <Text style={[styles.title, { color: theme.colors.text.primary }]} numberOfLines={1}>
                    {title}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 }}>
                    <StatusPill
                        testID="execution-run-row-status"
                        variant={WORK_STATUS_PILL_VARIANT[status.tone]}
                        label={status.word}
                        labelVariant="micro"
                        hideDot
                    />
                    {props.rightAccessory ?? null}
                </View>
            </View>
            {run.resolvedSelection && props.serverId ? (
                <ExecutionRunScopedSubtitle backendTarget={run.backendTarget} selection={run.resolvedSelection} serverId={props.serverId} subtitle={subtitle} nativeModelCatalog={props.nativeModelCatalog} />
            ) : (
                <Text style={[styles.subtitle, { color: theme.colors.text.secondary }]} numberOfLines={1}>
                    {[selectionLabel, subtitle].filter(Boolean).join(' · ')}
                </Text>
            )}
        </Pressable>
    );
});

const styles = StyleSheet.create(() => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
    },
    title: {
        ...Typography.variant('body', 'semiBold'),
    },
    subtitle: {
        fontFamily: 'Menlo',
        fontSize: 12,
    },
}));
