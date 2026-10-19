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
import type { SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { useDiscussionInviteCandidates } from './useDiscussionInviteCandidates';
import { t } from '@/text';

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
 * then a model started as a new session of theirs on a machine that is online. A session is chosen
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
    /** How an existing session takes part here, beneath its name. */
    sessionSubtitle: string;
    onChoose: (selection: ExecutableParticipantSelectionV1) => void;
  }>,
): readonly SelectionListSectionDescriptor[] {
  const { theme } = useUnistyles();
  const serverId = input.accountLifetime.scope.serverId;
  const candidates = useDiscussionInviteCandidates({
    accountLifetime: input.accountLifetime,
    availability: 'available',
    enabled: input.enabled,
    roster: input.roster ?? null,
  });
  const machines = useMachineListForServer(serverId);
  const { onChoose, sessionSubtitle } = input;
  const busy = input.busy === true;
  const query = input.query ?? '';
  return React.useMemo(() => {
    if (!input.enabled) return [];
    const sessionMark = (
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
    const sessions = candidates.candidates.flatMap((candidate) =>
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
              subtitle: [candidate.contextLabel ?? (candidate.lastActivityAt == null ? null : formatAsOfTime(candidate.lastActivityAt)),
                sessionSubtitle].filter(Boolean).join(' · '),
              icon: sessionMark,
              disabled: busy,
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
        onSelect: () => {
          void candidates.sessions.loadMore();
        },
      });
    }
    // Only machines that can start a session now (the readiness the session setup itself checks),
    // named by the Home inventory's resolver so same-named machines read apart.
    const inventory = machines ?? [];
    const online = inventory.filter(
      (machine) =>
        resolveMachineSpawnReadiness({
          machine,
          selectedMachineId: machine.id,
          scope: input.accountLifetime.scope,
        }).status === 'ready' &&
        matches(
          `${getMachineDisplayName(machine, inventory) ?? ''} ${t('session.collaboration.discussion.manage.modelsGroup')}`,
        ),
    );
    const models = online.map((machine) => {
      const name =
        getMachineDisplayName(machine, inventory) ??
        t('session.collaboration.unnamed');
      return {
        id: `model:${machine.id}`,
        testID: `discussion-invite-model-${machine.id}`,
        label: t('session.collaboration.discussion.manage.modelOn', {
          machine: name,
        }),
        subtitle: t('session.collaboration.discussion.manage.modelCandidate'),
        icon: modelMark,
        disabled: busy,
        onSelect: () => {
          void (async () => {
            const { presentSessionServerStartDraftComposer } =
              await import('@/components/sessions/new/serverStartDraftComposerPresentation');
            const drafted = await presentSessionServerStartDraftComposer({
              seed: {},
              target: { serverId, machineId: machine.id },
            }).result.catch(() => null);
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
    });
    const sections: SelectionListSectionDescriptor[] = [];
    if (sessions.length)
      sections.push({
        kind: 'static',
        id: 'agents-sessions',
        title: t('session.collaboration.discussion.manage.sessionsGroup'),
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
    machines,
    serverId,
    sessionSubtitle,
    theme.colors.text.secondary,
    theme.colors.text.tertiary,
  ]);
}
