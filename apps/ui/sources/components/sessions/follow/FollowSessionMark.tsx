import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { readSessionRowPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';

/** The Session's identity mark in the Follow panel's header (its Agent), or nothing before its metadata is known. */
export function FollowSessionMark(props: Readonly<{ session: Session | SessionListRenderableSession | null; serverId: string }>) {
    const { theme } = useUnistyles();
    const agentId = props.session ? readSessionRowPresentationAgentId(props.session) : null;
    const metadata = props.session && 'agentState' in props.session
        ? readSessionOwnerMetadataView(props.session)
        : props.session?.metadata;
    if (!agentId) return null;
    return <SessionAgentCatalogIdentityIcon agentId={agentId} machineId={resolveSessionMachineId(metadata)}
        serverId={props.serverId} color={theme.colors.text.primary} size={ICON_SIZE.md} />;
}
