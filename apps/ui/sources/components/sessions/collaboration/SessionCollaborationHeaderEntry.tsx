import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { SESSION_HEADER_ICON_SIZE_PX, SESSION_HEADER_ACTION_SIZE_PX } from '@/components/sessions/actions/sessionHeaderIconMetrics';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSessionHumanPresence } from '@/sync/domains/session/humanPresence/useSessionHumanPresence';
import { t } from '@/text';
import { SessionViewerFacepile } from './SessionViewerFacepile';
import { useSessionConversationAttentionReason } from './sessionConversationAttention';

const styles = StyleSheet.create(() => ({
    attentionFrame: { position: 'relative' },
    attentionMarker: {
        position: 'absolute',
        top: 4,
        right: 4,
        zIndex: 1,
    },
}));

export function useSessionCollaborationHasNamedViewers(target: SessionAddress | null): boolean {
    const presence = useSessionHumanPresence(target);
    return (presence.status === 'live' || presence.status === 'stale')
        && presence.viewers.length > 0;
}

export function resolveSessionCollaborationHeaderPlacement(input: Readonly<{
    compact: boolean;
    hasNamedViewers: boolean;
}>): Readonly<{ direct: boolean; overflow: boolean }> {
    if (!input.compact || input.hasNamedViewers) return { direct: true, overflow: false };
    return { direct: false, overflow: true };
}

/**
 * No unread *count* reaches this client: the server collapses the discussion
 * attention facts into booleans before they become `viewer.attention`
 * (`session/personal/discussionFacts.ts`), so the count-shaped copy belongs to the
 * conversation rows that carry real per-conversation counts, not to this header.
 */
export function useSessionCollaborationAttentionLabel(target: SessionAddress | null): string | null {
    const reason = useSessionConversationAttentionReason(target);
    if (reason === null) return null;
    return reason === 'mentioned'
        ? t('session.collaboration.discussion.mentioned')
        : t('session.collaboration.discussion.unreadConversations');
}

export function useSessionCollaborationHeaderState(
    target: SessionAddress | null,
    compact: boolean,
): Readonly<{ attentionLabel: string | null; direct: boolean; overflow: boolean }> {
    const attentionLabel = useSessionCollaborationAttentionLabel(target);
    const hasNamedViewers = useSessionCollaborationHasNamedViewers(target);
    const placement = resolveSessionCollaborationHeaderPlacement({ compact, hasNamedViewers });
    return { attentionLabel, ...placement };
}

export function createSessionCollaborationHeaderMenuItem(input: Readonly<{
    iconColor: string;
    attentionColor: string;
    attentionLabel: string | null;
}>): DropdownMenuItem {
    const title = t('session.collaboration.title');
    return {
        id: 'header.openCollaboration',
        title,
        accessibilityLabel: input.attentionLabel === null
            ? title
            : `${title}. ${input.attentionLabel}`,
        icon: <Icon name="users" size={16} color={input.iconColor} />,
        rightElement: input.attentionLabel === null
            ? undefined
            : (
                <StatusDot
                    testID="session-collaboration-overflow-attention"
                    color={input.attentionColor}
                    size={7}
                />
            ),
    };
}

/** Kept outside the full header's cached projection so presence does not rerender the transcript shell. */
export function SessionCollaborationHeaderEntry({ target, compact = false, attentionLabel: providedAttentionLabel, hideWhenEmpty = false, onPress }: Readonly<{
    target: SessionAddress;
    compact?: boolean;
    attentionLabel?: string | null;
    hideWhenEmpty?: boolean;
    onPress: () => void;
}>) {
    const presence = useSessionHumanPresence(target);
    const observedAttentionLabel = useSessionCollaborationAttentionLabel(target);
    const attentionLabel = providedAttentionLabel === undefined
        ? observedAttentionLabel
        : providedAttentionLabel;
    const { theme } = useUnistyles();
    const marker = attentionLabel === null ? null : (
        <View style={styles.attentionMarker} pointerEvents="none">
            <StatusDot
                testID="session-collaboration-attention"
                color={theme.colors.text.link}
                size={7}
            />
        </View>
    );
    if ((presence.status === 'live' || presence.status === 'stale') && presence.viewers.length > 0) {
        return (
            <View style={styles.attentionFrame}>
                <SessionViewerFacepile
                    viewers={presence.viewers}
                    stale={presence.status === 'stale'}
                    attentionLabel={attentionLabel}
                    onPress={onPress}
                />
                {marker}
            </View>
        );
    }
    if (hideWhenEmpty || compact) return null;
    const label = attentionLabel === null
        ? t('session.collaboration.title')
        : `${t('session.collaboration.title')}. ${attentionLabel}`;
    return (
        <View style={styles.attentionFrame}>
            <IconButton testID="session-collaboration-header" iconName="users" variant="plain"
                size={SESSION_HEADER_ACTION_SIZE_PX} iconSize={SESSION_HEADER_ICON_SIZE_PX}
                minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                accessibilityLabel={label} tooltip={t('session.collaboration.open')} onPress={onPress} />
            {marker}
        </View>
    );
}
