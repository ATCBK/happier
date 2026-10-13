import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { resolveHappierDisclosureFrameStyle } from '@happier-dev/plugin-ui/presentation';

import type { SessionAgentActivityRow } from '@/components/sessions/agents/presentation/sessionAgentActivityRows';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import { SessionAgentPendingPrompts } from './SessionAgentPendingPrompts';
import { SessionSubagentRow } from './SessionSubagentRow';

/**
 * A row that waits on a person, opening in place into what it is asking for (agents lab SG, the
 * Agents pane's signature moment): the approval with its command and Allow / Deny, or the question
 * with its choices and an answer. Answered, the prompt resolves, the row leaves Needs you and the
 * card closes with it.
 *
 * The card follows its content (lab defect fixed): the disclosure body is released to its natural
 * height once revealed, and nothing here pins a height, so the prompt's actions are never clipped.
 */

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        // The prompt aligns with the row's text column: past the mark and its gap.
        paddingLeft: 38,
        paddingRight: theme.space.s4,
        paddingBottom: theme.space.s10,
        gap: theme.space.s4,
    },
    openLink: {
        alignSelf: 'flex-start',
        paddingVertical: theme.space.s6,
        paddingHorizontal: theme.space.s10,
        borderRadius: 8,
    },
    openLinkText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta', 'semiBold'),
    },
}));

export const SessionAgentNeedsYouItem = React.memo((props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    session: Session | null;
    row: SessionAgentActivityRow;
    activityPreview?: string | null;
    originLabel?: string | null;
    sessionAgentId?: string | null;
    expanded: boolean;
    onToggle: (subagentId: string) => void;
    onOpen: (subagent: SessionSubagent) => void;
    onOpenFull: (() => void) | null;
    onOpenAdvanced: (() => void) | null;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { subagent } = props.row;
    const { onToggle, onOpen } = props;
    const toggle = React.useCallback(() => onToggle(subagent.id), [onToggle, subagent.id]);
    const open = React.useCallback(() => onOpen(subagent), [onOpen, subagent]);

    const openLink = (
        <Pressable
            testID={`session-subagent-open:${subagent.id}`}
            accessibilityRole="button"
            accessibilityLabel={t('sessionAgentActivity.roster.openWork')}
            onPress={open}
            style={({ pressed }) => [styles.openLink, { opacity: pressed ? motionTokens.press.opacity : 1 }]}
        >
            <Text style={styles.openLinkText}>{t('sessionAgentActivity.roster.openWork')}</Text>
        </Pressable>
    );

    return (
        <View testID={`session-subagent-needs-you:${subagent.id}`} style={resolveHappierDisclosureFrameStyle({
            expanded: props.expanded,
            borderColor: theme.colors.state.warning.border,
            backgroundColor: theme.colors.surface.elevated,
            shadowColor: theme.colors.shadow.color,
        })}>
            <ExpandableItem
                testID={`session-subagent-disclosure:${subagent.id}`}
                expanded={props.expanded}
                onExpandedChange={toggle}
                showDivider={false}
                header={(
                    <SessionSubagentRow
                        sessionId={props.sessionId}
                        serverId={props.serverId}
                        row={props.row}
                        activityPreview={props.activityPreview}
                        originLabel={props.originLabel}
                        sessionAgentId={props.sessionAgentId}
                        expanded={props.expanded}
                        onPress={toggle}
                        onOpenFull={props.onOpenFull}
                        onOpenAdvanced={props.onOpenAdvanced}
                    />
                )}
            >
                <View style={styles.body}>
                    <SessionAgentPendingPrompts
                        sessionId={props.sessionId}
                        serverId={props.serverId}
                        session={props.session}
                        subagent={subagent}
                        fallback={null}
                    />
                    {openLink}
                </View>
            </ExpandableItem>
        </View>
    );
});
