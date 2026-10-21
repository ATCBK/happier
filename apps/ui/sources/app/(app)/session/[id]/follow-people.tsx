import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import * as React from 'react';
import { Stack, useLocalSearchParams, useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';

import {
    SessionPeopleFollowSheet,
    useSessionPeopleFollow,
    type SessionPeopleFollowDirection,
} from '@/components/sessions/collaboration/SessionPeopleFollowSections';
import { SessionFollowUnavailableNotice } from '@/components/sessions/follow/SessionFollowUnavailableNotice';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { buildScopedSessionRouteHref, readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSession } from '@/sync/store/hooks';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

function readDirection(value: string | string[] | undefined): SessionPeopleFollowDirection | null {
    const direction = Array.isArray(value) ? value[0] : value;
    return direction === 'followers' || direction === 'following' ? direction : null;
}

/**
 * People's Follow sheet as a page, where a phone pushes it from a Followers or Following summary row (C1 §6.1).
 * It is the same `SessionPeopleFollowSheet` the wide pane floats; its rows push their own Follow pages.
 */
export function SessionFollowPeopleScreen() {
    const params = useLocalSearchParams<{ id?: string | string[]; serverId?: string | string[]; direction?: string | string[] }>();
    const router = useRouter();
    const sessionId = normalizeSessionId(params.id);
    const serverId = readSessionRouteServerId(params);
    const direction = readDirection(params.direction);
    const target = React.useMemo(() => ({ serverId: serverId ?? '', sessionId: sessionId ?? '' }), [serverId, sessionId]);
    const people = useSessionPeopleFollow(target);
    const session = useSession(sessionId ?? '', serverId);
    const back = React.useCallback(() => {
        if (!sessionId || !serverId) return;
        safeRouterBack({ router, fallbackHref: buildScopedSessionRouteHref({ sessionId, serverId }) as Href });
    }, [router, serverId, sessionId]);
    if (!sessionId || !serverId || !direction) return <SessionInvalidLinkFallback />;
    const title = direction === 'followers' ? t('session.collaboration.pane.followersTitle') : t('session.follow.sources.title');
    const header = <Stack.Screen options={{ headerShown: true, title }} />;
    if (!people.enabled) return <>{header}<SessionFollowUnavailableNotice onBack={back} /></>;
    return <>
        {header}
        <SessionPeopleFollowSheet target={target} direction={direction} people={people}
            machineId={session ? (readSessionOwnerMetadataView(session)?.machineId ?? null) : null}
            host={{ kind: 'page', onClose: back }} />
    </>;
}

export { SessionFollowPeopleScreen as WorkspaceRouteBody };

export default function RouteEntry() { return <WorkspaceRouteEntry Body={SessionFollowPeopleScreen} />; }
