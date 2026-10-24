import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { Message } from '@happier-dev/session-core/messages';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { transcriptMarkdownTextStyle } from '@/components/sessions/transcript/transcriptMarkdownTypography';
import {
  UserMessageBubble,
  userMessageBubbleAlignerStyle,
} from '@/components/sessions/transcript/UserMessageBubble';
import {
  useSessionMessageInvocation,
  type SessionMessageInvocationTarget,
} from '@/components/sessions/transcript/references/useSessionMessageInvocation';
import { useTranscriptSessionIdentity } from '@/components/sessions/transcript/references/useTranscriptSessionIdentity';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import {
  StatusPill,
  type StatusPillVariant,
} from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { t } from '@/text';

const EVENT_ICON_CONTAINER_SIZE = 20;
const TALK_SELECTORS = [
  'manager',
  'workers',
  'siblings',
  'followers',
  'following',
  'discussion',
  'matching',
] as const;

type TargetState = Readonly<{
  variant: StatusPillVariant;
  label: string;
  icon: IconName;
  failed: boolean;
}>;

/** What one target's chip says. An unavailable read is never evidence of an answer or of its absence. */
function describeTargetState(
  target: SessionMessageInvocationTarget,
  reply: 'none' | 'wait' | 'return',
): TargetState {
  switch (target.status) {
    case 'answered':
      return {
        variant: 'neutral',
        label: t('session.askRecord.answered'),
        icon: 'check',
        failed: false,
      };
    case 'passed':
      return {
        variant: 'neutral',
        label: t('session.askRecord.passed'),
        icon: 'minus-circle',
        failed: false,
      };
    case 'cancelled':
      return {
        variant: 'neutral',
        label: t('session.askRecord.cancelled'),
        icon: 'x-circle',
        failed: false,
      };
    case 'terminal_no_result':
      return {
        variant: 'neutral',
        label: t('session.askRecord.noAnswer'),
        icon: 'x-circle',
        failed: false,
      };
    case 'held':
      return {
        variant: 'attention',
        label: t('session.askRecord.waitsForYou'),
        icon: 'pause-circle',
        failed: false,
      };
    case 'unknown':
      return {
        variant: 'warning',
        label: t('session.askRecord.unsure'),
        icon: 'warning',
        failed: true,
      };
    case 'failed':
      return {
        variant: 'danger',
        icon: 'warning',
        failed: true,
        label: target.requestBound
          ? t('session.askRecord.notAnswered')
          : t('session.askRecord.notSent'),
      };
    case 'queued':
      if (reply === 'none')
        return {
          variant: 'neutral',
          label: t('session.askRecord.sent'),
          icon: 'check',
          failed: false,
        };
      if (target.replyStatus === 'unavailable') {
        return {
          variant: 'neutral',
          label: t('session.askRecord.unavailable'),
          icon: 'clock',
          failed: false,
        };
      }
      return {
        variant: 'neutral',
        label: t('session.askRecord.noAnswerYet'),
        icon: 'clock',
        failed: false,
      };
  }
}

function summarize(
  targets: readonly SessionMessageInvocationTarget[],
  reply: 'none' | 'wait' | 'return',
): string {
  const states = targets.map((target) => ({
    target,
    state: describeTargetState(target, reply),
  }));
  const count = (pick: (entry: (typeof states)[number]) => boolean) =>
    states.filter(pick).length;
  const parts = [
    [
      count((entry) => entry.target.status === 'answered'),
      'session.askRecord.summaryAnswered',
    ],
    [
      count((entry) => entry.target.status === 'passed'),
      'session.askRecord.summaryPassed',
    ],
    [count((entry) => entry.state.failed), 'session.askRecord.summaryFailed'],
    [
      count(
        (entry) =>
          !entry.state.failed &&
          entry.target.status !== 'answered' &&
          entry.target.status !== 'passed',
      ),
      reply === 'none'
        ? 'session.askRecord.summarySent'
        : 'session.askRecord.summaryWaiting',
    ],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, key]) => t(key, { count: n }))
    .join(' · ');
}

function TargetStatePill(
  props: Readonly<{ state: TargetState; testID?: string }>,
) {
  const { theme } = useUnistyles();
  const color =
    props.state.variant === 'neutral' ? theme.colors.text.secondary : undefined;
  return (
    <StatusPill
      testID={props.testID}
      variant={props.state.variant}
      label={props.state.label}
      labelVariant="phrase"
      leading={
        <Icon
          name={props.state.icon}
          size={ICON_SIZE.xs}
          color={color ?? theme.colors.text.secondary}
        />
      }
      {...(color ? { foregroundColor: color } : {})}
    />
  );
}

/** The target's name; opens the actual result message when it exists, else the Session. */
function TargetName(
  props: Readonly<{
    target: SessionMessageInvocationTarget;
    serverId: string | null;
    mark?: boolean;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const navigate = useSessionTranscriptSource().navigate;
  const identity = useTranscriptSessionIdentity(
    props.target.target.sessionId,
    props.target.target.serverId ?? props.serverId,
  );
  const ref = props.target.resultRef;
  const open = navigate
    ? () =>
        navigate(
          buildScopedSessionRouteHref(
            ref?.kind === 'session'
              ? {
                  sessionId: ref.session.sessionId,
                  serverId: ref.session.serverId,
                  messageId: ref.messageId,
                }
              : {
                  sessionId: props.target.target.sessionId,
                  serverId: props.target.target.serverId,
                },
          ),
        )
    : undefined;
  const name = (
    <Text
      variant="label"
      emphasis="semiBold"
      numberOfLines={1}
      style={{ color: theme.colors.text.primary }}
    >
      {identity.name}
    </Text>
  );
  return (
    <View style={styles.targetName}>
      {props.mark ? (
        <AgentIcon agentId={identity.agentId} size={ICON_SIZE.xs} />
      ) : null}
      {open ? (
        <Pressable
          testID={props.testID}
          accessibilityRole="link"
          accessibilityLabel={identity.name}
          onPress={open}
          hitSlop={6}
          style={({ pressed }) => ({
            opacity: pressed ? 0.7 : 1,
            flexShrink: 1,
            minWidth: 0,
          })}
        >
          {name}
        </Pressable>
      ) : (
        name
      )}
    </View>
  );
}

export type SessionAskRecordProps = Readonly<{
  /** The informational source entry (composer) or the existing `session.message.send` tool row (agent). */
  message: Message;
  sessionId: string;
  serverId: string | null;
  /** Inside a row that already owns its horizontal inset (the tool row). */
  embedded?: boolean;
}>;

/**
 * One Ask or Send as the asker's transcript shows it (coordination lab T1q): a quiet row saying who was
 * asked with its result chip, and for a group one line per frozen target. Targets and their immediate
 * results come from the source entry; answers and passes are read live through the invocation hook.
 */
export function SessionAskRecord(props: SessionAskRecordProps) {
  const { theme } = useUnistyles();
  const scope = useActiveServerAccountScope(props.serverId);
  const record = useSessionMessageInvocation({
    scope,
    sessionId: props.sessionId,
    message: props.message,
    active: true,
  });
  if (record.status !== 'ready') return null;
  const { invocation, targets } = record;
  const reply = invocation.reply;
  const selector =
    typeof invocation.target === 'string' ? null : invocation.target.selector;
  const group = selector !== null && targets.length !== 1;
  const selectorTitle =
    selector && (TALK_SELECTORS as readonly string[]).includes(selector)
      ? t(
          `session.participants.talk.${selector as (typeof TALK_SELECTORS)[number]}`,
        )
      : t('session.askRecord.selectorFallback');
  const first = targets[0] ?? null;
  const failedTargets = targets.filter(
    (target) => describeTargetState(target, reply).failed,
  );
  const headerState: TargetState = group
    ? {
        variant: 'neutral',
        icon: targets.every((target) => target.status === 'answered')
          ? 'check'
          : 'clock',
        failed: false,
        label: summarize(targets, reply),
      }
    : first
      ? describeTargetState(first, reply)
      : {
          variant: 'danger',
          icon: 'warning',
          failed: true,
          label: t('session.askRecord.notSent'),
        };
  const verb = group
    ? t(
        reply === 'none'
          ? 'session.askRecord.groupSentTo'
          : 'session.askRecord.groupAsked',
      )
    : t(
        reply === 'none'
          ? 'session.askRecord.sentTo'
          : 'session.askRecord.asked',
      );

  return (
    <View
      testID={`session-ask-record:${record.sourceRowId}`}
      style={props.embedded ? styles.embedded : styles.container}
    >
      {record.origin === 'composer' && record.text ? (
        <View style={styles.bubbleRow}>
          <View style={styles.bubbleAligner}>
            <UserMessageBubble
              testID={`session-ask-record-text:${record.sourceRowId}`}
            >
              <MarkdownView
                codeBlockStateKey={JSON.stringify([
                  props.sessionId,
                  record.sourceRowId,
                ])}
                markdown={record.text}
                selectable
                profile="transcript"
                textStyle={transcriptMarkdownTextStyle}
              />
            </UserMessageBubble>
          </View>
        </View>
      ) : null}
      <View style={styles.row}>
        <View style={styles.iconSlot}>
          <Icon
            name="chat-circle"
            size={18}
            color={theme.colors.text.secondary}
          />
        </View>
        <View style={styles.headline}>
          <Text
            variant="label"
            numberOfLines={1}
            style={{ color: theme.colors.text.secondary }}
          >{verb}</Text>
          {group ? (
            <Text
              variant="label"
              emphasis="semiBold"
              numberOfLines={1}
              style={{ color: theme.colors.text.primary }}
            >
              {selectorTitle}
            </Text>
          ) : first ? (
            <TargetName target={first} serverId={props.serverId} />
          ) : (
            <Text
              variant="label"
              emphasis="semiBold"
              numberOfLines={1}
              style={{ color: theme.colors.text.primary }}
            >
              {selectorTitle}
            </Text>
          )}
          {group ? (
            <Text
              variant="label"
              numberOfLines={1}
              style={{ color: theme.colors.text.secondary }}
            >{` · ${targets.length}`}</Text>
          ) : null}
        </View>
        <TargetStatePill
          state={headerState}
          testID={`session-ask-record-state:${record.sourceRowId}`}
        />
      </View>
      {group && targets.length > 0 ? (
        <View
          style={styles.lines}
          testID={`session-ask-record-targets:${record.sourceRowId}`}
        >
          {targets.map((target) => (
            <View
              key={`${target.target.serverId}:${target.target.sessionId}`}
              style={styles.line}
              testID={`session-ask-record-target:${target.target.sessionId}`}
            >
              <TargetName target={target} serverId={props.serverId} mark />
              <View style={styles.grow} />
              <TargetStatePill state={describeTargetState(target, reply)} testID={`session-ask-record-target-state:${target.target.sessionId}`} />
            </View>
          ))}
        </View>
      ) : null}
      {record.origin === 'composer' && failedTargets.length > 0 ? (
        <Text
          variant="meta"
          style={[styles.hint, { color: theme.colors.text.tertiary }]}
          testID={`session-ask-record-retry:${record.sourceRowId}`}
        >
          {t('session.askRecord.retryHint')}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    marginHorizontal: theme.space.s16,
    paddingBottom: theme.transcript.messageGap,
    alignSelf: 'stretch',
  },
  embedded: {
    paddingTop: theme.space.s8,
    alignSelf: 'stretch',
  },
  bubbleRow: {
    alignSelf: 'stretch',
    paddingBottom: theme.space.s12,
  },
  bubbleAligner: userMessageBubbleAlignerStyle,
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    minWidth: 0,
  },
  iconSlot: {
    width: EVENT_ICON_CONTAINER_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  headline: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    minWidth: 0,
  },
  targetName: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    flexShrink: 1,
    minWidth: 0,
  },
  lines: {
    marginTop: theme.space.s6,
    marginLeft: EVENT_ICON_CONTAINER_SIZE + theme.space.s4,
    paddingLeft: theme.space.s10,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border.subtle,
    gap: theme.space.s4,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    minHeight: 28,
    minWidth: 0,
  },
  grow: {
    flex: 1,
  },
  hint: {
    marginTop: theme.space.s6,
    marginLeft: EVENT_ICON_CONTAINER_SIZE + theme.space.s10,
  },
}));
