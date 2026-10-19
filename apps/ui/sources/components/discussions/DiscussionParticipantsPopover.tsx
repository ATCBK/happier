import * as React from 'react';
import type { TranscriptAccountActor } from '@happier-dev/session-core/messages';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  DiscussionAnswerPolicyV1,
  DiscussionParticipantsListResponseV1,
} from '@happier-dev/protocol/discussions/participants';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { AvatarStack, type AvatarStackEntry } from '@/components/ui/avatar/AvatarStack';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { Item } from '@/components/ui/lists/Item';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import {
  MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
  Popover,
} from '@/components/ui/popover';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import type { useDiscussionParticipantManagement } from './useDiscussionParticipantManagement';

const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(
  Platform.OS,
);
const AVATAR_PX = 28;

const styles = StyleSheet.create((theme) => ({
  body: { paddingBottom: theme.space.s4, minWidth: 0 },
  headerSlot: { paddingTop: theme.space.s8 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s10,
    paddingHorizontal: theme.space.s12,
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s8,
  },
  headerText: { flex: 1, minWidth: 0, gap: theme.space.s2 },
  title: {
    ...Typography.variant('heading', 'semiBold'),
    color: theme.colors.text.primary,
  },
  subtitle: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s8,
    paddingRight: theme.space.s12,
  },
  groupNote: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    flexShrink: 1,
    textAlign: 'right',
  },
  groupNoteBelow: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    paddingHorizontal: theme.space.s12,
    paddingBottom: theme.space.s4,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    paddingHorizontal: theme.space.s12,
    paddingTop: theme.space.s10,
  },
  noteText: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    flex: 1,
    minWidth: 0,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  footerEnd: { marginLeft: 'auto' },
  resolutionBody: {
    ...Typography.variant('body'),
    color: theme.colors.text.secondary,
    paddingHorizontal: theme.space.s12,
    paddingBottom: theme.space.s4,
  },
  resolutionArchive: { marginTop: theme.space.s8 },
}));

/** What the roster says about this Discussion: who reads it, and who may answer. */
export type DiscussionRosterFacts = Readonly<{
  peopleCount: number;
  agentCount: number;
  /** A Team or Group grant: readers beyond the people invited by name. */
  inherited: boolean;
}>;

/** The faces of who is in this Discussion (lab T2-A header): people first, then each agent's mark. */
const ROSTER_FACE_PX = 20;
const ROSTER_FACE_LIMIT = 6;
export const DiscussionRosterFaces = React.memo(function DiscussionRosterFaces(
  props: Readonly<{
    roster: DiscussionParticipantsListResponseV1;
    accountActors: ReadonlyMap<string, TranscriptAccountActor>;
    viewerAccountId: string;
    accessibilityLabel: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { roster } = props;
  const entries = React.useMemo(() => {
    const people = [roster.ownerAccountId];
    for (const grant of roster.grants) {
      if (grant.principal.kind === 'account' && !people.includes(grant.principal.accountId)) people.push(grant.principal.accountId);
    }
    // The viewer sits last, as in the roster: the others are who you came to see.
    const ordered = [...people.filter((id) => id !== props.viewerAccountId), ...people.filter((id) => id === props.viewerAccountId)];
    const faces: AvatarStackEntry[] = ordered.map((accountId) => ({
      key: `account:${accountId}`,
      content: <Avatar id={accountId} imageUrl={props.accountActors.get(accountId)?.profile?.avatarUrl ?? null} size={ROSTER_FACE_PX} />,
    }));
    const agents: AvatarStackEntry[] = roster.participants.map((participant, index) => ({
      key: participant.participant.kind === 'model' ? `model:${participant.participant.participantSlotId}` : `agent:${index}`,
      avatar: false,
      content: <View style={rosterFaceStyles.agentMark}>
        <Icon name={participant.participant.kind === 'model' ? 'sparkle' : 'robot'} size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
      </View>,
    }));
    return [...faces, ...agents].slice(0, ROSTER_FACE_LIMIT);
  }, [props.accountActors, props.viewerAccountId, roster, theme.colors.text.secondary]);
  return <AvatarStack testID="session-discussion-roster-faces" size={ROSTER_FACE_PX} entries={entries} accessibilityLabel={props.accessibilityLabel} />;
});

const rosterFaceStyles = StyleSheet.create((theme) => ({
  agentMark: {
    width: ROSTER_FACE_PX + 4,
    height: ROSTER_FACE_PX + 4,
    borderRadius: (ROSTER_FACE_PX + 4) / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface.base,
  },
}));

export function summarizeDiscussionRoster(
  roster: DiscussionParticipantsListResponseV1,
): DiscussionRosterFacts {
  const invited = new Set<string>([roster.ownerAccountId]);
  let inherited = false;
  for (const grant of roster.grants) {
    if (grant.principal.kind === 'account')
      invited.add(grant.principal.accountId);
    else inherited = true;
  }
  return {
    peopleCount: invited.size,
    agentCount: roster.participants.length,
    inherited,
  };
}

export function formatDiscussionRosterLine(
  facts: DiscussionRosterFacts,
): string {
  return facts.agentCount > 0
    ? t('session.collaboration.discussion.participants.peopleAndAgents', {
        people: facts.peopleCount,
        agents: facts.agentCount,
      })
    : t('session.collaboration.discussion.participants.people', {
        count: facts.peopleCount,
      });
}

const ANSWER_POLICIES: readonly DiscussionAnswerPolicyV1[] = [
  'when_addressed',
  'reads_only',
  'drafts_for_approval',
  'watches_and_speaks_up',
];

export function answerPolicyLabel(policy: DiscussionAnswerPolicyV1): string {
  switch (policy) {
    case 'when_addressed':
      return t(
        'session.collaboration.discussion.participants.policyWhenAddressed',
      );
    case 'reads_only':
      return t('session.collaboration.discussion.participants.policyReadsOnly');
    case 'drafts_for_approval':
      return t('session.collaboration.discussion.participants.policyDrafts');
    case 'watches_and_speaks_up':
      return t('session.collaboration.discussion.participants.policyWatches');
  }
}

/** What each answer policy does, said where it is chosen (lab T2-S); watching names its turn cost. */
export function answerPolicyDescription(policy: DiscussionAnswerPolicyV1): string {
  switch (policy) {
    case 'when_addressed':
      return t('session.collaboration.discussion.manage.policyWhenAddressedBody');
    case 'reads_only':
      return t('session.collaboration.discussion.manage.policyReadsOnlyBody');
    case 'drafts_for_approval':
      return t('session.collaboration.discussion.manage.policyDraftsBody');
    case 'watches_and_speaks_up':
      return t('session.collaboration.discussion.manage.policyWatchesBody');
  }
}

export type DiscussionParticipantManagement = ReturnType<
  typeof useDiscussionParticipantManagement
>;
type RosterParticipant =
  DiscussionParticipantsListResponseV1['participants'][number];

/**
 * The heading of a Discussion's floating sheets (Participants, Invite): a quiet mark, the sheet's
 * title and one line saying which Discussion and who is in it.
 */
export function DiscussionSheetHeader(
  props: Readonly<{ icon: IconName; title: string; subtitle: string }>,
) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.header}>
      <Icon
        name={props.icon}
        size={ICON_SIZE.md}
        color={theme.colors.text.secondary}
      />
      <View style={styles.headerText}>
        <Text style={styles.title} numberOfLines={1}>
          {props.title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {props.subtitle}
        </Text>
      </View>
    </View>
  );
}

/**
 * Where a participant change stands, one line under the roster: saving, waiting for an approval
 * (with its request), still checking, or failed with Try again. Done and idle say nothing.
 */
export function DiscussionParticipantOperationLine(
  props: Readonly<{
    management: DiscussionParticipantManagement;
    serverId: string;
  }>,
) {
  const router = useRouter();
  const { operation, retry } = props.management;
  if (operation.kind === 'idle' || operation.kind === 'succeeded') return null;
  if (operation.kind === 'approval_pending') {
    return (
      <ActionApprovalPendingNotice
        presentation="line"
        testID="discussion-participants-approval"
        message={t('approvals.status.open')}
        onOpenApproval={() =>
          router.push(buildApprovalHref(operation.artifactId, props.serverId))
        }
      />
    );
  }
  if (operation.kind === 'working') {
    return (
      <EmptyState
        testID="discussion-participants-operation"
        layout="line"
        lineDensity="menu"
        lineLoading
        title={t('session.collaboration.discussion.manage.working')}
      />
    );
  }
  return (
    <EmptyState
      testID="discussion-participants-operation"
      layout="line"
      lineDensity="menu"
      title={
        operation.kind === 'checking'
          ? t('session.collaboration.discussion.manage.checking')
          : t('session.collaboration.discussion.manage.failed')
      }
      primaryAction={{
        label: t('session.collaboration.discussion.retry'),
        onPress: () => retry(),
        testID: 'discussion-participants-retry',
      }}
    />
  );
}

/**
 * Who is in a Discussion (lab T2-S): the people who can read it, then the agents and how each answers,
 * and what the audience means. Opened from the header's people control; the roster is the Discussion's
 * own grants, never the source Session's readers. A manager changes how an agent answers, opens its
 * session or removes it from each agent's row; the owner's Leave first asks who keeps it.
 */
export const DiscussionParticipantsPopover = React.memo(
  function DiscussionParticipantsPopover(
    props: Readonly<{
      discussionId: string;
      discussionTitle: string;
      serverId: string;
      viewerAccountId: string;
      roster: DiscussionParticipantsListResponseV1 | null;
      /** Captured-Home display facts; composition uses the shared Account byline presentation owner. */
      accountActors: ReadonlyMap<string, TranscriptAccountActor>;
      /** Accounts present in the Discussion right now (live presence). */
      presentAccountIds: ReadonlySet<string>;
      resolveAccountLabel: (accountId: string) => string | null;
      onLeave?: () => void;
      /** The participant writes (C's management owner); absent leaves the roster read-only. */
      management?: DiscussionParticipantManagement | null;
      /** Whether this viewer may change who answers here (manage access on an unarchived Discussion). */
      canManage?: boolean;
      /** The owner handed the Discussion over and left. */
      onLeft?: () => void;
    }>,
  ) {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<View>(null);
    const management = props.management ?? null;
    const resolving = management?.ownerLeave.kind === 'transfer_or_archive';
    const close = React.useCallback(() => {
      management?.cancelLeave();
      setOpen(false);
    }, [management]);
    const viewerIsOwner =
      props.roster !== null &&
      props.roster.ownerAccountId === props.viewerAccountId;
    const subtitle = props.roster
      ? `${props.discussionTitle} · ${formatDiscussionRosterLine(summarizeDiscussionRoster(props.roster))}`
      : props.discussionTitle;
    return (
      <>
        <View ref={anchorRef} collapsable={false}>
          <IconButton
            testID="discussion-participants-toggle"
            iconName="users"
            variant="plain"
            iconSize={ICON_SIZE.sm}
            size={34}
            accessibilityLabel={t(
              'session.collaboration.discussion.participants.title',
            )}
            tooltip={t('session.collaboration.discussion.participants.title')}
            tooltipHidden={open}
            expanded={open}
            hasPopup="dialog"
            minimumInteractiveTargetSize={minimumInteractiveTargetSize}
            onPress={() => (open ? close() : setOpen(true))}
          />
        </View>
        {open ? (
          <Popover
            open={open}
            anchorRef={anchorRef}
            placement="bottom"
            gap={6}
            maxHeightCap={640}
            maxWidthCap={440}
            onRequestClose={close}
            backdrop={{ enabled: false }}
            portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
          >
            {({ maxHeight }) => (
              <FloatingOverlay
                maxHeight={maxHeight}
                surfaceChrome="theme"
                // The sheet's title and its Leave/Done stay put while a long roster scrolls.
                header={<View style={styles.headerSlot}>
                    <DiscussionSheetHeader
                      icon={resolving ? 'sign-out' : 'users'}
                      title={
                        resolving
                          ? t('session.collaboration.discussion.manage.leaveTitle')
                          : t('session.collaboration.discussion.participants.title')
                      }
                      subtitle={subtitle}
                    />
                </View>}
                footer={<View style={styles.footer}>
                    {resolving ? (
                      <View style={styles.footerEnd}>
                        <RoundButton
                          testID="discussion-participants-cancel-leave"
                          size="small"
                          display="secondary"
                          title={t('common.cancel')}
                          disabled={
                            management?.ownerLeave.kind ===
                              'transfer_or_archive' &&
                            !management.ownerLeave.canCancel
                          }
                          onPress={() => management?.cancelLeave()}
                        />
                      </View>
                    ) : (
                      <>
                        {props.onLeave && props.roster ? (
                          <RoundButton
                            testID="discussion-participants-leave"
                            size="small"
                            display="secondary"
                            title={t(
                              'session.collaboration.discussion.participants.leave',
                            )}
                            onPress={() => {
                              // The owner first chooses who keeps it, here in the same sheet.
                              if (!viewerIsOwner) setOpen(false);
                              props.onLeave?.();
                            }}
                          />
                        ) : null}
                        <View style={styles.footerEnd}>
                          <RoundButton
                            testID="discussion-participants-done"
                            size="small"
                            title={t('common.done')}
                            onPress={close}
                          />
                        </View>
                      </>
                    )}
                  </View>}
              >
                <View
                  testID="discussion-participants-panel"
                  style={styles.body}
                >
                  {resolving && management && props.roster ? (
                    <DiscussionOwnerLeaveResolution
                      management={management}
                      resolveAccountLabel={props.resolveAccountLabel}
                      onLeft={() => {
                        setOpen(false);
                        props.onLeft?.();
                      }}
                    />
                  ) : props.roster ? (
                    <DiscussionRoster
                      {...props}
                      roster={props.roster}
                      management={management}
                      canManage={props.canManage === true && management !== null}
                    />
                  ) : (
                    <EmptyState
                      layout="line"
                      lineLoading
                      title={t(
                        'session.collaboration.discussion.participants.loading',
                      )}
                    />
                  )}
                  {management ? (
                    <DiscussionParticipantOperationLine
                      management={management}
                      serverId={props.serverId}
                    />
                  ) : null}
                </View>
              </FloatingOverlay>
            )}
          </Popover>
        ) : null}
      </>
    );
  },
);

/** The owner's Leave: hand the Discussion to someone already here, or archive it. Cancel keeps all. */
function DiscussionOwnerLeaveResolution(
  props: Readonly<{
    management: DiscussionParticipantManagement;
    resolveAccountLabel: (accountId: string) => string | null;
    onLeft: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { management } = props;
  const resolution = management.ownerLeave;
  if (resolution.kind !== 'transfer_or_archive') return null;
  const busy = management.operation.kind === 'working';
  return (
    <View testID="discussion-owner-leave">
      <Text style={styles.resolutionBody}>
        {t('session.collaboration.discussion.manage.leaveBody')}
      </Text>
      <CollectionListGroupLabel
        title={t('session.collaboration.discussion.manage.transferGroup')}
        presentation="menu"
      />
      {resolution.transferCandidates.length === 0 ? (
        <EmptyState
          layout="line"
          lineDensity="menu"
          title={t('session.collaboration.discussion.manage.noTransferCandidates')}
        />
      ) : (
        resolution.transferCandidates.map((candidate) => (
          <Item
            key={candidate.accountId}
            testID={`discussion-owner-transfer-${candidate.accountId}`}
            density="compact"
            showChevron={false}
            showDivider={false}
            disabled={busy}
            leftElement={<Avatar id={candidate.accountId} size={AVATAR_PX} />}
            title={
              candidate.name ??
              props.resolveAccountLabel(candidate.accountId) ??
              t('session.collaboration.unnamed')
            }
            subtitle={t('session.collaboration.discussion.manage.transferSubtitle')}
            onPress={() => {
              void management
                .transferAndLeave(candidate.accountId)
                .then((outcome) => {
                  if (outcome?.kind === 'succeeded') props.onLeft();
                });
            }}
          />
        ))
      )}
      {resolution.canArchive ? (
        <View style={styles.resolutionArchive}>
          <Item
            testID="discussion-owner-archive-instead"
            density="compact"
            showChevron={false}
            showDivider={false}
            disabled={busy}
            leftElement={
              <Icon
                name="archive"
                size={ICON_SIZE.md}
                color={theme.colors.text.secondary}
              />
            }
            title={t('session.collaboration.discussion.manage.archiveInstead')}
            subtitle={t(
              'session.collaboration.discussion.manage.archiveInsteadBody',
            )}
            onPress={() => {
              void management.archiveInsteadOfLeave();
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

function DiscussionRoster(
  props: Readonly<{
    serverId: string;
    viewerAccountId: string;
    roster: DiscussionParticipantsListResponseV1;
    accountActors: ReadonlyMap<string, TranscriptAccountActor>;
    presentAccountIds: ReadonlySet<string>;
    resolveAccountLabel: (accountId: string) => string | null;
    management: DiscussionParticipantManagement | null;
    canManage: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const phone = useSurfaceStateSize() === 'phone';
  const { roster } = props;
  const facts = summarizeDiscussionRoster(roster);
  const people = React.useMemo(() => {
    const rows: Array<
      Readonly<{
        key: string;
        accountId: string | null;
        name: string;
        state: string;
      }>
    > = [];
    const describe = (accountId: string, owner: boolean, canPost: boolean) =>
      accountId === props.viewerAccountId
        ? owner
          ? t('session.collaboration.discussion.participants.owner')
          : t('session.collaboration.discussion.participants.you')
        : props.presentAccountIds.has(accountId)
          ? t('session.collaboration.discussion.participants.hereNow')
          : owner
            ? t('session.collaboration.discussion.participants.owner')
            : canPost
              ? t('session.collaboration.discussion.participants.canPost')
              : t('session.collaboration.discussion.participants.canRead');
    const nameOf = (accountId: string, display?: string | null) =>
      accountId === props.viewerAccountId
        ? t('session.collaboration.pane.you')
        : (display ??
          props.resolveAccountLabel(accountId) ??
          t('session.collaboration.unnamed'));
    rows.push({
      key: `owner:${roster.ownerAccountId}`,
      accountId: roster.ownerAccountId,
      name: nameOf(roster.ownerAccountId),
      state: describe(roster.ownerAccountId, true, true),
    });
    for (const grant of roster.grants) {
      if (grant.principal.kind === 'account') {
        if (grant.principal.accountId === roster.ownerAccountId) continue;
        rows.push({
          key: `account:${grant.principal.accountId}`,
          accountId: grant.principal.accountId,
          name: nameOf(
            grant.principal.accountId,
            grant.display.name ?? grant.display.username ?? null,
          ),
          state: describe(
            grant.principal.accountId,
            false,
            grant.accessLevel !== 'view',
          ),
        });
      } else {
        rows.push({
          key: `${grant.principal.kind}:${JSON.stringify(grant.principal)}`,
          accountId: null,
          name: grant.display.name ?? t('session.collaboration.unnamed'),
          state: t('session.collaboration.discussion.participants.teamAccess'),
        });
      }
    }
    // The viewer reads last, as in the lab: the others are who you came to see.
    return [
      ...rows.filter((row) => row.accountId !== props.viewerAccountId),
      ...rows.filter((row) => row.accountId === props.viewerAccountId),
    ];
  }, [
    props.presentAccountIds,
    props.resolveAccountLabel,
    props.viewerAccountId,
    roster,
  ]);
  const agentSessions = React.useMemo(
    () =>
      roster.participants.map((participant) => ({
        serverId: props.serverId,
        sessionId:
          participant.participant.kind === 'session'
            ? participant.participant.sessionId
            : 'launch' in participant ? (participant.sessionId ?? '') : '',
      })),
    [props.serverId, roster.participants],
  );
  const agentTitles = useSessionDisplayTitles(agentSessions);
  return (
    <View>
      <CollectionListGroupLabel
        title={t('session.collaboration.discussion.participants.peopleGroup')}
        count={facts.peopleCount}
        presentation="menu"
      />
      {people.map((row) => (
        <Item
          key={row.key}
          testID={`discussion-participant-${row.key}`}
          mode="info"
          density="compact"
          showChevron={false}
          showDivider={false}
          leftElement={
            row.accountId ? (
              <Avatar id={row.accountId} size={AVATAR_PX} />
            ) : (
              <Icon
                name="users"
                size={ICON_SIZE.md}
                color={theme.colors.text.secondary}
              />
            )
          }
          title={row.name}
          subtitle={row.state}
        />
      ))}
      {/* A phone has no room beside the label: the note moves beneath it rather than truncating. */}
      <View style={phone ? undefined : styles.groupRow}>
        <CollectionListGroupLabel
          title={t('session.collaboration.discussion.participants.agentsGroup')}
          presentation="menu"
        />
        <Text style={phone ? styles.groupNoteBelow : styles.groupNote} numberOfLines={phone ? undefined : 1}>
          {t('session.collaboration.discussion.participants.agentsNote')}
        </Text>
      </View>
      {roster.participants.length === 0 ? (
        <EmptyState
          layout="line"
          lineDensity="menu"
          title={t('session.collaboration.discussion.participants.noAgents')}
        />
      ) : (
        roster.participants.map((participant, index) => {
          const model = participant.participant.kind === 'model';
          const sessionId = agentSessions[index]?.sessionId || null;
          return (
            <DiscussionAgentRow
              key={
                participant.participant.kind === 'model'
                  ? `model:${participant.participant.participantSlotId}`
                  : `session:${sessionId}`
              }
              testID={`discussion-agent-participant-${index}`}
              participant={participant}
              title={
                agentTitles[index] ??
                (model
                  ? t('session.collaboration.discussion.participants.modelStarting')
                  : t('session.collaboration.discussion.heldParticipant'))
              }
              sessionId={sessionId}
              serverId={props.serverId}
              management={props.canManage ? props.management : null}
            />
          );
        })
      )}
      <View style={styles.note}>
        <Icon
          name="lock"
          size={ICON_SIZE.sm}
          color={theme.colors.text.tertiary}
        />
        <Text style={styles.noteText}>
          {facts.inherited
            ? t('session.collaboration.discussion.participants.inheritedNote')
            : t('session.collaboration.discussion.participants.privateNote')}
        </Text>
      </View>
    </View>
  );
}

const REMOVE_ID = 'remove';
const OPEN_ID = 'open';
const RESTART_ID = 'restart';

/**
 * One agent here: what it is and how it answers. For a manager the row opens one menu: the four
 * answer policies (each saying what it does), then Open its session and Remove. Removing a model
 * started for this Discussion archives that session; removing an existing session only detaches it.
 */
function DiscussionAgentRow(
  props: Readonly<{
    testID: string;
    participant: RosterParticipant;
    title: string;
    sessionId: string | null;
    serverId: string;
    management: DiscussionParticipantManagement | null;
  }>,
) {
  const { theme } = useUnistyles();
  const navigateToSession = useNavigateToSession();
  const [open, setOpen] = React.useState(false);
  const { participant, management } = props;
  const model = participant.participant.kind === 'model';
  const kind = model
    ? t('session.collaboration.discussion.participants.model')
    : t('session.collaboration.discussion.participants.session');
  const subtitle = `${kind} · ${answerPolicyLabel(participant.answerPolicy)}`;
  const mark = (
    <Icon
      name={model ? 'sparkle' : 'robot'}
      size={ICON_SIZE.md}
      color={theme.colors.text.secondary}
    />
  );
  const busy = management?.operation.kind === 'working';
  const items = React.useMemo(() => {
    const policies = ANSWER_POLICIES.map((policy) => ({
      id: policy,
      testID: `${props.testID}:policy:${policy}`,
      title: answerPolicyLabel(policy),
      subtitle: answerPolicyDescription(policy),
      checked: policy === participant.answerPolicy,
      category: t('session.collaboration.discussion.manage.answersGroup'),
    }));
    // A model whose session never started keeps its slot; starting again reuses that slot.
    const unstarted = participant.participant.kind === 'model' && !props.sessionId;
    const operations = [
      ...(unstarted
        ? [
            {
              id: RESTART_ID,
              testID: `${props.testID}:restart`,
              title: t('session.collaboration.discussion.manage.startAgain'),
              subtitle: t('session.collaboration.discussion.manage.startAgainBody'),
              icon: (
                <Icon
                  name="arrow-clockwise"
                  size={ICON_SIZE.sm}
                  color={theme.colors.text.secondary}
                />
              ),
              category: t('session.collaboration.discussion.manage.operationsGroup'),
            },
          ]
        : []),
      ...(props.sessionId
        ? [
            {
              id: OPEN_ID,
              testID: `${props.testID}:open`,
              title: t('session.collaboration.discussion.manage.openSession'),
              icon: (
                <Icon
                  name="arrow-square-out"
                  size={ICON_SIZE.sm}
                  color={theme.colors.text.secondary}
                />
              ),
              category: t('session.collaboration.discussion.manage.operationsGroup'),
            },
          ]
        : []),
      {
        id: REMOVE_ID,
        testID: `${props.testID}:remove`,
        // Only a model whose session started has a session to archive.
        title: model && !unstarted
          ? t('session.collaboration.discussion.manage.removeModel')
          : t('session.collaboration.discussion.manage.removeSession'),
        ...(unstarted
          ? {}
          : {
              subtitle: model
                ? t('session.collaboration.discussion.manage.removeModelBody')
                : t('session.collaboration.discussion.manage.removeSessionBody'),
            }),
        destructive: true,
        category: t('session.collaboration.discussion.manage.operationsGroup'),
      },
    ];
    return [...policies, ...operations];
  }, [model, participant.answerPolicy, participant.participant.kind, props.sessionId, props.testID, theme.colors.text.secondary]);
  if (!management) {
    return (
      <Item
        testID={props.testID}
        mode="info"
        density="compact"
        showChevron={false}
        showDivider={false}
        leftElement={mark}
        title={props.title}
        subtitle={subtitle}
      />
    );
  }
  return (
    <DropdownMenu
      testID={`${props.testID}:menu`}
      open={open}
      onOpenChange={setOpen}
      items={items}
      selectedId={participant.answerPolicy}
      separateCategories
      placement="bottom"
      gap={4}
      maxWidthCap={360}
      matchTriggerWidth={false}
      popoverPhonePresentation="sheet"
      popoverAccessibilityLabel={props.title}
      popoverSheetSubtitle={subtitle}
      onSelect={(id) => {
        setOpen(false);
        if (id === OPEN_ID) {
          // The agent's own session, on this Discussion's Home.
          if (props.sessionId) void navigateToSession(props.sessionId, { serverId: props.serverId });
          return;
        }
        if (id === REMOVE_ID) {
          void management.remove(participant.participant);
          return;
        }
        if (id === RESTART_ID) {
          if ('launch' in participant && participant.participant.kind === 'model')
            void management.inviteExecutable(
              { kind: 'model', launch: participant.launch },
              { participantSlotId: participant.participant.participantSlotId, answerPolicy: participant.answerPolicy },
            );
          return;
        }
        const policy = ANSWER_POLICIES.find((value) => value === id);
        if (policy && policy !== participant.answerPolicy)
          void management.setPolicy(participant.participant, policy);
      }}
      trigger={({ toggle }) => (
        <Item
          testID={props.testID}
          density="compact"
          showChevron={false}
          showDivider={false}
          disabled={busy}
          leftElement={mark}
          title={props.title}
          subtitle={subtitle}
          accessibilityHint={t('session.collaboration.discussion.manage.rowHint')}
          accessibilityExpanded={open}
          onPress={toggle}
          rightElement={
            <Icon
              name="caret-down"
              size={ICON_SIZE.xs}
              color={theme.colors.text.tertiary}
            />
          }
        />
      )}
    />
  );
}
