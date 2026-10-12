import * as React from 'react';

import { filterUserFacingMachineDetailSessions } from '@/components/machines/machineDetailSessionQueries';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSessions } from '@/sync/domains/state/storage';
import { readDisplayMachineIdForSession } from '@/sync/ops/sessionMachineTarget';
import { t } from '@/text';
import { getSessionName, getSessionSubtitle } from '@/utils/sessions/sessionUtils';

/** The five most recent sessions on this machine (Project work); absent when it has none. */
export const MachineRecentSessionsSection = React.memo(function MachineRecentSessionsSection(props: Readonly<{
    machineId: string;
    serverId: string;
}>) {
    const sessions = useSessions();
    const navigateToSession = useNavigateToSession();
    const recent = React.useMemo(() => {
        if (!sessions || !props.machineId) return [];
        return filterUserFacingMachineDetailSessions(sessions)
            .filter((session) => readDisplayMachineIdForSession({
                sessionId: session.id,
                metadata: readSessionOwnerMetadataView(session),
            }) === props.machineId)
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .slice(0, 5);
    }, [props.machineId, sessions]);

    if (recent.length === 0) return null;
    return (
        <ItemGroup title={t('machineDetailPage.recentSessionsTitle')} description={t('machineDetailPage.recentSessionsDescription')}>
            {recent.map((session) => (
                <Item
                    key={session.id}
                    title={getSessionName(session, props.serverId)}
                    icon={<Icon name="chat-circle-dots" />}
                    subtitle={getSessionSubtitle(session, props.serverId)}
                    onPress={() => navigateToSession(session.id, { serverId: props.serverId })}
                    showChevron
                />
            ))}
        </ItemGroup>
    );
});
