import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';

import { SessionAgentActivitySummary } from '@/components/sessions/agents/presentation/SessionAgentActivitySummary';
import { resolveSessionAgentActivityPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import type { AgentActivityEntry } from '@/sync/domains/session/agentActivity';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { motionTokens } from '@/components/ui/motion/motionTokens';

const stylesheet = StyleSheet.create((theme) => ({
    reference: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        maxWidth: 520,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s10,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.subtle,
        backgroundColor: theme.colors.surface.base,
    },
    summary: {
        flex: 1,
        minWidth: 0,
    },
    referencePressed: {
        opacity: motionTokens.press.opacity,
    },
}));

/**
 * Conversation geometry around the shared Agent-activity identity leaf (Lane 05).
 *
 * Deliberately owns no Run state or presentation rules: the canonical merged entry and shared
 * resolver supply both, while the Discussion host supplies only placement and navigation.
 */
export const DiscussionAgentActivityReference = React.memo((props: Readonly<{
    entry: AgentActivityEntry;
    /** `null` for a headline-only entry the local sources have not paged in. */
    subagent: SessionSubagent | null;
    onPress: () => void;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const presentation = React.useMemo(() => resolveSessionAgentActivityPresentation({
        entry: props.entry,
        subagent: props.subagent,
    }), [props.entry, props.subagent]);
    const runId = props.entry.runId ?? props.subagent?.runRef?.runId ?? props.subagent?.id ?? props.entry.id;

    return (
        <Pressable
            testID={`session-discussion-agent-activity:${runId}`}
            accessibilityRole="button"
            accessibilityLabel={presentation.accessibilityLabel}
            onPress={props.onPress}
            style={({ pressed }) => [styles.reference, pressed ? styles.referencePressed : null]}
        >
            <View style={styles.summary}>
                <SessionAgentActivitySummary
                    testID={`session-discussion-agent-activity-summary:${runId}`}
                    presentation={presentation}
                />
            </View>
            <Icon name="caret-right" size={16} color={theme.colors.text.tertiary} />
        </Pressable>
    );
});
