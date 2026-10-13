import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SessionAgentActivitySummary } from '@/components/sessions/agents/presentation/SessionAgentActivitySummary';
import { resolveSessionAgentActivityPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import type { AgentActivityEntry } from '@/sync/domains/session/agentActivity';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

const stylesheet = StyleSheet.create((theme) => ({
    card: {
        gap: theme.space.s12,
        padding: 14,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
}));

export const SessionSubagentOverviewCard = React.memo((props: Readonly<{
    subagent: SessionSubagent;
    entry: AgentActivityEntry;
}>) => {
    const styles = stylesheet;
    const presentation = React.useMemo(
        () => resolveSessionAgentActivityPresentation({ entry: props.entry, subagent: props.subagent }),
        [props.entry, props.subagent],
    );

    return (
        <View style={styles.card}>
            <SessionAgentActivitySummary presentation={presentation} testID="session-subagent-overview" />
        </View>
    );
});
