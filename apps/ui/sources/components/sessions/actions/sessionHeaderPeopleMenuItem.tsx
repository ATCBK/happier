import * as React from 'react';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { useSessionConversationAttentionReason } from '@/components/sessions/collaboration/sessionConversationAttention';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { t } from '@/text';

/** The Session header ⋯ entry that opens People (with its access) while the right rail is not on screen. */
export const SESSION_HEADER_MENU_OPEN_PEOPLE_ID = 'header.openCollaboration';

/**
 * The conversation attention People carries, from the exact-Home canonical owner. No unread *count*
 * reaches this client: the server collapses discussion attention facts into booleans before they become
 * `viewer.attention`, so the count-shaped copy belongs to the conversation rows that carry real counts.
 */
export function useSessionPeopleAttentionLabel(target: SessionAddress | null): string | null {
    const reason = useSessionConversationAttentionReason(target);
    if (reason === null) return null;
    return reason === 'mentioned'
        ? t('session.collaboration.discussion.mentioned')
        : t('session.collaboration.discussion.unreadConversations');
}

export function createSessionPeopleMenuItem(input: Readonly<{
    iconColor: string;
    attentionColor: string;
    attentionLabel: string | null;
}>): DropdownMenuItem {
    const title = t('session.collaboration.title');
    return {
        id: SESSION_HEADER_MENU_OPEN_PEOPLE_ID,
        title,
        accessibilityLabel: input.attentionLabel === null ? title : `${title}. ${input.attentionLabel}`,
        icon: <Icon name="users" size={16} color={input.iconColor} />,
        rightElement: input.attentionLabel === null ? undefined : (
            <StatusDot testID="session-collaboration-overflow-attention" color={input.attentionColor} size={7} />
        ),
    };
}
