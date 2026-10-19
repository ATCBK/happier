import { useShallow } from 'zustand/react/shallow';
import { readSessionExplicitStopV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import type { SessionQuestionHandlerV1 } from '@happier-dev/protocol/sessions/permissions/v1';

import { useSessionSelector } from '@/sync/store/hooks';
import { useKnownAccountActor } from '@/components/account/useKnownAccountActor';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { resolveAskUserQuestionAnsweredByLabel, type AskUserQuestionHandler } from './askUserQuestionCardState';

/** Uses only the applied Home's already-authorized Account/profile projection. */
export function useAskUserQuestionAnsweredByLabel(answeredBy: SessionQuestionHandlerV1 | undefined, serverId: string | null): string | null {
  const session = useAskUserQuestionHandler(answeredBy, serverId);
  const { viewerScope, actor } = useKnownAccountActor(serverId, answeredBy?.kind === 'person' ? answeredBy.accountId : undefined);
  return resolveAskUserQuestionAnsweredByLabel({ answeredBy, serverId: viewerScope?.serverId ?? serverId, viewerScope, answeringAccountActor: actor,
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
