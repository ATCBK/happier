import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { DiscussionParticipantsListResponseV1 } from '@happier-dev/protocol/discussions/participants';
import { projectDiscussionModelParticipantLaunchV1 } from '@happier-dev/protocol/discussions/participants';
import {
  normalizeExecutableParticipantSelectionV1,
  type ExecutableParticipantSelectionV1,
} from '@happier-dev/protocol/discussions/executableParticipants';
import { SessionServerStartSpawnDraftV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SelectionListOption, SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import type { SessionReadinessRepairV1, SessionReadinessV1 } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import type { MachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import type { ExecutableParticipantPickerOption } from '@/components/sessions/authoring/executableParticipantPicker';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { useDiscussionInviteCandidates } from './useDiscussionInviteCandidates';
import { t } from '@/text';
import { describeMachineReadinessCause, presentSessionReadiness } from '@/components/sessions/model/sessionReadinessPresentation';

/**
 * A not-ready choice stays listed and selectable with its one cause in place of the usual hint
 * (C7): an offline Bot or Machine is never hidden, and unknown never reads as ready.
 */
function readinessSubtitle(readiness: ExecutableParticipantSectionOption['readiness'], fallback: string): string {
  if (!readiness) return fallback;
  if ('v' in readiness) {
    const presented = presentSessionReadiness({ readiness, repair: null, demanded: true, loading: false, unavailableReason: null });
    return presented.tone === 'attention' ? (presented.cause ?? presented.title) : fallback;
  }
  return describeMachineReadinessCause(readiness) ?? fallback;
}

export type ExecutableParticipantSectionOption = SelectionListOption & Readonly<{
  /** A selected launch/Session has full facts; a not-yet-configured model target has Machine facts only. */
  readiness?: SessionReadinessV1 | MachineSpawnReadiness | null;
  repair?: SessionReadinessRepairV1 | null;
}>;
type ExecutableParticipantSection = Omit<Extract<SelectionListSectionDescriptor, { kind: 'static' }>, 'options'> & Readonly<{
  options: readonly ExecutableParticipantSectionOption[];
}>;

/** The option id of a Session participant; the same id marks it chosen in a multi-choice list. */
export function executableParticipantOptionId(
  selection: ExecutableParticipantSelectionV1,
): string | null {
  return selection.kind === 'session'
    ? `session:${selection.session.sessionId}`
    : null;
}

/**
 * The one presenter of who can take part (lab T2-I): the viewer's existing sessions on this Home,
 * then a model started as a new session of theirs on a machine. A session is chosen
 * at once; a model first opens the ordinary session setup (agent, model, folder) for that machine.
 * Mount it only while a participant choice is open: it reads the session listing and machines.
 * Discussion invites and Workflow participant inputs both choose through it.
 */
export function useExecutableParticipantSections(
  input: Readonly<{
    accountLifetime: ServerAccountScopeLifetime;
    enabled: boolean;
    /** Filters rows when the host owns the search field; omit when the list filters itself. */
    query?: string;
    roster?: DiscussionParticipantsListResponseV1 | null;
    busy?: boolean;
    readinessSessionId?: string | null;
    onReadinessSessionChange?: (sessionId: string | null) => void;
    modelOptions?: readonly ExecutableParticipantPickerOption[];
    /** How the viewer's sessions take part here; said once beside the section title, not on every row. */
    sessionsContext: string;
    onChoose: (selection: ExecutableParticipantSelectionV1) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const serverId = input.accountLifetime.scope.serverId;
  const candidates = useDiscussionInviteCandidates({
    accountLifetime: input.accountLifetime,
    availability: 'available',
    enabled: input.enabled,
    roster: input.roster ?? null,
    readinessSessionId: input.readinessSessionId,
    modelOptions: input.modelOptions,
  });
  const machines = useMachineListForServer(serverId, input.enabled);
  const { onChoose, sessionsContext, onReadinessSessionChange } = input;
  const busy = input.busy === true;
  const query = input.query ?? '';
  const sections = React.useMemo<readonly ExecutableParticipantSection[]>(() => {
    if (!input.enabled) return [];
    // A session leads with its Agent's own mark (identity marks always stay); the catalog decides
    // whether one exists, and a session without a recorded Agent keeps the neutral glyph.
    const sessionMark = (agentId: string | null | undefined) => agentId && hasAgentIconMark(agentId, theme)
      ? <AgentIcon agentId={agentId} size={ICON_SIZE.md} />
      : (
        <Icon
          name="robot"
          size={ICON_SIZE.md}
          color={theme.colors.text.secondary}
        />
      );
    const modelMark = (
      <Icon
        name="sparkle"
        size={ICON_SIZE.md}
        color={theme.colors.text.secondary}
      />
    );
    const needle = query.trim().toLocaleLowerCase();
    const matches = (text: string) =>
      needle.length === 0 || text.toLocaleLowerCase().includes(needle);
    const sessions: ExecutableParticipantSectionOption[] = candidates.candidates.flatMap((candidate) =>
      candidate.kind === 'session' &&
      matches(
        [candidate.label ?? t('session.collaboration.discussion.participants.session'), candidate.contextLabel].filter(Boolean).join(' '),
      )
        ? [
            {
              id: `session:${candidate.selection.session.sessionId}`,
              testID: `discussion-invite-session-${candidate.selection.session.sessionId}`,
              label:
                candidate.label ??
                t('session.collaboration.discussion.participants.session'),
              subtitle: readinessSubtitle(candidate.readiness, candidate.contextLabel ?? (candidate.lastActivityAt == null ? '' : formatAsOfTime(candidate.lastActivityAt))),
              icon: sessionMark(candidate.agentId),
              disabled: busy,
              readiness: candidate.readiness,
              repair: candidate.repair,
              onHighlight: () => onReadinessSessionChange?.(candidate.selection.session.sessionId),
              onPressIn: () => onReadinessSessionChange?.(candidate.selection.session.sessionId),
              onSelect: () => onChoose(candidate.selection),
            },
          ]
        : [],
    );
    if (
      needle.length === 0 &&
      !candidates.sessions.complete &&
      candidates.sessions.state !== null
    ) {
      sessions.push({
        id: 'sessions:more',
        testID: 'discussion-invite-sessions-more',
        label: t('session.collaboration.discussion.secondOpinion.moreSessions'),
        subtitle: '',
        icon: (
          <Icon
            name="dots-three"
            size={ICON_SIZE.md}
            color={theme.colors.text.tertiary}
          />
        ),
        disabled: false,
        onHighlight: () => onReadinessSessionChange?.(null),
        onPressIn: () => onReadinessSessionChange?.(null),
        onSelect: () => {
          void candidates.sessions.loadMore();
        },
      });
    }
    // Setup remains selectable offline. Start re-admits through the ordinary authoring owner.
    const inventory = machines ?? [];
    const matchingMachines = inventory.filter(
      (machine) =>
        matches(
          `${getMachineDisplayName(machine, inventory) ?? ''} ${t('session.collaboration.discussion.manage.modelsGroup')}`,
        ),
    );
    const models: ExecutableParticipantSectionOption[] = candidates.candidates.flatMap(candidate => candidate.kind === 'model' && matches(candidate.label)
      ? [{ id: candidate.key, label: candidate.label, subtitle: readinessSubtitle(candidate.readiness, ''), icon: modelMark, disabled: busy,
          readiness: candidate.readiness, repair: candidate.repair, onHighlight: () => onReadinessSessionChange?.(null),
          onPressIn: () => onReadinessSessionChange?.(null), onSelect: () => onChoose(candidate.selection) }] : []);
    models.push(...matchingMachines.map((machine) => {
      const name =
        getMachineDisplayName(machine, inventory) ??
        t('session.collaboration.unnamed');
      const readiness = resolveMachineSpawnReadiness({ machine, selectedMachineId: machine.id, scope: input.accountLifetime.scope });
      return {
        id: `model:${machine.id}`,
        testID: `discussion-invite-model-${machine.id}`,
        label: t('session.collaboration.discussion.manage.modelOn', {
          machine: name,
        }),
        icon: modelMark,
        disabled: busy,
        readiness,
        subtitle: readinessSubtitle(readiness, t('session.collaboration.discussion.manage.modelCandidate')),
        repair: null,
        onHighlight: () => onReadinessSessionChange?.(null),
        onPressIn: () => onReadinessSessionChange?.(null),
        onSelect: () => {
          void (async () => {
            const { presentSessionServerStartDraftComposer } =
              await import('@/components/sessions/new/serverStartDraftComposerPresentation');
            const drafted = await presentSessionServerStartDraftComposer({
              seed: {},
              target: { serverId, machineId: machine.id },
            }).result.catch(() => null);
            if (!input.accountLifetime.isCurrent()) return;
            const draft =
              SessionServerStartSpawnDraftV1Schema.safeParse(drafted);
            if (!draft.success) return;
            const selection = normalizeExecutableParticipantSelectionV1({
              kind: 'model',
              launch: projectDiscussionModelParticipantLaunchV1(draft.data),
            });
            if (selection) onChoose(selection);
          })();
        },
      };
    }));
    const sections: ExecutableParticipantSection[] = [];
    if (sessions.length)
      sections.push({
        kind: 'static',
        id: 'agents-sessions',
        title: t('session.collaboration.discussion.manage.sessionsGroup'),
        rightAccessory: (
          <Text numberOfLines={1} style={{ ...Typography.variant('meta'), color: theme.colors.text.tertiary }}>
            {sessionsContext}
          </Text>
        ),
        options: sessions,
      });
    if (models.length)
      sections.push({
        kind: 'static',
        id: 'agents-models',
        title: t('session.collaboration.discussion.manage.modelsGroup'),
        options: models,
      });
    return sections;
  }, [
    busy,
    candidates.candidates,
    candidates.sessions,
    input.accountLifetime.scope,
    input.enabled,
    query,
    onChoose,
    onReadinessSessionChange,
    machines,
    serverId,
    sessionsContext,
    theme.colors.text.secondary,
    theme.colors.text.tertiary,
  ]);
  return React.useMemo(() => ({ sections, sessions: candidates.sessions }), [sections, candidates.sessions]);
}
