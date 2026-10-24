import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierThreadMessage } from '@happier-dev/plugin-ui/components';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';

import { DiscussionMessageContent } from '@/components/discussions/DiscussionMessageContent';
import { resolveDiscussionMessageAuthorLabel } from '@/components/discussions/discussionTimelineProjection';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';

import type { ArtifactActionsClient } from './artifactActionsClient';
import { ArtifactEditProposal, type AdmittedDocRead } from './ArtifactEditProposal';
import { readDocPassageThreadQuote, type DocPassageMarginThread } from './docPassageMargin';

const NO_SESSION_LABEL = () => null;

/**
 * One passage thread beside its passage in the Doc (C5 lab K1-A/R/ST): the passage it is about, the
 * comment that started it in the Discussion's own message anatomy, the latest reply as one line, and
 * the thread's suggested edit — its card while open, its one-line receipt (with Undo) once decided.
 * A passage that changed keeps its old quote and leads to the revision it was written against.
 */
export function ArtifactPassageThreadCard(
  props: Readonly<{
    thread: DocPassageMarginThread<DiscussionOpenedMessageV1>;
    focused: boolean;
    /** This thread is being re-attached: the Doc is waiting for the text it now belongs to. */
    attaching: boolean;
    client: ArtifactActionsClient;
    docRead: AdmittedDocRead;
    mountThread: (discussionId: string) => () => void;
    viewerAccountId: string;
    onFocus: () => void;
    onOpen: () => void;
    onOpenHistory: (compareFromBodyVersion: number) => void;
    onReattach: () => void;
    onCancelReattach: () => void;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const { thread } = props;
  React.useEffect(() => props.mountThread(thread.discussionId), [props.mountThread, thread.discussionId]);
  const labels = React.useMemo(
    () =>
      new Map(
        [thread.root, ...thread.replies].flatMap((message) =>
          message.authorAccountId
            ? [
                [
                  message.authorAccountId,
                  resolveDiscussionMessageAuthorLabel(message),
                ] as const,
              ]
            : [],
        ),
      ),
    [thread],
  );
  const resolveAccountLabel = React.useCallback(
    (accountId: string) =>
      accountId === props.viewerAccountId
        ? t('artifacts.browser.passage.you')
        : (labels.get(accountId) ?? null),
    [labels, props.viewerAccountId],
  );
  const root = thread.root;
  const latestReply =
    [...thread.replies]
      .reverse()
      .find((message) => message !== thread.proposal) ?? null;
  const detached = thread.location.state === 'detached';
  // A thread re-attached to new text keeps what it was first written on, visible beside its new quote.
  const reattached = thread.passage !== thread.original;
  // Who suggested the edit, named as the thread names them: an agent by its Session, a person by name.
  // A Workflow Run is neither; it can't be asked to redo, so it names no proposer to address.
  // An agent's message speaks as its Session (C7), in the latest-reply line as in the proposal title.
  const producerSessionId = thread.proposal?.producerV1?.kind === 'agent' ? thread.proposal.producerV1.sessionId : null;
  const replySessionId = latestReply?.producerV1?.kind === 'agent' ? latestReply.producerV1.sessionId : null;
  const serverId = root.messageRef.discussion.serverId;
  const producerAddresses = React.useMemo(
    () => [producerSessionId, replySessionId].flatMap((sessionId) => (sessionId ? [{ serverId, sessionId }] : [])),
    [producerSessionId, replySessionId, serverId],
  );
  const producerTitles = useSessionDisplayTitles(producerAddresses);
  const producerTitle = producerSessionId ? (producerTitles[0] ?? null) : null;
  const replyTitle = replySessionId ? (producerTitles[producerSessionId ? 1 : 0] ?? null) : null;
  const proposer = React.useMemo(() => {
    const message = thread.proposal;
    if (!message) return null;
    const accountLabel = resolveDiscussionMessageAuthorLabel(message);
    if (message.producerV1?.kind === 'agent') return { label: producerTitle ?? accountLabel, mention: { sessionId: message.producerV1.sessionId } };
    if (message.producerV1) return null;
    return message.authorAccountId ? { label: accountLabel, mention: { accountId: message.authorAccountId } } : null;
  }, [producerTitle, thread.proposal]);
  const testID = `artifact:passage-thread:${thread.discussionId}`;
  const proposalContent =
    thread.proposal?.content &&
    'kind' in thread.proposal.content &&
    thread.proposal.content.kind === 'doc_edit_proposal'
      ? thread.proposal.content.proposal
      : null;
  return (
    <View
      testID={testID}
      style={[
        styles.card,
        props.focused
          ? { borderColor: theme.colors.state.active.border }
          : null,
      ]}
    >
      <View style={styles.quoteRow}>
        <Pressable
          testID={`${testID}.focus`}
          accessibilityRole="button"
          accessibilityState={{ selected: props.focused }}
          onPress={props.onFocus}
          style={styles.quotePress}
        >
          <Icon
            name="quotes"
            size={ICON_SIZE.xs}
            color={theme.colors.text.tertiary}
          />
          <Text variant="meta" numberOfLines={1} style={styles.quote}>
            {readDocPassageThreadQuote(thread)}
          </Text>
          {detached ? (
            <Text
              testID={`${testID}.changed`}
              variant="meta"
              emphasis="medium"
              style={{ color: theme.colors.state.warning.textForeground }}
            >
              {t('artifacts.browser.passage.changed')}
            </Text>
          ) : null}
        </Pressable>
        <Pressable
          testID={`${testID}.open`}
          accessibilityRole="link"
          accessibilityLabel={t('artifacts.browser.passage.openConversation')}
          hitSlop={8}
          onPress={props.onOpen}
          style={({ pressed }) => [
            styles.open,
            pressed ? { opacity: 0.6 } : null,
          ]}
        >
          <Icon
            name="arrow-square-out"
            size={ICON_SIZE.xs}
            color={theme.colors.text.tertiary}
          />
        </Pressable>
      </View>
      {reattached ? (
        <Text testID={`${testID}.earlier`} variant="meta" numberOfLines={1} style={styles.earlier}>
          {t('artifacts.browser.passage.earlier', {
            n: thread.original.revision.bodyVersion,
            quote: thread.original.quote,
          })}
        </Text>
      ) : null}
      <Pressable onPress={props.onFocus} accessible={false}>
      <HappierThreadMessage
        startsGroup
        space={theme.space}
        selectionColors={theme.colors.state.active}
        style={styles.message}
        face={
          root.authorAccountId ? (
            <Avatar
              id={root.authorAccountId}
              imageUrl={root.accountActor?.profile?.avatarUrl ?? null}
              size={24}
            />
          ) : null
        }
        attribution={
          <>
            <Text style={styles.author}>
              {resolveAccountLabel(root.authorAccountId ?? '') ??
                resolveDiscussionMessageAuthorLabel(root)}
            </Text>
            {root.createdAt > 0 ? (
              <Text style={styles.timestamp}>
                {formatShortRelativeTime(root.createdAt)}
              </Text>
            ) : null}
          </>
        }
      >
        <DiscussionMessageContent message={root} serverId={root.messageRef.discussion.serverId}
          resolveAccountLabel={resolveAccountLabel} resolveSessionLabel={NO_SESSION_LABEL} textStyle={styles.text} />
      </HappierThreadMessage>
      </Pressable>
      {latestReply ? (
        <Pressable
          testID={`${testID}.reply`}
          onPress={props.onOpen}
          style={styles.replyRow}
        >
          {latestReply.authorAccountId ? (
            <Avatar
              id={latestReply.authorAccountId}
              imageUrl={latestReply.accountActor?.profile?.avatarUrl ?? null}
              size={16}
            />
          ) : null}
          <Text variant="meta" numberOfLines={1} style={styles.replyText}>
            {t('artifacts.browser.passage.replied', {
              name:
                replyTitle ??
                resolveAccountLabel(latestReply.authorAccountId ?? '') ??
                resolveDiscussionMessageAuthorLabel(latestReply),
              time: formatShortRelativeTime(latestReply.createdAt),
            })}
          </Text>
        </Pressable>
      ) : null}
      {detached ? (
        <View testID={`${testID}.detached`} style={styles.notice}>
          <View style={styles.noticeLine}>
          <Icon
            name="clock-counter-clockwise"
            size={ICON_SIZE.sm}
            color={theme.colors.text.secondary}
          />
          <Text variant="meta" style={styles.noticeText}>
            {t('artifacts.browser.passage.changedReason', {
              n: thread.passage.revision.bodyVersion,
            })}
          </Text>
          </View>
          {props.attaching ? (
            <>
              <Text testID={`${testID}.reattaching`} variant="meta" accessibilityLiveRegion="polite" style={styles.noticeText}>
                {t('artifacts.browser.passage.reattaching')}
              </Text>
              <View style={styles.noticeActions}>
                <RoundButton
                  testID={`${testID}.reattach-cancel`}
                  size="small"
                  display="inverted"
                  title={t('common.cancel')}
                  textStyle={{ color: theme.colors.text.primary }}
                  onPress={props.onCancelReattach}
                />
              </View>
            </>
          ) : (
            <View style={styles.noticeActions}>
              <RoundButton
                testID={`${testID}.compare`}
                size="small"
                display="inverted"
                title={t('artifacts.browser.passage.openRevision', {
                  n: thread.passage.revision.bodyVersion,
                })}
                textStyle={{ color: theme.colors.text.primary }}
                onPress={() => props.onOpenHistory(thread.passage.revision.bodyVersion)}
              />
              <RoundButton
                testID={`${testID}.reattach`}
                size="small"
                title={t('artifacts.browser.passage.reattach')}
                onPress={props.onReattach}
              />
            </View>
          )}
        </View>
      ) : null}
      {thread.proposal && proposalContent ? (
        <ArtifactEditProposal
          testID={`${testID}.proposal`}
          client={props.client}
          docRead={props.docRead}
          proposalRef={thread.proposal.messageRef ?? null}
          proposal={proposalContent}
          disposition={thread.proposal.docEditProposalDispositionV1}
          viewerAccountId={props.viewerAccountId}
          resolveAccountLabel={resolveAccountLabel}
          proposer={proposer}
          namesProposer
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface.base,
    paddingVertical: theme.space.s12,
    paddingHorizontal: theme.space.s12,
    gap: theme.space.s8,
  },
  quoteRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
  quotePress: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
  quote: { flex: 1, minWidth: 0, color: theme.colors.text.tertiary },
  open: { padding: theme.space.s2 },
  message: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0 },
  author: {
    color: theme.colors.text.primary,
    ...Typography.variant('label', 'semiBold'),
  },
  timestamp: {
    color: theme.colors.text.tertiary,
    ...Typography.variant('meta'),
    fontVariant: ['tabular-nums'],
  },
  text: { color: theme.colors.text.primary, ...Typography.variant('body') },
  replyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    paddingLeft: theme.space.s32 + theme.space.s2,
  },
  replyText: { flex: 1, minWidth: 0, color: theme.colors.text.secondary },
  noticeLine: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s8 },
  noticeActions: { flexDirection: 'row', alignSelf: 'flex-end', gap: theme.space.s8 },
  earlier: { color: theme.colors.text.tertiary },
  notice: {
    gap: theme.space.s8,
    paddingVertical: theme.space.s8,
    paddingHorizontal: theme.space.s10,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface.inset,
  },
  noticeText: { flex: 1, minWidth: 0, color: theme.colors.text.secondary },
}));
