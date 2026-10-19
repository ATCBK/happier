import * as React from 'react';
import { Pressable, StyleSheet as RNStyleSheet, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { Message } from '@happier-dev/session-core/messages';
import {
  readSessionInputAuthority,
  type SessionInputReturnedAnswerV1,
} from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

import { useSelectedSessionMessageReply } from '@/components/sessions/transcript/references/useSelectedSessionMessageReply';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { useSessionDisplayNameSource } from '@/sync/domains/state/storage';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';

/** The protected return facts on an answer that came back to this session, if it is one. */
export function readReturnedAnswer(
  message: Message,
): SessionInputReturnedAnswerV1 | null {
  if (message.kind !== 'user-text') return null;
  const authority = readSessionInputAuthority(message.meta, 'stored');
  return authority?.v === 1 ? (authority.returnedAnswer ?? null) : null;
}

const OUTCOME_KEY = {
  answer: 'session.returnedAnswer.answered',
  pass: 'session.returnedAnswer.passed',
  failed: 'session.returnedAnswer.failed',
  cancelled: 'session.returnedAnswer.cancelled',
  terminal_no_result: 'session.returnedAnswer.noResult',
} as const;

/**
 * An answer another session returned to an Ask from here (coordination lab T1q): quoted under the
 * answering session's name and outcome, labelled as information, never as something the person
 * wrote. "Your question" opens the exact original request through the selected-reply reader.
 */
export function ReturnedAnswerQuote(
  props: Readonly<{
    message: Message;
    answer: SessionInputReturnedAnswerV1;
    sessionId: string;
    serverId?: string | null;
    children: React.ReactNode;
  }>,
) {
  const { theme } = useUnistyles();
  const transcriptSource = useSessionTranscriptSource();
  const senderId =
    props.answer.senderSessionId ??
    props.answer.sourceMessageRef?.session.sessionId ??
    null;
  // The transcript's own Home qualifies the sender, as the provenance label does.
  const serverId = props.serverId ?? transcriptSource.serverId ?? null;
  const sender = useSessionDisplayNameSource(senderId ?? '', serverId);
  const senderName = sender
    ? getSessionName(sender, serverId)
    : t('message.provenanceSession');
  const failed =
    props.answer.outcome !== 'answer' && props.answer.outcome !== 'pass';
  const [questionOpen, setQuestionOpen] = React.useState(false);
  const navigate = transcriptSource.navigate;
  const openSender =
    senderId && navigate
      ? () =>
          navigate(
            buildScopedSessionRouteHref({
              sessionId: senderId,
              serverId,
            }),
          )
      : null;

  return (
    <View
      style={styles.card}
      testID={`transcript-returned-answer:${props.message.id}`}
    >
      <View style={styles.header}>
        <Icon
          name="chat-circle"
          size={ICON_SIZE.sm}
          color={theme.colors.text.secondary}
        />
        <Text
          variant="body"
          emphasis="semiBold"
          numberOfLines={1}
          style={styles.name}
        >
          {senderName}
        </Text>
        <Text
          variant="meta"
          numberOfLines={1}
          style={failed ? styles.metaFailed : styles.meta}
        >
          {t(OUTCOME_KEY[props.answer.outcome])}
        </Text>
        <View style={styles.grow} />
        {openSender ? (
          <Pressable
            accessibilityRole="link"
            onPress={openSender}
            hitSlop={8}
            testID={`transcript-returned-answer-open:${props.message.id}`}
          >
            <Text variant="meta" style={styles.link}>
              {t('session.returnedAnswer.open')}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.body}>{props.children}</View>
      <View style={styles.footer}>
        <Icon name="info" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
        <Text variant="meta" style={styles.footerText}>
          {t('session.returnedAnswer.asInformation')}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: questionOpen }}
          onPress={() => setQuestionOpen((open) => !open)}
          hitSlop={8}
          testID={`transcript-returned-answer-question:${props.message.id}`}
        >
          <Text variant="meta" style={styles.link}>
            {t('session.returnedAnswer.yourQuestion')}
          </Text>
        </Pressable>
      </View>
      {questionOpen ? (
        <ReturnedAnswerQuestion
          message={props.message}
          sessionId={props.sessionId}
          serverId={serverId}
        />
      ) : null}
    </View>
  );
}

/** Mounted only while the person opens it: one exact read, never one per transcript row. */
function ReturnedAnswerQuestion(
  props: Readonly<{
    message: Message;
    sessionId: string;
    serverId?: string | null;
  }>,
) {
  const transcriptSource = useSessionTranscriptSource();
  const scope = useActiveServerAccountScope(props.serverId ?? null);
  const [refreshKey, retry] = React.useReducer((value: number) => value + 1, 0);
  const state = useSelectedSessionMessageReply({
    scope,
    sessionId: props.sessionId,
    message: props.message,
    active: true,
    refreshKey,
  });
  const navigate = transcriptSource.navigate;
  if (state.status !== 'ready') {
    return (
      <Text
        variant="meta"
        style={styles.questionLine}
        testID="transcript-returned-answer-question-state"
      >
        {t(
          state.status === 'loading'
            ? 'common.loading'
            : 'session.returnedAnswer.questionUnavailable',
        )}
      </Text>
    );
  }
  const model = state.model;
  const requestRef = model.requestRef;
  const unavailable = model.reply.status !== 'available';
  return (
    <View
      style={styles.question}
      testID="transcript-returned-answer-question-state"
    >
      <Text variant="meta" style={styles.questionLine}>
        {unavailable
          ? t('session.returnedAnswer.questionUnavailable')
          : t('session.returnedAnswer.askedFromHere')}
      </Text>
      <View style={styles.grow} />
      {unavailable ? (
        <Pressable accessibilityRole="button" onPress={retry} hitSlop={8}>
          <Text variant="meta" style={styles.link}>
            {t('common.retry')}
          </Text>
        </Pressable>
      ) : requestRef && navigate ? (
        <Pressable
          accessibilityRole="link"
          hitSlop={8}
          onPress={() =>
            navigate(
              buildScopedSessionRouteHref({
                sessionId: requestRef.session.sessionId,
                serverId: requestRef.session.serverId,
              }),
            )
          }
        >
          <Text variant="meta" style={styles.link}>
            {t('session.returnedAnswer.openQuestion')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    alignSelf: 'stretch',
    borderWidth: RNStyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
    gap: theme.space.s6,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  name: {
    flexShrink: 1,
    color: theme.colors.text.primary,
  },
  meta: {
    color: theme.colors.text.secondary,
  },
  metaFailed: {
    color: theme.colors.status.error,
  },
  grow: {
    flex: 1,
  },
  link: {
    color: theme.colors.text.link,
  },
  body: {
    minWidth: 0,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  footerText: {
    flex: 1,
    color: theme.colors.text.secondary,
  },
  question: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    paddingTop: theme.space.s6,
    borderTopWidth: RNStyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  questionLine: {
    color: theme.colors.text.secondary,
  },
}));
