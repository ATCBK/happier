import * as React from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet as RNStyleSheet, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';
import type { SessionDraftSessionMessagingValueV1 } from '@happier-dev/protocol/drafts/sessionDrafts';

import { projectSessionFollowerCensus } from '@/components/sessions/collaboration/SessionPeopleFollowSections';
import { useSessionFollowers } from '@/components/sessions/follow/useSessionFollowers';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { participantRecipientsMatch } from '@/sync/domains/input/participants/resolveParticipantRoutedSend';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { t } from '@/text';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';

import { AGENT_INPUT_MENU_ICON_SIZE_PX } from '../definitions/agentInputChipIconMetrics';
import { resolveSessionParticipantTargetLabel } from './recipientOptions';
import { useSessionTalkTargets } from './sessionTalkTargets';

export type SessionTalkIntent = SessionDraftSessionMessagingValueV1;
export type SessionTalkVerb = 'send' | 'ask' | 'post_update';
/** The `manager` relations the composer offers; the Action owns every other selector. */
export type SessionTalkSelector = 'manager' | 'workers' | 'siblings';

const SELECTORS: readonly SessionTalkSelector[] = [
  'manager',
  'workers',
  'siblings',
];
const SELECTOR_ICON: Readonly<Record<SessionTalkSelector, IconName>> = {
  manager: 'tree-structure',
  workers: 'arrow-elbow-down-right',
  siblings: 'arrows-left-right',
};

export function readSessionTalkVerb(
  intent: SessionTalkIntent | null,
): SessionTalkVerb | null {
  return intent
    ? intent.kind === 'post_update'
      ? 'post_update'
      : intent.kind
    : null;
}

export function readSessionTalkSelector(
  intent: SessionTalkIntent | null,
): SessionTalkSelector | null {
  if (
    !intent ||
    intent.kind === 'post_update' ||
    typeof intent.target === 'string'
  )
    return null;
  const selector = intent.target.selector;
  return selector === 'manager' ||
    selector === 'workers' ||
    selector === 'siblings'
    ? selector
    : null;
}

/** Ask always returns its answers here: the composer has no inline reader for a waited answer. */
export function buildSessionTalkIntent(
  verb: SessionTalkVerb,
  selector: SessionTalkSelector | null,
): SessionTalkIntent | null {
  if (verb === 'post_update') return { kind: 'post_update' };
  if (!selector) return null;
  return verb === 'ask'
    ? { kind: 'ask', target: { selector }, reply: 'return' }
    : { kind: 'send', target: { selector } };
}

export function selectorTitle(selector: SessionTalkSelector): string {
  return t(`session.participants.talk.${selector}`);
}

export type SessionTalkPickerProps = Readonly<{
  sessionId: string;
  serverId: string | null;
  intent: SessionTalkIntent | null;
  onIntentChange: (next: SessionTalkIntent | null) => void;
  /** The inside-Session roster (Agent team, Runs) keeps its own recipient contract. */
  participants: Readonly<{
    targets: readonly SessionParticipantTarget[];
    recipient: ParticipantRecipientV1 | null;
    onRecipientChange: (next: ParticipantRecipientV1 | null) => void;
  }> | null;
  requestClose: () => void;
}>;

/**
 * The composer's To picker (coordination lab T1): the verb first (Send · Ask · Post update), then the
 * sessions it goes to, each named as it resolves now. "This session" returns to ordinary chat. People
 * are never addressed here.
 */
export function SessionTalkPicker(props: SessionTalkPickerProps) {
  const { theme } = useUnistyles();
  const [verb, setVerb] = React.useState<SessionTalkVerb>(
    () => readSessionTalkVerb(props.intent) ?? 'ask',
  );
  const selected = readSessionTalkSelector(props.intent);
  const targets = useSessionTalkTargets(props.sessionId, props.serverId);
  const participantTargets = props.participants?.targets ?? [];
  const chatSelected = props.intent === null && !props.participants?.recipient;

  // Post update and back restores the sessions chosen before (lab T1u).
  const lastSelector = React.useRef(selected);
  if (selected) lastSelector.current = selected;
  const chooseVerb = React.useCallback(
    (next: SessionTalkVerb) => {
      setVerb(next);
      if (next === 'post_update') props.onIntentChange({ kind: 'post_update' });
      else if (props.intent)
        props.onIntentChange(buildSessionTalkIntent(next, lastSelector.current));
    },
    [props.intent, props.onIntentChange],
  );
  // The popover keeps its height while the list turns into the audience and back.
  const [bodyMinHeight, setBodyMinHeight] = React.useState(0);
  const onBodyLayout = React.useCallback((event: LayoutChangeEvent) => {
    const height = Math.ceil(event.nativeEvent.layout.height);
    setBodyMinHeight((current) => (height > current ? height : current));
  }, []);

  const chooseSelector = (selector: SessionTalkSelector) => {
    props.participants?.onRecipientChange(null);
    props.onIntentChange(buildSessionTalkIntent(verb, selector));
    props.requestClose();
  };
  const chooseChat = () => {
    props.onIntentChange(null);
    props.participants?.onRecipientChange(null);
    props.requestClose();
  };
  const chooseParticipant = (target: SessionParticipantTarget) => {
    props.onIntentChange(null);
    props.participants?.onRecipientChange(target.recipient);
    props.requestClose();
  };

  const verbTabs = React.useMemo(
    () => [
      { id: 'send' as const, label: t('session.participants.talk.verbSend') },
      { id: 'ask' as const, label: t('session.participants.talk.verbAsk') },
      {
        id: 'post_update' as const,
        label: t('session.participants.talk.verbPostUpdate'),
      },
    ],
    [],
  );
  const iconColor = theme.colors.text.secondary;
  const check = (
    <Icon
      name="check"
      size={AGENT_INPUT_MENU_ICON_SIZE_PX}
      color={theme.colors.text.primary}
    />
  );
  const names: Readonly<Record<SessionTalkSelector, readonly string[]>> = {
    manager: targets.manager ? [targets.manager] : [],
    workers: targets.workers,
    siblings: targets.siblings,
  };

  return (
    <View style={styles.root} testID="session-talk-picker">
      <View style={styles.verb}>
        <SegmentedTabBar<SessionTalkVerb>
          tabs={verbTabs}
          activeTabId={verb}
          onSelectTab={chooseVerb}
          role="radiogroup"
          accessibilityLabel={t('session.participants.talk.verbLabel')}
          testIDPrefix="session-talk-verb"
        />
        <Text variant="meta" style={styles.verbMeaning}>
          {t(
            verb === 'send'
              ? 'session.participants.talk.meaningSend'
              : verb === 'ask'
                ? 'session.participants.talk.meaningAsk'
                : 'session.participants.talk.meaningPostUpdate',
          )}
        </Text>
      </View>
      <View style={{ minHeight: bodyMinHeight }} onLayout={onBodyLayout}>
      {verb === 'post_update' ? (
        <SessionTalkAudience
          sessionId={props.sessionId}
          serverId={props.serverId}
        />
      ) : (
        <View>
          <CollectionListGroupLabel
            title={t('session.participants.to')}
            presentation="menu"
          />
          <Item
            testID="session-talk-target:self"
            rowRole="menu"
            icon={
              <Icon
                name="chat-circle"
                size={AGENT_INPUT_MENU_ICON_SIZE_PX}
                color={iconColor}
              />
            }
            title={t('session.participants.lead')}
            subtitle={t('session.participants.talk.selfSubtitle')}
            selected={chatSelected}
            rightElement={chatSelected ? check : undefined}
            showChevron={false}
            showDivider={false}
            accessibilityRole="radio"
            accessibilityChecked={chatSelected}
            onPress={chooseChat}
          />
          {SELECTORS.map((selector) => {
            const list = names[selector];
            const empty = list.length === 0;
            const isSelected = selected === selector;
            return (
              <Item
                key={selector}
                testID={`session-talk-target:${selector}`}
                rowRole="menu"
                icon={
                  <Icon
                    name={SELECTOR_ICON[selector]}
                    size={AGENT_INPUT_MENU_ICON_SIZE_PX}
                    color={iconColor}
                  />
                }
                title={selectorTitle(selector)}
                subtitle={
                  empty
                    ? t('session.participants.talk.noneNow')
                    : summarizeNames(list)
                }
                detail={empty ? undefined : String(list.length)}
                selected={isSelected}
                rightElement={isSelected ? check : undefined}
                disabled={empty}
                showChevron={false}
                showDivider={false}
                accessibilityRole="radio"
                accessibilityChecked={isSelected}
                onPress={() => chooseSelector(selector)}
              />
            );
          })}
          {participantTargets.length > 0 ? (
            <>
              <CollectionListGroupLabel
                title={t('session.participants.talk.insideSession')}
                presentation="menu"
              />
              {participantTargets.map((target) => {
                const isSelected = Boolean(
                  props.participants?.recipient &&
                  participantRecipientsMatch(
                    target.recipient,
                    props.participants.recipient,
                  ),
                );
                return (
                  <Item
                    key={target.key}
                    testID={`session-talk-participant:${target.key}`}
                    rowRole="menu"
                    title={resolveSessionParticipantTargetLabel(target)}
                    selected={isSelected}
                    rightElement={isSelected ? check : undefined}
                    showChevron={false}
                    showDivider={false}
                    accessibilityRole="radio"
                    accessibilityChecked={isSelected}
                    onPress={() => chooseParticipant(target)}
                  />
                );
              })}
            </>
          ) : null}
        </View>
      )}
      </View>
      <View style={styles.footer}>
        <Icon
          name="users"
          size={AGENT_INPUT_MENU_ICON_SIZE_PX}
          color={iconColor}
        />
        <Text variant="meta" style={styles.footerText}>
          {t('session.participants.talk.peopleFooter')}
        </Text>
      </View>
    </View>
  );
}

/** "A, B" up to two names, then "A, B +N" (the approval preview lists everyone). */
function summarizeNames(names: readonly string[]): string {
  const shown = names.slice(0, 2).join(', ');
  return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}

/**
 * Post update turns the list into its live audience: each Session that follows this one, with how an
 * update reaches it under its own policies (one level table for people and sessions), and people as a
 * count. Mounted only while Post update is chosen.
 */
function SessionTalkAudience(
  props: Readonly<{ sessionId: string; serverId: string | null }>,
) {
  const { theme } = useUnistyles();
  const address = React.useMemo(
    () => ({ serverId: props.serverId ?? '', sessionId: props.sessionId }),
    [props.serverId, props.sessionId],
  );
  const followers = useSessionFollowers(address, Boolean(props.serverId));
  // One census owner with People: one row per receiving session, its relations' effective union.
  const census = React.useMemo(
    () => projectSessionFollowerCensus(followers.projection),
    [followers.projection],
  );
  const receivers = React.useMemo(
    () =>
      (census.sessions ?? []).map((follower) => {
        const delivery = follower.effective.updatePosted.delivery;
        return {
          sessionId: follower.sessionId,
          manager: follower.manager,
          arrival:
            delivery === 'wake'
              ? ('wake' as const)
              : delivery === 'next_turn'
                ? ('nextTurn' as const)
                : ('none' as const),
        };
      }),
    [census.sessions],
  );
  const titles = useSessionDisplayTitles(
    React.useMemo(
      () =>
        receivers.map((receiver) => ({
          sessionId: receiver.sessionId,
          serverId: props.serverId,
        })),
      [receivers, props.serverId],
    ),
  );
  const peopleCount = census.peopleCount ?? 0;
  const iconColor = theme.colors.text.secondary;
  const settled = followers.projection !== null;

  return (
    <View testID="session-talk-audience">
      <CollectionListGroupLabel
        title={t('session.participants.talk.whoHears')}
        presentation="menu"
      />
      {!settled ? (
        <Item
          rowRole="menu"
          mode="info"
          loading={followers.loading}
          title={
            followers.loading
              ? t('common.loading')
              : t('session.participants.talk.audienceUnavailable')
          }
          rightElement={
            followers.loading ? undefined : (
              <Pressable
                accessibilityRole="button"
                onPress={followers.refresh}
                hitSlop={8}
                testID="session-talk-audience-retry"
              >
                <Text variant="meta" style={styles.link}>
                  {t('common.retry')}
                </Text>
              </Pressable>
            )
          }
          showChevron={false}
          showDivider={false}
        />
      ) : receivers.length === 0 && peopleCount === 0 ? (
        <Item
          rowRole="menu"
          mode="info"
          title={t('session.participants.talk.noAudience')}
          showChevron={false}
          showDivider={false}
        />
      ) : (
        <>
          {receivers.map((receiver, index) => (
            <Item
              key={receiver.sessionId}
              testID={`session-talk-audience:${receiver.sessionId}`}
              rowRole="menu"
              mode="info"
              icon={
                <Icon
                  name="chat-circle"
                  size={AGENT_INPUT_MENU_ICON_SIZE_PX}
                  color={iconColor}
                />
              }
              title={titles[index] ?? t('message.provenanceSession')}
              subtitle={t(
                receiver.manager
                  ? 'session.participants.talk.managesIt'
                  : 'session.participants.talk.followsIt',
              )}
              detail={t(
                receiver.arrival === 'wake'
                  ? 'session.participants.talk.arrivalWake'
                  : receiver.arrival === 'nextTurn'
                    ? 'session.participants.talk.arrivalNextTurn'
                    : 'session.participants.talk.arrivalNone',
              )}
              showChevron={false}
              showDivider={false}
            />
          ))}
          {peopleCount > 0 ? (
            <Item
              testID="session-talk-audience:people"
              rowRole="menu"
              mode="info"
              icon={
                <Icon
                  name="users"
                  size={AGENT_INPUT_MENU_ICON_SIZE_PX}
                  color={iconColor}
                />
              }
              title={t('session.participants.talk.people', {
                count: peopleCount,
              })}
              subtitle={t('session.participants.talk.peopleLevel')}
              showChevron={false}
              showDivider={false}
            />
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    paddingVertical: theme.space.s8,
  },
  verb: {
    paddingHorizontal: theme.space.s12,
    paddingBottom: theme.space.s8,
    gap: theme.space.s8,
  },
  verbMeaning: {
    color: theme.colors.text.secondary,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    marginTop: theme.space.s8,
    paddingTop: theme.space.s10,
    paddingHorizontal: theme.space.s12,
    borderTopWidth: RNStyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  link: {
    color: theme.colors.text.link,
  },
  footerText: {
    flex: 1,
    color: theme.colors.text.secondary,
  },
}));
