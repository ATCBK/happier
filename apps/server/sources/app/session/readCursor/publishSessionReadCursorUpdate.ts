import type { SessionViewerProjectionV1 } from '@happier-dev/protocol/sessions/personal/viewer';
import { scheduleAccountActivityBadgeRefresh } from "@/app/activity/refreshAccountActivityBadgePushes";
import { buildUpdateSessionUpdate, eventRouter, type ClientConnection } from "@/app/events/eventRouter";
import { loadSessionViewerProjection } from "@/app/session/personal/projection";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";

/** Publishes one Account's private frontier to that Account's devices only. */
export async function publishSessionReadCursorUpdate(params: Readonly<{
    sessionId: string;
    accountId: string;
    actorChangeCursor: number | null;
    lastViewedSessionSeq: number | null;
    didChange: boolean;
    authentication: SessionAccessAuthentication;
    skipSenderConnection?: ClientConnection;
}>): Promise<SessionViewerProjectionV1 | null> {
    const viewer = await loadSessionViewerProjection({ accountId: params.accountId, sessionId: params.sessionId, authentication: params.authentication });
    if (!viewer) return null;
    if (params.didChange && params.actorChangeCursor !== null) {
        const payload = buildUpdateSessionUpdate(
            params.sessionId,
            params.actorChangeCursor,
            randomKeyNaked(12),
            undefined,
            undefined,
            {
                ...(viewer.readState.state === "tracking"
                    ? { lastViewedSessionSeq: viewer.readState.lastViewedSessionSeq }
                    : {}),
                viewer,
            },
        );
        eventRouter.emitUpdate({
            userId: params.accountId,
            payload,
            recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
            ...(params.skipSenderConnection ? { skipSenderConnection: params.skipSenderConnection } : {}),
        });
        scheduleAccountActivityBadgeRefresh({ badgeAttentionChanged: true, accountIds: [params.accountId] });
    }
    return viewer;
}
