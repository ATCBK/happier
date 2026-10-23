import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useServerRetentionPolicy } from '@/hooks/server/useServerRetentionPolicy';
import { formatSessionRetentionSummary } from '@/sync/domains/server/retention/formatServerRetentionPolicy';
import { normalizeServerRetentionPolicy } from '@/sync/domains/server/retention/serverRetentionPolicy';
import { storage } from '@/sync/domains/state/storage';
import { resolveSessionListLookupSessionServerId } from '@/sync/domains/session/listing/sessionListLookupState';
import { t } from '@/text';

type SessionRetentionNoticeProps = Readonly<{
    sessionId: string;
}>;

/**
 * What this Home does with inactive Sessions, as one sentence, or null while the policy is unread or
 * keeps them. Session Info folds it into Leave's description, for the exact Home it was given.
 */
export function useSessionRetentionSummary(serverId: string | null): string | null {
    const retention = useServerRetentionPolicy(serverId);
    // A notice about deletion is shown only from a policy that answered, never while it is being read.
    const policy = retention.status === 'ready' ? retention.policy : null;
    const sessionsPolicy = policy
        ? normalizeServerRetentionPolicy(policy).domains.find((domain) => domain.id === 'sessions')?.policy
        : null;
    if (!serverId || !policy || sessionsPolicy?.mode !== 'delete_inactive') return null;
    return formatSessionRetentionSummary(policy) ?? null;
}

export function SessionRetentionNotice(props: SessionRetentionNoticeProps) {
    const { theme } = useUnistyles();
    const serverId = resolveSessionListLookupSessionServerId(storage.getState(), props.sessionId);
    const summary = useSessionRetentionSummary(serverId);
    if (!summary) {
        return null;
    }

    return (
        <ItemGroup title={t('server.retention.title')}>
            <Item
                testID="session-retention-notice"
                title={t('server.retention.sessions')}
                subtitle={summary}
                icon={(
                    <Icon
                        testID="session-retention-notice-icon"
                        name="clock-counter-clockwise"
                        color={theme.colors.text.secondary}
                    />
                )}
                mode="info"
                showChevron={false}
            />
        </ItemGroup>
    );
}
