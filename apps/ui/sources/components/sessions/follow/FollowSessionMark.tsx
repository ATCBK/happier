import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';

/** The Session's identity mark in the Follow panel's header (its Agent), or nothing before its metadata is known. */
export function FollowSessionMark(props: Readonly<{ metadata: unknown; serverId: string }>) {
    const { theme } = useUnistyles();
    const agentId = props.metadata ? resolveAgentIdFromSessionMetadata(props.metadata as never) : null;
    if (!agentId) return null;
    return <SessionAgentCatalogIdentityIcon agentId={agentId} machineId={resolveSessionMachineId(props.metadata)}
        serverId={props.serverId} color={theme.colors.text.primary} size={ICON_SIZE.md} />;
}
