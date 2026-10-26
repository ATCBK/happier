import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { DiscussionTextMessageContentV1Schema } from '@happier-dev/protocol';
import { useRouter, type Href } from 'expo-router';
import { approvalArtifactBodyMatchesHeaderV1, type ParsedApprovalArtifactBodyV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { isSessionDiscussionApprovalPublicationV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { ApprovalPromptChrome } from '@/components/tools/shell/approvals/ApprovalPromptChrome';
import { ApprovalInlineDecisionBar, ApprovalInlineFields, useInlineApprovalDecision } from '@/components/approvals/ApprovalInlineDecision';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { Text } from '@/components/ui/text/Text';
import { readApprovalArtifactTitleInput, useApprovalRequestTitle } from '@/components/approvals/approvalRequestTitle';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useArtifact, useSessionDisplayNameProjections } from '@/sync/store/hooks';
import { discussionWaitingSessionName } from './discussionSessionLabel';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';

/**
 * A private draft or request waiting on this viewer, decided in the Discussion thread the way a Session
 * decides its own: the shared inline decision core, with the request page one tap away. Null when the
 * request needs its own page (a specialized review, an unavailable approval) or its body is not loaded;
 * the Discussion's waiting line then leads to the page as before.
 */
export const DiscussionWaitingApprovalCard = React.memo(function DiscussionWaitingApprovalCard(props: Readonly<{
  approvalId: string;
  serverId: string;
  returnHref: string;
  /** Rendered when the request cannot be decided here. */
  fallback: React.ReactElement;
}>) {
  const artifact = useArtifact(props.approvalId);
  const parsed = React.useMemo(
    () => (artifact && typeof artifact.body === 'string'
      ? approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body) : null),
    [artifact],
  );
  const request = parsed?.family === 'built_in' && parsed.request.v === 2 && parsed.request.status === 'open' ? parsed.request : null;
  if (!artifact || !parsed || !request) return props.fallback;
  return <Card {...props} artifact={artifact} parsed={parsed as BuiltInApproval} request={request} />;
});

/** The answer a private draft would post, read from the request's reply content; null when it carries no text. */
function readDraftAnswerText(actionArgs: unknown): string | null {
  const content = typeof actionArgs === 'object' && actionArgs !== null && 'content' in actionArgs
    ? DiscussionTextMessageContentV1Schema.safeParse(actionArgs.content) : null;
  const text = content?.success
    ? content.data.parts.flatMap(part => part.t === 'text' ? [part.text] : []).join('').trim() : '';
  return text.length > 0 ? text : null;
}

type BuiltInApproval = Extract<ParsedApprovalArtifactBodyV1, { family: 'built_in' }>;

function Card(props: Readonly<{
  artifact: DecryptedArtifact;
  approvalId: string;
  parsed: BuiltInApproval;
  request: BuiltInApproval['request'];
  serverId: string;
  returnHref: string;
  fallback: React.ReactElement;
}>) {
  const router = useRouter();
  const phone = useDeviceType() === 'phone';
  const { artifact, request } = props;
  const sessionId = request.v === 2 ? request.executionOriginV1.sessionId ?? request.createdBy.sessionId ?? '' : '';
  const decision = useInlineApprovalDecision({ id: artifact.id, header: artifact.header ?? null }, request, sessionId, props.serverId);
  const titleInput = readApprovalArtifactTitleInput(artifact, props.parsed, [sessionId]);
  const requestTitle = useApprovalRequestTitle(titleInput, props.serverId).title;
  const draft = isSessionDiscussionApprovalPublicationV1(request);
  // Who is waiting leads the card (lab T2-A), as the list line names them; a request that names no one keeps the
  // Action's own title with the generic line.
  const waitingName = useSessionDisplayNameProjections(
    sessionId ? [{ serverId: props.serverId, sessionId }] : [], discussionWaitingSessionName)[0]?.trim() || null;
  const title = waitingName
    ? t(draft ? 'session.collaboration.discussion.home.draftWaitingNamed' : 'session.collaboration.discussion.home.approvalPendingNamed', { name: waitingName })
    : requestTitle;
  // A draft is read as the answer it would post; the Action's operands wait behind Details.
  const draftAnswer = draft ? readDraftAnswerText(request.actionArgs) : null;
  const openPage = React.useCallback(() => {
    router.push(buildApprovalHref(artifact.id, props.serverId, props.returnHref) as Href);
  }, [artifact.id, props.returnHref, props.serverId, router]);
  if (!decision.decidesHere) return props.fallback;
  return (
    <ApprovalPromptChrome
      testID="session-discussion-waiting-approval"
      title={title}
      subtitle={waitingName
        ? draft ? undefined : requestTitle
        : draft ? t('session.collaboration.discussion.home.draftWaiting') : t('session.collaboration.discussion.home.approvalPending')}
      subtitleNumberOfLines={2}
      tone="attention"
      footer={
        <View style={phone ? styles.stacked : undefined}>
          <ApprovalInlineDecisionBar
            decision={decision}
            testIDPrefix="session-discussion-waiting-approval"
            layout={phone ? 'stacked' : 'inline'}
            onOpenPage={openPage}
            openPageLabel={t('approvals.review')}
            approveLabel={draft ? t('session.collaboration.discussion.draftReview.post') : undefined}
            declineLabel={draft ? t('session.collaboration.discussion.draftReview.decline') : undefined}
          />
        </View>
      }
    >
      {draftAnswer !== null ? (
        <View style={styles.draft}>
          <Text testID="session-discussion-waiting-approval-draft" variant="reading" style={styles.answer} selectable>{draftAnswer}</Text>
          <Text variant="meta" style={styles.private}>{t('session.collaboration.discussion.draftReview.onlyYou')}</Text>
        </View>
      ) : null}
      <ApprovalInlineFields decision={decision} serverId={props.serverId} collapsed={phone || draftAnswer !== null} />
    </ApprovalPromptChrome>
  );
}

const styles = StyleSheet.create((theme) => ({
  stacked: { width: '100%' },
  draft: { gap: theme.space.s8, paddingBottom: theme.space.s8 },
  answer: { color: theme.colors.text.primary },
  private: { color: theme.colors.text.secondary },
}));
