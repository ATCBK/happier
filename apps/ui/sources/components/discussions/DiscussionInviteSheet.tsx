import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { DiscussionAccessGrantsListResponseV1 } from '@happier-dev/protocol/discussions/access';
import type { DiscussionParticipantsListResponseV1 } from '@happier-dev/protocol/discussions/participants';
import type { ExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';

import { sessionAccessSubjectKey } from '@/components/sessions/access/projectSessionAccessEditorSnapshot';
import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import { ShareSheet } from '@/components/sharing/ShareSheet';
import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';
import { useShareViewerProfile } from '@/components/sharing/useShareViewerProfile';
import type {
  ShareAccessLevel,
  ShareGrantRowModel,
  ShareOperationModel,
  ShareSheetActions,
  ShareSheetAdapter,
  ShareSheetModel,
  ShareUiError,
  ShareUiReason,
} from '@/components/sharing/shareSheetTypes';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import {
  MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
  Popover,
} from '@/components/ui/popover';
import type { SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import {
  DiscussionParticipantOperationLine,
  DiscussionSheetHeader,
  type DiscussionParticipantManagement,
} from './DiscussionParticipantsPopover';
import { useExecutableParticipantSections } from './useExecutableParticipantSections';
import { t } from '@/text';

type Mutation =
  | Readonly<{
      kind: 'set';
      principal: PrincipalRefV1;
      accessLevel: ShareAccessLevel;
    }>
  | Readonly<{ kind: 'remove'; principal: PrincipalRefV1 }>;

type State = Readonly<{
  phase: 'initial' | 'ready' | 'error';
  response: DiscussionAccessGrantsListResponseV1 | null;
  issue?: ShareUiError;
  operations: Readonly<Record<string, ShareOperationModel>>;
}>;

const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
const IDLE: ShareOperationModel = { kind: 'idle' };
const NO_TEAM_CONTEXTS: readonly [] = [];

/** One message per Discussion grant refusal; codes stay the Action host's, words stay here. */
function presentDiscussionInviteFailure(code: string): ShareUiError {
  switch (code) {
    case 'discussion_manage_denied':
      return {
        code,
        message: t('session.collaboration.discussion.invite.ownerOnly'),
        retryable: false,
      };
    case 'offline':
      return {
        code,
        message: t('session.collaboration.discussion.offline'),
        retryable: true,
      };
    default:
      return {
        code,
        message: t('session.collaboration.discussion.invite.failed'),
        retryable: true,
      };
  }
}

/**
 * Who can read this Discussion, written only through the `discussion.access.grants.*` Actions. The
 * Discussion's grants are the shared resource grant rows, so the one share sheet and the people
 * directory serve them as they serve every other shareable thing; every acknowledged response
 * replaces the roster.
 */
function useDiscussionInviteController(
  input: Readonly<{
    scope: ServerAccountScope;
    discussionId: string;
    onChanged?: () => void;
  }>,
) {
  const { scope, discussionId } = input;
  const viewerProfile = useShareViewerProfile(scope);
  const client = React.useMemo(
    () => createDiscussionClient({ scope, availability: 'available' }),
    [scope],
  );
  const identity = `${scope.serverId}:${scope.accountId}:${discussionId}`;
  const [state, setState] = React.useState<State>({
    phase: 'initial',
    response: null,
    operations: {},
  });
  const [query, setQuery] = React.useState('');
  const [notice, setNotice] = React.useState<ShareUiReason | undefined>();
  const [revision, setRevision] = React.useState(0);
  const lastMutation = React.useRef(new Map<string, Mutation>());
  const current = React.useRef<string | null>(identity);
  current.current = identity;
  const onChangedRef = React.useRef(input.onChanged);
  onChangedRef.current = input.onChanged;

  const load = React.useCallback(async () => {
    const outcome = await client.listGrants(discussionId).catch(() => null);
    if (current.current !== identity) return;
    setState((previous) =>
      outcome?.kind === 'succeeded'
        ? {
            ...previous,
            phase: 'ready',
            response: outcome.value,
            issue: undefined,
          }
        : {
            ...previous,
            phase: 'error',
            issue: presentDiscussionInviteFailure(
              outcome?.kind === 'failed' ? outcome.errorCode : 'failed',
            ),
          },
    );
  }, [client, discussionId, identity]);
  React.useEffect(() => {
    void load();
  }, [load]);

  const mutate = React.useCallback(
    async (mutation: Mutation) => {
      const key = sessionAccessSubjectKey(mutation.principal);
      lastMutation.current.set(key, mutation);
      setState((previous) => ({
        ...previous,
        operations: {
          ...previous.operations,
          [key]: { kind: mutation.kind === 'remove' ? 'removing' : 'saving' },
        },
      }));
      const outcome = await (
        mutation.kind === 'set'
          ? client.setGrant({
              discussionId,
              principal: mutation.principal,
              accessLevel: mutation.accessLevel,
            })
          : client.removeGrant({ discussionId, principal: mutation.principal })
      ).catch(() => null);
      if (current.current !== identity) return;
      setState((previous) => {
        const { [key]: _settled, ...operations } = previous.operations;
        if (outcome?.kind === 'succeeded') {
          const { changed: _changed, access, ...response } = outcome.value;
          lastMutation.current.delete(key);
          if (access === null)
            return {
              phase: 'ready',
              response: null,
              operations: {},
              issue: presentDiscussionInviteFailure('discussion_manage_denied'),
            };
          return {
            ...previous,
            phase: 'ready',
            response: { ...response, access },
            operations,
            issue: undefined,
          };
        }
        return {
          ...previous,
          operations: {
            ...operations,
            [key]: {
              kind: 'error',
              error: presentDiscussionInviteFailure(
                outcome?.kind === 'failed' ? outcome.errorCode : 'failed',
              ),
            },
          },
        };
      });
      if (outcome?.kind === 'succeeded') onChangedRef.current?.();
      setRevision((value) => value + 1);
    },
    [client, discussionId, identity],
  );

  const response = state.response;
  const isOwner = response?.access === 'owner';
  const editable = isOwner || response?.access === 'admin';
  const grants = React.useMemo<readonly ShareGrantRowModel[]>(
    () =>
      (response?.grants ?? []).map((row) => {
        const principal = presentSharePrincipal({
          ref: row.principal,
          name: row.display.name,
          username: row.display.username,
          viewerAccountId: scope.accountId,
          profile:
            row.principal.kind === 'account' &&
            row.principal.accountId === scope.accountId
              ? viewerProfile
              : null,
        });
        return {
          grant: row.principal,
          principal,
          level: {
            kind: 'editable',
            value: row.accessLevel,
            options: isOwner ? ['view', 'edit', 'admin'] : ['view', 'edit'],
          },
          removal: { kind: 'allowed' },
          operation: state.operations[principal.key] ?? IDLE,
        };
      }),
    [
      isOwner,
      response?.grants,
      scope.accountId,
      state.operations,
      viewerProfile,
    ],
  );
  const owner = response
    ? {
        principal: presentSharePrincipal({
          ref: { kind: 'account', accountId: response.ownerAccountId },
          ...(response.ownerAccountId === scope.accountId
            ? { profile: viewerProfile }
            : {}),
          viewerAccountId: scope.accountId,
        }),
      }
    : null;

  const directory = useSessionAccessDirectory({
    scope,
    availability: 'available',
    contextTeams: NO_TEAM_CONTEXTS,
    operations: state.operations,
    revision,
    enabled: editable,
  });

  const actions = React.useMemo<ShareSheetActions>(
    () => ({
      setQuery,
      retryDirectory: directory.retry,
      loadMore: directory.loadMore,
      // An invitation joins the conversation: invited people can post (lab T2-I).
      addPrincipal: (principal) => {
        void mutate({ kind: 'set', principal, accessLevel: 'edit' });
      },
      retryMutation: (grant) => {
        const mutation = lastMutation.current.get(
          sessionAccessSubjectKey(grant),
        );
        if (mutation) void mutate(mutation);
      },
      setAccessLevel: (grant, accessLevel) => {
        void mutate({ kind: 'set', principal: grant, accessLevel });
      },
      requestRemove: (grant) => {
        void mutate({ kind: 'remove', principal: grant });
      },
      confirmRemove: (grant) => {
        void mutate({ kind: 'remove', principal: grant });
      },
      cancelRemove: () => {},
      explain: setNotice,
    }),
    [directory.loadMore, directory.retry, mutate],
  );

  const model: ShareSheetModel = {
    revision,
    editable,
    stale: state.phase === 'error' && response !== null,
    owner,
    grants,
    directory: { query, sections: editable ? directory.sections : [] },
  };
  return {
    model,
    actions,
    issue: state.issue,
    notice,
    loading: state.phase === 'initial',
    retry: () => {
      void load();
    },
  };
}

function createDiscussionInviteAdapter(
  input: Readonly<{
    title: string;
    loading: boolean;
    issue?: ShareUiError;
    notice?: ShareUiReason;
    retry(): void;
    /** Sessions, bots and models that can join and answer (lab T2-I), after the people. */
    agentSections?: readonly SelectionListSectionDescriptor[];
  }>,
): ShareSheetAdapter {
  return {
    namespace: 'discussion-invite',
    title: input.title,
    ...(input.agentSections
      ? { searchPlaceholder: t('session.collaboration.discussion.manage.invitePlaceholder') }
      : {}),
    levels: {
      view: {
        label: t('session.collaboration.discussion.participants.canRead'),
      },
      edit: {
        label: t('session.collaboration.discussion.participants.canPost'),
      },
      admin: { label: t('session.collaboration.discussion.invite.canManage') },
    },
    notes: [t('session.collaboration.discussion.participants.privateNote')],
    sections: () => {
      const notices = [];
      if (input.loading)
        notices.push({
          id: 'loading',
          label: t('common.loading'),
          loading: true,
          disabled: true,
        });
      if (input.issue)
        notices.push({
          id: 'issue',
          label: input.issue.message,
          ...(input.issue.retryable
            ? { onSelect: input.retry, subtitle: t('common.retry') }
            : {}),
        });
      if (input.notice)
        notices.push({
          id: 'notice',
          label: input.notice.message,
          disabled: true,
        });
      const trailing: SelectionListSectionDescriptor[] = [
        ...(input.agentSections ?? []),
        ...(notices.length
          ? [{ kind: 'static' as const, id: 'status', options: notices }]
          : []),
      ];
      return trailing.length ? { trailing } : {};
    },
  };
}

function DiscussionInviteSheet(
  props: Readonly<{
    scope: ServerAccountScope;
    accountLifetime?: ServerAccountScopeLifetime;
    discussionId: string;
    discussionTitle: string;
    roster?: DiscussionParticipantsListResponseV1 | null;
    management?: DiscussionParticipantManagement | null;
    onChanged?: () => void;
    onRequestClose: () => void;
  }>,
) {
  const controller = useDiscussionInviteController({
    scope: props.scope,
    discussionId: props.discussionId,
    onChanged: props.onChanged,
  });
  return (
    <View testID="discussion-invite-panel" style={inviteStyles.panel}>
      {props.accountLifetime && props.management ? (
        <DiscussionInviteSheetWithAgents
          controller={controller}
          accountLifetime={props.accountLifetime}
          management={props.management}
          roster={props.roster ?? null}
          discussionTitle={props.discussionTitle}
          onRequestClose={props.onRequestClose}
        />
      ) : (
        <DiscussionInviteShareSheet
          controller={controller}
          discussionTitle={props.discussionTitle}
          onRequestClose={props.onRequestClose}
        />
      )}
    </View>
  );
}

function DiscussionInviteSheetWithAgents(
  props: Readonly<{
    controller: ReturnType<typeof useDiscussionInviteController>;
    accountLifetime: ServerAccountScopeLifetime;
    management: DiscussionParticipantManagement;
    roster: DiscussionParticipantsListResponseV1 | null;
    discussionTitle: string;
    onRequestClose: () => void;
  }>,
) {
  const { inviteExecutable, operation } = props.management;
  const onChoose = React.useCallback(
    (selection: ExecutableParticipantSelectionV1) => { void inviteExecutable(selection); },
    [inviteExecutable],
  );
  const agentSections = useExecutableParticipantSections({
    accountLifetime: props.accountLifetime,
    roster: props.roster,
    busy: operation.kind === 'working',
    sessionSubtitle: t('session.collaboration.discussion.manage.sessionCandidate'),
    onChoose,
    enabled: props.controller.model.editable,
    query: props.controller.model.directory.query,
  });
  return (
    <DiscussionInviteShareSheet
      controller={props.controller}
      discussionTitle={props.discussionTitle}
      agentSections={agentSections}
      onRequestClose={props.onRequestClose}
    />
  );
}

function DiscussionInviteShareSheet(
  props: Readonly<{
    controller: ReturnType<typeof useDiscussionInviteController>;
    discussionTitle: string;
    agentSections?: readonly SelectionListSectionDescriptor[];
    onRequestClose: () => void;
  }>,
) {
  const { controller } = props;
  const adapter = createDiscussionInviteAdapter({
    title: t('session.collaboration.discussion.invite.title', {
      title: props.discussionTitle,
    }),
    loading: controller.loading,
    ...(controller.issue ? { issue: controller.issue } : {}),
    ...(controller.notice ? { notice: controller.notice } : {}),
    retry: controller.retry,
    ...(props.agentSections ? { agentSections: props.agentSections } : {}),
  });
  return (
    <ShareSheet
      model={controller.model}
      actions={controller.actions}
      adapter={adapter}
      presentation="compact"
      onRequestClose={props.onRequestClose}
      testID="discussion-invite-sheet"
    />
  );
}

const inviteStyles = StyleSheet.create((theme) => ({
  panel: { minWidth: 0, minHeight: 0 },
  header: { paddingTop: theme.space.s8 },
}));

/**
 * The header's Invite (lab T2-A/T2-I): the one share sheet, compact, hung from the button, adding people
 * and Teams to who can read and post here.
 */
export const DiscussionInviteButton = React.memo(
  function DiscussionInviteButton(
    props: Readonly<{
      scope: ServerAccountScope;
      accountLifetime?: ServerAccountScopeLifetime;
      discussionId: string;
      discussionTitle: string;
      roster?: DiscussionParticipantsListResponseV1 | null;
      management?: DiscussionParticipantManagement | null;
      onChanged?: () => void;
    }>,
  ) {
    const { theme } = useUnistyles();
    const phone = useSurfaceStateSize() === 'phone';
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<View>(null);
    const close = React.useCallback(() => setOpen(false), []);
    return (
      <>
        <View ref={anchorRef} collapsable={false}>
          {/* A phone's band keeps only quiet marks beside the title, so Invite is its glyph there. */}
          {phone ? (
            <IconButton
              testID="session-discussion-invite"
              iconName="user-plus"
              variant="plain"
              iconSize={ICON_SIZE.sm}
              size={34}
              accessibilityLabel={t('session.collaboration.discussion.invite.button')}
              expanded={open}
              hasPopup="dialog"
              minimumInteractiveTargetSize={minimumInteractiveTargetSize}
              onPress={() => setOpen((value) => !value)}
            />
          ) : (
            <ToolbarButton
              testID="session-discussion-invite"
              label={t('session.collaboration.discussion.invite.button')}
              icon={
                <Icon
                  name="plus"
                  size={ICON_SIZE.xs}
                  color={theme.colors.text.primary}
                />
              }
              onPress={() => setOpen((value) => !value)}
              size="sm"
            />
          )}
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
                // Which Discussion this adds to stays in view while the candidates scroll.
                header={<View style={inviteStyles.header}>
                  <DiscussionSheetHeader
                    icon="user-plus"
                    title={t('session.collaboration.discussion.invite.title', { title: props.discussionTitle })}
                    subtitle={t('session.collaboration.discussion.manage.inviteSubtitle')}
                  />
                </View>}
                // Where an agent invitation stands stays visible under any scroll position.
                footer={props.management ? <DiscussionParticipantOperationLine
                  management={props.management}
                  serverId={props.scope.serverId}
                /> : undefined}
              >
                <DiscussionInviteSheet
                  scope={props.scope}
                  {...(props.accountLifetime ? { accountLifetime: props.accountLifetime } : {})}
                  roster={props.roster ?? null}
                  management={props.management ?? null}
                  discussionId={props.discussionId}
                  discussionTitle={props.discussionTitle}
                  onChanged={props.onChanged}
                  onRequestClose={close}
                />
              </FloatingOverlay>
            )}
          </Popover>
        ) : null}
      </>
    );
  },
);
