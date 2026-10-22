import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { useSetting } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionRowPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { getSessionAvatarId } from '@/utils/sessions/sessionUtils';

import { SessionAgentCatalogIdentityIcon } from '../presentation/SessionAgentCatalogIdentityIcon';

export type SessionListIdentityDisplay = 'avatar' | 'agentLogo' | 'none';

export function normalizeSessionListIdentityDisplay(value: unknown): SessionListIdentityDisplay {
    return value === 'agentLogo' || value === 'none' ? value : 'avatar';
}

/** The single reader/normalizer for the person's Session-list identity preference. */
export function useSessionListIdentityDisplay(): SessionListIdentityDisplay {
    return normalizeSessionListIdentityDisplay(useSetting('sessionListIdentityDisplay'));
}

/**
 * Canonical leading identity used by Session-list-shaped rows.
 * Consumers choose geometry, while avatar-vs-Agent-logo semantics stay here.
 */
export const SessionListIdentity = React.memo(function SessionListIdentity(props: Readonly<{
    session: Session | SessionListRenderableSession;
    display: SessionListIdentityDisplay;
    serverId: string | null;
    color: string;
    avatarSize: number;
    agentLogoSize: number;
    connected: boolean;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    if (props.display === 'none') return null;
    const notLive = props.session.active !== true || !props.connected;
    const metadata = 'agentState' in props.session
        ? readSessionOwnerMetadataView(props.session)
        : props.session.metadata;
    const agentId = readSessionRowPresentationAgentId(props.session);

    if (props.display === 'avatar') {
        return (
            <Avatar
                id={getSessionAvatarId(props.session, props.serverId)}
                size={props.avatarSize}
                monochrome={notLive}
                flavor={agentId}
                hasUnreadMessages={false}
            />
        );
    }

    return (
        <SessionAgentCatalogIdentityIcon
            agentId={agentId ?? ''}
            machineId={metadata?.machineId ?? null}
            serverId={props.serverId}
            // A logo is already a single tint, so the avatar's greyscale has no effect here:
            // a session that is not live takes the dimmer ink instead.
            color={notLive ? theme.colors.text.tertiary : props.color}
            size={props.agentLogoSize}
            testID={props.testID}
        />
    );
});
