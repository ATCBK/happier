import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import * as React from 'react';
import { Stack, useLocalSearchParams, useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';

import { FollowEditorPage } from '@/components/sessions/follow/FollowEditorPage';
import { SessionFollowSourcesEditor } from '@/components/sessions/follow/SessionFollowSourcesEditor';
import { SessionFollowUnavailableNotice } from '@/components/sessions/follow/SessionFollowUnavailableNotice';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { buildScopedSessionRouteHref, readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSession } from '@/sync/store/hooks';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

/**
 * A Session source's Follow panel as a page, where a phone pushes it from the People pane (lab P2-Sp). It is the same
 * `SessionFollowSourcesEditor` the pane mounts, placing one source's panel through the shared Follow page.
 */
export function SessionFollowSourceScreen() {
    const params = useLocalSearchParams<{ id?: string | string[]; serverId?: string | string[]; source?: string | string[] }>();
    const router = useRouter();
    const sessionId = normalizeSessionId(params.id);
    const serverId = readSessionRouteServerId(params);
    // A Session source's id, or another source kind's qualified key (`followSourceKey`).
    const sourceKey = normalizeSessionId(params.source);
    const enabled = useFeatureEnabled('sessions.following', { scopeKind: 'spawn', serverId: serverId ?? '' });
    const session = useSession(sessionId ?? '', serverId);
    const back = React.useCallback(() => {
        if (!sessionId || !serverId) return;
        safeRouterBack({ router, fallbackHref: buildScopedSessionRouteHref({ sessionId, serverId }) as Href });
    }, [router, serverId, sessionId]);
    if (!sessionId || !serverId || !sourceKey) return <SessionInvalidLinkFallback />;
    const header = <Stack.Screen options={{ headerShown: true, title: t('session.follow.sources.title') }} />;
    if (!enabled) return <>{header}<SessionFollowUnavailableNotice onBack={back} /></>;
    return <>
        {header}
        <SessionFollowSourcesEditor
            destination={{ id: sessionId }}
            serverId={serverId}
            destinationMachineId={session ? (readSessionOwnerMetadataView(session)?.machineId ?? null) : null}
            page={{
                sourceKey,
                onClose: back,
                frame: (parts) => <FollowEditorPage title={parts.title} subtitle={parts.subtitle} footer={parts.footer}
                    footerTestID="session-follow-source-footer">{parts.body}</FollowEditorPage>,
            }}
        />
    </>;
}

export { SessionFollowSourceScreen as WorkspaceRouteBody };

export default function RouteEntry() { return <WorkspaceRouteEntry Body={SessionFollowSourceScreen} />; }
