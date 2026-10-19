import { useShallow } from 'zustand/react/shallow';
import { readSessionExplicitStopV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import type { SessionQuestionHandlerV1 } from '@happier-dev/protocol/sessions/permissions/v1';
import { qualifyTranscriptAccountActor } from '@happier-dev/session-core/messages';

import { useActiveServerAccountScope, useSessionSelector, useUser } from '@/sync/store/hooks';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { resolveAskUserQuestionAnsweredByLabel, type AskUserQuestionHandler } from './askUserQuestionCardState';

/** Uses only the applied Home's already-authorized Account/profile projection. */
export function useAskUserQuestionAnsweredByLabel(answeredBy: SessionQuestionHandlerV1 | undefined, serverId: string | null): string | null {
  const session = useAskUserQuestionHandler(answeredBy, serverId);
  const viewerScope = useActiveServerAccountScope(serverId);
  const profileScope = useActiveServerAccountScope();
  // The scope owner has verified local aliases against the applied canonical Home.
  const qualifiedServerId = viewerScope?.serverId ?? serverId;
  const accountId = answeredBy?.kind === 'person' ? answeredBy.accountId : undefined;
  const profile = useUser(accountId);
  const actor = accountId && qualifiedServerId && profile?.id === accountId && areServerAccountScopesEqual(viewerScope, profileScope)
    ? qualifyTranscriptAccountActor({ v: 1, accountId, profile: {
        name: profile.name, firstName: profile.firstName, lastName: profile.lastName, username: profile.username, avatarUrl: null,
      } }, qualifiedServerId) : null;
  return resolveAskUserQuestionAnsweredByLabel({ answeredBy, serverId: qualifiedServerId, viewerScope, answeringAccountActor: actor,
    answeringSession: answeredBy?.kind === 'session' && session ? { sessionId: answeredBy.sessionId, name: session.name } : undefined });
}

/**
 * The manager currently handling a question, as name + reachability. Subscribes to that one Session only
 * and returns null for a person-handled question or a manager this viewer cannot read.
 */
export function useAskUserQuestionHandler(
  handler: SessionQuestionHandlerV1 | undefined,
  serverId: string | null,
): AskUserQuestionHandler | null {
  const handlerSessionId = handler?.kind === 'session' ? handler.sessionId : '';
  const projection = useSessionSelector(
    handlerSessionId,
    serverId,
    useShallow((session) => {
      if (!handlerSessionId || !session)
        return { name: null, availability: null };
      const stop = readSessionExplicitStopV1FromMetadata(session.metadata);
      return {
        name: getSessionName(session, serverId),
        availability:
          stop && !('status' in stop)
            ? ('stopped' as const)
            : session.presence === 'online'
              ? ('online' as const)
              : ('offline' as const),
      };
    }),
  );
  if (!projection.name || !projection.availability) return null;
  return { name: projection.name, availability: projection.availability };
}
