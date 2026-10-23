import { useShallow } from 'zustand/react/shallow';
import type { SessionQuestionHandlerV1 } from '@happier-dev/protocol/sessions/permissions/v1';
import type { SessionQuestionContextV1 } from '@happier-dev/protocol/sessions/permissions/questionV1';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';

import { getStorage } from '@/sync/domains/state/storageStore';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { captureServerProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { selectHomeQualifiedSession } from '@/sync/domains/session/selectHomeQualifiedSession';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { readSessionWorkerQuestionHandlingProjection } from '@/sync/domains/session/listing/sessionListRenderable';
import { useKnownAccountActor } from '@/components/account/useKnownAccountActor';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveAskUserQuestionAnsweredByLabel, type AskUserQuestionHandler } from './askUserQuestionCardState';

/** Uses only the applied Home's already-authorized Account/profile projection. */
export function useAskUserQuestionAnsweredByLabel(answeredBy: SessionQuestionHandlerV1 | undefined, serverId: string | null): string | null {
  const session = useAskUserQuestionHandler(answeredBy, serverId);
  const { viewerScope, actor } = useKnownAccountActor(serverId, answeredBy?.kind === 'person' ? answeredBy.accountId : undefined);
  return resolveAskUserQuestionAnsweredByLabel({ answeredBy, serverId: viewerScope?.serverId ?? serverId, viewerScope, answeringAccountActor: actor,
    answeringSession: answeredBy?.kind === 'session' && session ? { sessionId: answeredBy.sessionId, name: session.name } : undefined });
}

/**
 * The question's manager as a name + reachability, using scoped row-local subscriptions.
 * A person-handled question can explain its stopped/offline manager through the existing relation;
 * that display read never changes the request's handler or makes a resumed manager its handler.
 */
export function useAskUserQuestionHandler(
  handler: SessionQuestionHandlerV1 | undefined,
  serverId: string | null,
  source?: Readonly<{ sessionId: string; questionV1: SessionQuestionContextV1 }>,
): AskUserQuestionHandler | null {
  const explainUnavailableManager = handler?.kind === 'person' && source?.questionV1.lasting === false;
  useServerProfilesGeneration();
  const resolveScopeId = captureServerProfileScopeResolver();
  const activeServerId = useActiveServerSnapshot(Boolean(serverId)).serverId;
  return getStorage()(useShallow((state): AskUserQuestionHandler | null => {
    if (!serverId) return null;
    const sourceSession = explainUnavailableManager
      ? readSessionListRowForServerId(state.sessionListRowsByServerId, serverId, source.sessionId, resolveScopeId)
        ?? selectHomeQualifiedSession(state, source.sessionId, serverId, activeServerId)
      : null;
    const handlerSessionId = handler?.kind === 'session' ? handler.sessionId : readSessionManagerSessionIdV1(sourceSession);
    if (!handlerSessionId) return null;
    const row = readSessionListRowForServerId(state.sessionListRowsByServerId, serverId, handlerSessionId, resolveScopeId);
    const liveSession = row ? null : selectHomeQualifiedSession(state, handlerSessionId, serverId, activeServerId);
    const session = row ?? liveSession;
    if (!session) return null;
    const handling = row?.workerQuestionHandling
      ?? (liveSession ? readSessionWorkerQuestionHandlingProjection(readSessionOwnerMetadataView(liveSession)) : null);
    const availability = handling?.explicitlyStopped ? 'stopped' : session.presence === 'online' ? 'online' : 'offline';
    if (explainUnavailableManager && (!handling?.answersWorkerQuestions || availability === 'online')) return null;
    return { name: getSessionName(session, serverId), availability };
  }));
}
