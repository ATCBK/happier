import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Text } from '@/components/ui/text/Text';
import { WorkflowAgentDetail } from '@/components/workflows/presentation/WorkflowAgentDetail';
import { workflowRunStyles } from '@/components/workflows/run/workflowRunStyles';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';

type WorkflowRunAddress = Readonly<{ messageId: string; runId: string; serverId: string }>;

/**
 * What a Workflow published here, under its summary: the typed result when it says more than the
 * summary (the shared clamped result preview), and Open run to the exact Run that produced it.
 */
export function DiscussionWorkflowResult(props: WorkflowRunAddress & Readonly<{ detail: string | null }>) {
    return <View style={styles.container}>
        {props.detail ? <WorkflowAgentDetail text={props.detail} detailTestID={`session-discussion-workflow-result-${props.messageId}`} /> : null}
        <DiscussionWorkflowRunOpen messageId={props.messageId} runId={props.runId} serverId={props.serverId} />
    </View>;
}

/** The quiet Open run action every message a Workflow published carries, its one-line outcome included. */
export function DiscussionWorkflowRunOpen(props: WorkflowRunAddress) {
    const router = useRouter();
    const { runId, serverId } = props;
    const open = React.useCallback(() => router.push(createWorkflowRunRoute(runId, serverId)), [router, runId, serverId]);
    return <HappierPressable accessibilityRole="button" testID={`session-discussion-workflow-open-${props.messageId}`}
        onPress={open}
        style={({ pressed }) => [workflowRunStyles.actionTarget, styles.open, pressed ? workflowRunStyles.pressed : null]}>
        <Text style={styles.openLabel}>{t('workflows.run.open')}</Text>
    </HappierPressable>;
}

const styles = StyleSheet.create((theme) => ({
    container: { gap: theme.space.s4 },
    open: { alignSelf: 'flex-start' },
    // As the thread's other quiet lines: the meta step, a touch heavier so it reads as an action.
    openLabel: { ...Typography.variant('meta', 'medium'), color: theme.colors.text.secondary },
}));
