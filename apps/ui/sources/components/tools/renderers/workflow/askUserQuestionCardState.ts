import type { SessionQuestionContextV1 } from '@happier-dev/protocol/sessions/permissions/questionV1';
import type { SessionQuestionHandlerV1 } from '@happier-dev/protocol/sessions/permissions/v1';
import type { ToolCall, TranscriptAccountActor } from '@happier-dev/session-core/messages';
import type { AgentState } from '@happier-dev/session-core/state';

import { t } from '@/text';
import { resolvePermissionRequestId } from '@/components/tools/renderers/core/resolvePermissionRequestId';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** Answer identity is a separate, host-stamped actor, never the worker's requester. */
export function resolveAskUserQuestionAnsweredByLabel(input: Readonly<{
  answeredBy: SessionQuestionHandlerV1 | null | undefined;
  answeringSession?: Readonly<{ sessionId: string; name: string | null }>;
  serverId?: string | null;
  viewerScope?: ServerAccountScope | null;
  answeringAccountActor?: TranscriptAccountActor | null;
}>): string | null {
  const { answeredBy } = input;
  if (answeredBy?.kind === 'session') {
    const name = input.answeringSession?.sessionId === answeredBy.sessionId ? input.answeringSession.name?.trim() : null;
    return t('workflows.run.answeredBy', { name: name || t('message.provenanceSession') });
  }
  if (answeredBy?.kind !== 'person') return null;
  const scope = answeredBy.accountId && input.serverId ? { serverId: input.serverId, accountId: answeredBy.accountId } : null;
  const actor = areServerAccountScopesEqual(scope, input.answeringAccountActor) ? input.answeringAccountActor : null;
  if (actor) {
    const presentation = resolveAccountActorPresentation(actor, input.viewerScope ?? null);
    return presentation.isSelf && actor.profile !== null
      ? t('workflows.run.answeredByYou')
      : t('workflows.run.answeredBy', { name: presentation.name });
  }
  if (areServerAccountScopesEqual(scope, input.viewerScope)) return t('workflows.run.answeredByYou');
  return t('workflows.run.answeredByPerson');
}

/** The handling manager as the card may show it: a display name and its current reachability. */
export type AskUserQuestionHandler = Readonly<{
  name: string;
  availability: 'online' | 'offline' | 'stopped';
}>;

export type AskUserQuestionLead =
  | Readonly<{ kind: 'not_blocking'; assumption: string }>
  | Readonly<{
      kind: 'handler';
      name: string;
      away: 'offline' | 'stopped' | null;
    }>;

/**
 * The one line above the questions. A manager handling the question speaks first (quietly while it can
 * answer, as the person's turn when it cannot); otherwise a non-blocking question names the assumption the
 * agent is acting on. An ordinary waiting question needs no line: the card itself is the request.
 */
export function resolveAskUserQuestionLead(
  input: Readonly<{
    questionV1: SessionQuestionContextV1 | undefined;
    handler: AskUserQuestionHandler | null;
  }>,
): AskUserQuestionLead | null {
  if (input.handler) {
    return {
      kind: 'handler',
      name: input.handler.name,
      away:
        input.handler.availability === 'online'
          ? null
          : input.handler.availability,
    };
  }
  if (input.questionV1?.mode === 'continue' && input.questionV1.assumption) {
    return { kind: 'not_blocking', assumption: input.questionV1.assumption };
  }
  return null;
}

export type AskUserQuestionFooterHint =
  | Readonly<{ kind: 'progress'; answered: number; total: number }>
  | Readonly<{ kind: 'starts_next_turn' }>
  | Readonly<{ kind: 'next_step' }>;

/** Progress while a multi-question form is incomplete, then the consequence of answering. */
export function resolveAskUserQuestionFooterHint(
  input: Readonly<{
    mode: SessionQuestionContextV1['mode'] | undefined;
    total: number;
    answered: number;
  }>,
): AskUserQuestionFooterHint {
  if (input.total > 1 && input.answered < input.total) {
    return { kind: 'progress', answered: input.answered, total: input.total };
  }
  return input.mode === 'continue'
    ? { kind: 'next_step' }
    : { kind: 'starts_next_turn' };
}

/**
 * Whether a manager Session handles this question or answered it. Its asker is then a different Session
 * than the one that settles it, so a page that shows only the question names the asker. A person's own
 * question is the Session the page already belongs to and needs no name.
 */
export function isQuestionRoutedToManager(
  input: Readonly<{ tool: ToolCall; agentState: AgentState | null | undefined }>,
): boolean {
  if (input.tool.permission?.answeredBy?.kind === 'session') return true;
  const requestId = resolvePermissionRequestId(input.tool);
  if (!requestId) return false;
  const request = input.agentState?.requests?.[requestId] ?? input.agentState?.completedRequests?.[requestId];
  return request?.currentHandler?.kind === 'session';
}
