import * as React from 'react';
import type { ApprovalRequesterConfirmationV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useKnownAccountActor } from '@/components/account/useKnownAccountActor';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

/**
 * Whether the viewer is the one person who may decide a shared Bot's requester-bound request. An
 * unknown viewer is never entitled; the decision owner re-admits the present person regardless.
 */
export function isApprovalRequesterViewer(
  subject: ApprovalRequesterConfirmationV1 | null | undefined,
  /** The viewer's scope as resolved for the Home that asked (aliases already applied). */
  viewerScope: ServerAccountScope | null,
): boolean {
  return Boolean(subject && viewerScope && viewerScope.accountId === subject.requesterAccountId);
}

/** The viewer's own scope on the Home that asked; the page uses it to offer or withhold Confirm. */
export function useApprovalRequesterViewer(
  subject: ApprovalRequesterConfirmationV1 | null | undefined,
): boolean {
  const { viewerScope } = useKnownAccountActor(
    subject?.personaSessionRef.serverId ?? null,
    null,
  );
  return isApprovalRequesterViewer(subject, viewerScope);
}

/** One Account named as this viewer may see it: You, a known name, or a generic person. Never guessed. */
export function useApprovalAccountLabel(
  serverId: string,
  accountId: string | undefined,
  /** The viewer named inside a sentence ("confirmed by you") instead of as a row value ("You"). */
  form: 'value' | 'sentence' = 'value',
): string | null {
  const { viewerScope, actor } = useKnownAccountActor(serverId, accountId);
  if (!accountId) return null;
  if (viewerScope?.accountId === accountId) {
    return form === 'sentence' ? t('session.collaboration.discussion.attribution.you') : t('message.accountActorYou');
  }
  return actor
    ? resolveAccountActorPresentation(actor, viewerScope).name
    : form === 'sentence'
      ? t('session.collaboration.discussion.attribution.anotherPerson')
      : t('detailPages.approval.requester.anotherPerson');
}

/**
 * C7 requester confirmation, layered into the approval page: who asked (the only person who may
 * confirm), whose setup the Bot writes with, and, once decided, who decided. The page's decision bar
 * is offered only to the requester; everyone else reads who can act here instead of a button.
 */
export const ApprovalRequesterConfirmationSection = React.memo(
  function ApprovalRequesterConfirmationSection(
    props: Readonly<{
      subject: ApprovalRequesterConfirmationV1;
      open: boolean;
      decision: Readonly<{
        kind: 'approve' | 'reject';
        decidingAccountId?: string;
      }> | null;
    }>,
  ) {
    const serverId = props.subject.personaSessionRef.serverId;
    const entitled = useApprovalRequesterViewer(props.subject);
    const requester = useApprovalAccountLabel(
      serverId,
      props.subject.requesterAccountId,
    );
    const executor = useApprovalAccountLabel(
      serverId,
      props.subject.executionAccountId,
    );
    const decider = useApprovalAccountLabel(
      serverId,
      props.decision?.decidingAccountId,
    );
    const requesterName =
      requester ?? t('detailPages.approval.requester.anotherPerson');
    const description = !props.open
      ? undefined
      : entitled
        ? t('detailPages.approval.requester.descriptionYou')
        : t('detailPages.approval.requester.descriptionOther', {
            name: requesterName,
          });

    return (
      <ItemGroup
        testID="approvals.requester-confirmation"
        title={t('detailPages.approval.requester.title')}
        description={description}
      >
        <Item
          testID="approvals.requester-confirmation.asked-by"
          title={t('detailPages.approval.requester.askedBy')}
          detail={requesterName}
          mode="info"
          showChevron={false}
        />
        <Item
          testID="approvals.requester-confirmation.writes-with"
          title={t('detailPages.approval.requester.writesWith')}
          detail={
            executor
              ? t('detailPages.approval.requester.setupOf', { name: executor })
              : t('detailPages.approval.requester.anotherPerson')
          }
          mode="info"
          showChevron={false}
        />
        {props.decision && decider ? (
          <Item
            testID="approvals.requester-confirmation.decided-by"
            title={
              props.decision.kind === 'approve'
                ? t('detailPages.approval.requester.confirmedBy')
                : t('detailPages.approval.requester.declinedBy')
            }
            detail={decider}
            mode="info"
            showChevron={false}
          />
        ) : props.open && !entitled ? (
          <Item
            testID="approvals.requester-confirmation.waiting"
            title={t('detailPages.approval.requester.waitingFor', {
              name: requesterName,
            })}
            mode="info"
            showChevron={false}
          />
        ) : null}
      </ItemGroup>
    );
  },
);
