import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionMessageAccountActorV1Schema,
  type SessionMessageAccountActorV1,
} from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { captureDocPassageV1 } from '@happier-dev/protocol/artifacts/artifactPassageV1';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import { DiscussionMessageContentV1Schema } from '@happier-dev/protocol/discussions/content';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import type { DiscussionRepositoryMutationOutcome } from '@/sync/ops/discussions/discussionRepository';
import type {
  DiscussionAnchorV1,
  DiscussionReplyTargetV1,
} from '@happier-dev/protocol/discussions/replyTargets';
import type { DiscussionMessageContentV1 } from '@happier-dev/protocol/discussions/content';
import {
  prepareDiscussionContentForPassage,
  prepareDiscussionContentForRecipients,
} from './discussionComposerDocument';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import type { SessionDiscussionDraftMutationAttempt } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import {
  createSessionFixture,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { activateStorageAccountScope } from '@/dev/testkit/runtime/storageRuntime';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { getStorage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { createWorkspaceNavigationAdapter } from '@/components/appShell/workspace/workspaceNavigationAdapter';
import {
  createWorkspaceState,
  reduceWorkspaceState,
} from '@/components/appShell/workspace/workspaceState';

const pane = vi.hoisted(() => ({
  openDetailsTab: vi.fn(),
  closeDetails: vi.fn(),
  closeDetailsTab: vi.fn(),
}));
const clipboard = vi.hoisted(() =>
  vi.fn<(value: string) => Promise<boolean>>(async () => true),
);
const focusComposer = vi.hoisted(() => vi.fn(() => true));
const routerPush = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
const deviceType = vi.hoisted(() => ({
  current: 'tablet' as 'tablet' | 'phone',
}));
const repositoryRetry = vi.hoisted(() => vi.fn());
const repositoryAdoptPendingIntent = vi.hoisted(() => vi.fn());
const repositoryRefreshDiscussion = vi.hoisted(() => vi.fn());
const repositoryCreate = vi.hoisted(() =>
  vi.fn(async () => ({ kind: 'failed', errorCode: 'test-stop' })),
);
const repositoryPost = vi.hoisted(() =>
  vi.fn(async () => ({ kind: 'failed', errorCode: 'test-stop' })),
);
const repositoryDismiss = vi.hoisted(() => vi.fn(() => true));
const launchability = vi.hoisted(() => ({ current: true }));
const shellSession = vi.hoisted(() => ({
  current: null as null | ReturnType<typeof createSessionFixture>,
}));
const repositoryRename = vi.hoisted(() =>
  vi.fn<() => Promise<DiscussionRepositoryMutationOutcome<unknown>>>(
    async () => ({ kind: 'succeeded', value: {} }),
  ),
);
const repositoryArchive = vi.hoisted(() =>
  vi.fn(async () => ({ kind: 'succeeded', value: {} })),
);
const repositoryRestore = vi.hoisted(() =>
  vi.fn(async () => ({ kind: 'succeeded', value: {} })),
);
const dropdownProps = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}));
const composerProps = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}));
const repositoryOptions = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}));
const readParticipants = vi.hoisted(() => vi.fn());
const transcriptProps = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}));
const observeVisibleMessageSeqs = vi.hoisted(() => vi.fn());
const updateVisibleReadEligibility = vi.hoisted(() => vi.fn());
const exactHomeBinding = vi.hoisted(() => ({
  current: {
    serverId: 'server-a',
    accountId: 'viewer',
    scope: { serverId: 'server-a', accountId: 'viewer' },
    revision: 1,
    isCurrent: (): boolean => true,
    onRetire: () => ({ dispose: () => undefined }),
  },
}));
const exactHomeBindings = vi.hoisted(() => ({
  current: new Map<string, typeof exactHomeBinding.current>(),
}));
const draftState = vi.hoisted(() => ({
  title: '',
  text: '',
  mentions: [] as readonly unknown[],
  passage: null as DocPassageRefV1 | null,
  pendingMutationAttempt: null as SessionDiscussionDraftMutationAttempt | null,
  status: 'clean' as
    | 'clean'
    | 'pending'
    | 'offline'
    | 'conflict'
    | 'error'
    | 'unsupported',
  conflict: null as null | { fields: readonly unknown[] },
  setComposer: vi.fn(),
  setTitle: vi.fn(),
  setPassage: vi.fn(),
  recipients: [] as readonly never[],
  setRecipients: vi.fn(),
  participants: [] as readonly never[],
  setParticipants: vi.fn(),
  // Keep the existing screen fixture on the real draft content binding, including inherited passage context.
  prepareContent: (
    content: DiscussionMessageContentV1,
    options?: Readonly<{
      replyTarget?: DiscussionReplyTargetV1;
      passage?: DocPassageRefV1 | null;
    }>,
  ): DiscussionMessageContentV1 =>
    prepareDiscussionContentForPassage({
      content: prepareDiscussionContentForRecipients({
        content,
        recipients: [],
        replyTarget: options?.replyTarget,
      }),
      passage: draftState.passage ?? options?.passage,
    }),
  captureSubmittedCurrentness: vi.fn(() => ({
    scope: { serverId: 'server-a', accountId: 'viewer' },
    address: { kind: 'newDiscussion' },
    currentness: { address: { kind: 'newDiscussion' }, mutationIds: {} },
  })),
  clearAfterObservedSuccess: vi.fn(),
  releaseSubmittedAttempt: vi.fn(),
  purgePresentation: vi.fn(async () => undefined),
  purgeSourcePresentation: vi.fn(async () => undefined),
}));
const activity = vi.hoisted(() => ({
  subagents: [] as unknown[],
  readExecutionRunEntry: vi.fn((_runId: string) => null as unknown),
}));
const metadataWrites = vi.hoisted(() =>
  vi.fn(
    async (
      _sessionId: string,
      update: (metadata: unknown) => unknown,
      options: unknown,
    ) => ({
      metadata: update({}),
      options,
    }),
  ),
);
function openedMessage(
  message: Omit<DiscussionOpenedMessageV1, 'messageRef'>,
  serverId = 'server-a',
): DiscussionOpenedMessageV1 {
  if (message.content === null)
    throw new Error('The committed fixture requires opened content');
  return {
    ...message,
    messageRef: createDiscussionMessageRefV1(
      { serverId, discussionId: message.discussionId },
      { ...message, content: { t: 'plain', v: message.content } },
    ),
  };
}

const snapshot = {
  mutations: {},
  lists: { active: { items: [] }, archived: { items: [] } },
  threads: {
    'discussion-a': {
      status: 'ready' as
        | 'idle'
        | 'loading'
        | 'ready'
        | 'offline'
        | 'locked'
        | 'error'
        | 'revoked',
      errorCode: null as string | null,
      hasMoreOlder: false,
      summary: {
        id: 'discussion-a',
        ownerAccountId: 'viewer',
        encryptionMode: 'plain',
        anchor: {
          kind: 'session',
          sessionId: 'session-a',
        } as DiscussionAnchorV1 | null,
        access: 'owner',
        keyReadiness: true,
        dataEncryptionKey: null,
        creationLocalId: null,
        title: 'Design',
        messageSeq: 1,
        latestMessage: {
          id: 'message-a',
          seq: 1,
          authorAccountId: 'account-private-123',
          accountActor: SessionMessageAccountActorV1Schema.parse({
            v: 1,
            accountId: 'account-private-123',
            profile: {
              firstName: 'Alice',
              lastName: null,
              username: null,
              avatarUrl: null,
            },
          }),
          producerV1: null,
          createdAt: 1,
        },
        lastReadSeq: null as number | null,
        unreadCount: 1,
        unreadMentionCount: 0,
        recentAuthorAccountIds: ['alice'],
        archivedAt: null as number | null,
        capabilities: {
          postMessages: true,
          rename: true,
          archive: true,
          restore: false,
          askAgent: true,
          sendToSession: true,
          manageAccess: true,
          leave: false,
        },
      },
      messages: [
        openedMessage({
          id: 'message-a',
          discussionId: 'discussion-a',
          localId: null,
          seq: 1,
          authorAccountId: 'account-private-123',
          producerV1: null,
          accountActor: SessionMessageAccountActorV1Schema.parse({
            v: 1,
            accountId: 'account-private-123',
            profile: {
              firstName: 'Alice',
              lastName: null,
              username: null,
              avatarUrl: null,
            },
          }),
          content: {
            v: 1,
            parts: [
              { t: 'text', text: 'Check this' },
              {
                t: 'mention',
                participant: {
                  kind: 'account',
                  accountId: 'mention-private-456',
                },
              },
            ],
          },
          mentionedAccountIds: ['mention-private-456'],
          createdAt: 1,
        }),
        openedMessage({
          id: 'message-agent',
          discussionId: 'discussion-a',
          localId: null,
          seq: 2,
          authorAccountId: 'account-private-123',
          accountActor: SessionMessageAccountActorV1Schema.parse({
            v: 1,
            accountId: 'account-private-123',
            profile: {
              firstName: 'Alice',
              lastName: null,
              username: null,
              avatarUrl: null,
            },
          }),
          producerV1: {
            v: 1,
            kind: 'agent',
            sessionId: 'session-a',
            runId: 'run-a',
          },
          content: { v: 1, parts: [{ t: 'text', text: 'Agent result' }] },
          mentionedAccountIds: [],
          createdAt: 2,
        }),
      ],
    },
  },
};

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({
    router: { push: routerPush, replace: routerReplace },
  }).module;
});
vi.mock('@/sync/api/discussions/discussionActions', () => ({
  createDiscussionClient: () => ({ participants: readParticipants }),
}));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
  useAppPaneScope: () => pane,
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => true,
}));
vi.mock('@/hooks/session/useSessionCollaborationAvailability', () => ({
  useSessionCollaborationAvailability: () => 'available',
}));
vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
  useServerCredentialAccountScopeBindings: () => exactHomeBindings.current,
}));
vi.mock('@/hooks/session/useSessionAgentActivity', () => ({
  useSessionAgentActivityRoster: () => activity,
}));
vi.mock('@/sync/ops/discussions/useDiscussionRepositorySnapshot', () => ({
  useDiscussionRepositorySnapshot: () => snapshot,
}));
vi.mock('@/sync/ops/discussions/discussionRepositoryRegistry', () => ({
  getDiscussionRepository: (options: Record<string, unknown>) => {
    repositoryOptions.current = options;
    return {
      scope: options.scope,
      mount: () => () => undefined,
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      // The Discussion menu's pause setting reads through the repository; this screen does not exercise it.
      getSettings: vi.fn(async () => ({
        kind: 'failed',
        errorCode: 'unavailable',
      })),
      setSettings: vi.fn(async () => ({
        kind: 'failed',
        errorCode: 'unavailable',
      })),
      refreshDiscussion: repositoryRefreshDiscussion,
      participants: readParticipants,
      setReadState: vi.fn(async () => ({
        kind: 'succeeded',
        value: { cursor: { lastReadSeq: 1 } },
      })),
      create: repositoryCreate,
      post: repositoryPost,
      adoptPendingIntent: repositoryAdoptPendingIntent,
      dismissFailure: repositoryDismiss,
      rename: repositoryRename,
      archive: repositoryArchive,
      restore: repositoryRestore,
      retry: repositoryRetry,
      acknowledgeObservedSuccess: vi.fn(),
      loadOlderMessages: vi.fn(),
    };
  },
}));
vi.mock('@/sync/domains/discussions/discussionVisibleReadController', () => ({
  createDiscussionVisibleReadController: () => ({
    updateEligibility: updateVisibleReadEligibility,
    observeVisibleMessageSeqs,
  }),
}));
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Dimensions: {
      get: () => ({
        width: deviceType.current === 'phone' ? 390 : 1440,
        height: 900,
        scale: 1,
        fontScale: 1,
      }),
    },
  });
});
vi.mock('@/utils/ui/clipboard', () => ({ setClipboardStringSafe: clipboard }));
vi.mock(
  '@/components/sessions/presentation/sessionComposerPresentationTargets',
  () => ({ requestRegisteredSessionComposerFocus: focusComposer }),
);
vi.mock('@/sync/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync/sync')>();
  return {
    ...actual,
    sync: new Proxy(
      {},
      {
        // Retain this suite's existing metadata-write double; cold acquisition uses the real owner.
        get: (_target, key) =>
          key === 'patchSessionMetadataWithRetry'
            ? metadataWrites
            : Reflect.get(actual.sync, key),
      },
    ),
  };
});
// The real provider module (the Run… start modal reads its context snapshot); only handler registration is stubbed.
vi.mock('@/keyboard/KeyboardShortcutProvider', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/keyboard/KeyboardShortcutProvider')
  >()),
  useKeyboardShortcutHandlers: () => true,
}));
vi.mock(
  '@/components/sessions/transcript/viewport/shell/TranscriptListShell',
  () => ({
    TranscriptListShell: (props: {
      data: readonly unknown[];
      renderItem: (input: { item: unknown }) => React.ReactNode;
    }) => {
      transcriptProps.current = props;
      return (
        <>
          {props.data.map((item, index) => (
            <React.Fragment key={index}>
              {props.renderItem({ item })}
            </React.Fragment>
          ))}
        </>
      );
    },
  }),
);
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (
    props: Record<string, unknown> & {
      trigger: (input: Record<string, unknown>) => React.ReactNode;
    },
  ) => {
    dropdownProps.current = props;
    return (
      <>
        {props.trigger({
          open: false,
          toggle: vi.fn(),
          openMenu: vi.fn(),
          closeMenu: vi.fn(),
          selectedItem: null,
        })}
      </>
    );
  },
}));
// The popover's portal and window measurement are the platform boundary; the sheet inside stays real.
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
    importOriginal,
  ),
);
function readComposerBadge(testID: string): Readonly<{ label: string; onPress?: () => void; onRemove?: () => void }> {
  const items = (composerProps.current?.contextItems ?? []) as ReadonlyArray<Readonly<{ testID?: string; label: string; onPress?: () => void; onRemove?: () => void }>>;
  const badge = items.find((item) => item.testID === testID);
  if (!badge) throw new Error(`no composer badge ${testID}`);
  return badge;
}
vi.mock('@/components/discussions/DiscussionComposer', () => ({
  DiscussionComposer: (props: Record<string, unknown>) => {
    composerProps.current = props;
    return null;
  },
}));
vi.mock('@/components/discussions/useDiscussionDraft', () => ({
  useDiscussionDraft: () => draftState,
}));
vi.mock('@/components/sessions/shell/sessionViewStableSession', () => ({
  useSessionViewShellSession: () => shellSession.current,
}));
vi.mock('@/hooks/session/useSessionExecutionRunLaunchability', () => ({
  useSessionExecutionRunLaunchability: () => ({
    canLaunchExecutionRuns: launchability.current,
    canShowExecutionRunLauncher: launchability.current,
    executionRunsBackends: {},
    executionRunsSupported: launchability.current,
    sessionServerId: 'server-a',
  }),
}));

import { DiscussionDetailsView } from '@/components/discussions/DiscussionDetailsView';
await loadSyncSingletonForTests();
let activeScope: Awaited<
  ReturnType<typeof activateStorageAccountScope>
> | null = null;
afterEach(async () => {
  await standardCleanup();
  activeScope?.dispose();
  activeScope = null;
});

import {
  consumeInteractiveExecutionRunDraftNavigationIntent,
  resetInteractiveExecutionRunDraftNavigationIntentsForTests,
} from '@/components/sessions/runs/launcher/interactiveExecutionRunDraftNavigationIntent';

async function press(
  screen: Awaited<ReturnType<typeof renderScreen>>,
  testID: string,
) {
  const node = screen.find(
    (item) =>
      item.props?.testID === testID && typeof item.props.onPress === 'function',
  );
  await act(async () => {
    await node.props.onPress();
  });
}

describe('DiscussionDetailsView selection', () => {
  beforeEach(async () => {
    activeScope = await activateStorageAccountScope(
      { serverId: 'server-a', accountId: 'viewer' },
      getStorage(),
    );
    const state = getStorage().getState();
    getStorage().setState({
      sessions: {},
      sessionListRowsByServerId: {},
      settings: {
        ...state.settings,
        transcriptBulkCopyFormat: 'markdown_labeled',
        transcriptMessageSendToSessionTemplate: '{{MESSAGES}}',
      },
    });
    readParticipants.mockReset().mockResolvedValue({
      kind: 'succeeded',
      value: DiscussionParticipantsListResponseV1Schema.parse({
        discussionId: 'discussion-a',
        ownerAccountId: 'viewer',
        access: 'owner',
        grants: [
          {
            principal: { kind: 'account', accountId: 'mention-private-456' },
            accessLevel: 'view',
            createdByAccountId: 'viewer',
            createdAt: 0,
            display: { name: 'Bob' },
          },
        ],
        participants: [],
      }),
    });
    pane.openDetailsTab.mockClear();
    pane.closeDetails.mockClear();
    pane.closeDetailsTab.mockClear();
    clipboard.mockClear();
    focusComposer.mockClear();
    routerPush.mockClear();
    routerReplace.mockClear();
    deviceType.current = 'tablet';
    resetInteractiveExecutionRunDraftNavigationIntentsForTests();
    metadataWrites.mockClear();
    repositoryRetry.mockClear();
    repositoryAdoptPendingIntent.mockClear();
    repositoryCreate.mockClear();
    repositoryPost.mockClear();
    repositoryDismiss.mockClear();
    launchability.current = true;
    shellSession.current = createSessionFixture({
      id: 'session-a',
      serverId: 'server-a',
    });
    repositoryRename.mockClear();
    repositoryArchive.mockClear();
    repositoryRestore.mockClear();
    dropdownProps.current = null;
    composerProps.current = null;
    repositoryOptions.current = null;
    exactHomeBinding.current = {
      serverId: 'server-a',
      accountId: 'viewer',
      scope: { serverId: 'server-a', accountId: 'viewer' },
      revision: 1,
      isCurrent: () => true,
      onRetire: () => ({ dispose: () => undefined }),
    };
    exactHomeBindings.current = new Map([
      [exactHomeBinding.current.serverId, exactHomeBinding.current],
    ]);
    draftState.title = '';
    draftState.text = '';
    draftState.mentions = [];
    draftState.passage = null;
    draftState.status = 'clean';
    draftState.conflict = null;
    draftState.pendingMutationAttempt = null;
    draftState.purgePresentation.mockClear();
    draftState.purgeSourcePresentation.mockClear();
    draftState.releaseSubmittedAttempt.mockClear();
    transcriptProps.current = null;
    observeVisibleMessageSeqs.mockClear();
    updateVisibleReadEligibility.mockClear();
    activity.subagents = [];
    activity.readExecutionRunEntry.mockReset().mockReturnValue(null);
    delete (snapshot.mutations as Record<string, unknown>)[
      'post-local-unknown'
    ];
    delete (snapshot.mutations as Record<string, unknown>)['post-local-failed'];
    delete (snapshot.mutations as Record<string, unknown>)[
      'create-local-failed'
    ];
    snapshot.threads['discussion-a'].status = 'ready';
    snapshot.threads['discussion-a'].errorCode = null;
    snapshot.threads['discussion-a'].summary.lastReadSeq = null;
    snapshot.threads['discussion-a'].summary.archivedAt = null;
    snapshot.threads['discussion-a'].summary.anchor = {
      kind: 'session',
      sessionId: 'session-a',
    };
    snapshot.threads['discussion-a'].summary.capabilities = {
      postMessages: true,
      rename: true,
      archive: true,
      restore: false,
      askAgent: true,
      sendToSession: true,
      manageAccess: true,
      leave: false,
    };
  });

  it.each(['tablet', 'phone'] as const)(
    'keeps a retained Session source unavailable, then opens its exact Home-qualified answer on %s',
    async (device) => {
      deviceType.current = device;
      const messages = snapshot.threads['discussion-a'].messages;
      snapshot.threads['discussion-a'].messages = [];
      try {
        snapshot.threads['discussion-a'].summary.anchor = {
          kind: 'session',
          sessionId: 'session-a',
          messageId: 'committed/answer',
        };
        const target = {
          kind: 'discussion' as const,
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        };
        let workspace = createWorkspaceState({
          id: 'discussion-tab',
          target: {
            kind: 'discussions',
            params: { discussionId: 'discussion-a', serverId: 'server-a' },
          },
          pinned: false,
          preview: false,
        });
        const catalog = resolveCompactAppDestinations({
          pages: [],
          builtins: {
            externalSessions: false,
            inbox: false,
            workflows: true,
            friends: false,
          },
        });
        const committedHrefs: string[] = [];
        const navigation = createWorkspaceNavigationAdapter({
          getState: () => workspace,
          getCatalog: () => catalog,
          getScope: () => ({ serverId: 'server-a', accountId: 'viewer' }),
          dispatch: (action) => {
            workspace = reduceWorkspaceState(workspace, action);
          },
          transport: {
            commit: (href) => {
              committedHrefs.push(href);
            },
          },
          createId: () => 'source-tab',
          onChange: () => undefined,
        });
        const screen = await renderScreen(
          <SurfaceStateSizeProvider
            size={device === 'phone' ? 'phone' : 'pane'}
          >
            <DestinationInstanceHost
              tabId="discussion-tab"
              ref={workspace.tabs['discussion-tab'].target}
              pathname="/discussions/discussion-a"
              focused
              visible
              navigation={{
                push: (href) => {
                  expect(typeof href).toBe('string');
                  expect(
                    navigation.openHref(String(href), {
                      tabId: 'discussion-tab',
                    }),
                  ).toBe(true);
                },
                replace: () => undefined,
                back: () => undefined,
              }}
            >
              <DiscussionDetailsView
                target={target}
                active
                standaloneSurface={device === 'phone'}
              />
            </DestinationInstanceHost>
          </SurfaceStateSizeProvider>,
        );
        const readOpen = (): (() => void) | undefined =>
          device === 'phone'
            ? screen
                .findAll(
                  (node) =>
                    node.props.triggerTestID ===
                      'session-discussion-actions-menu' &&
                    Array.isArray(node.props.actions),
                )[0]
                ?.props.actions.find(
                  (action: { id: string }) => action.id === 'open-anchor',
                )?.onSelect
            : screen.findAll(
                (node) =>
                  node.props.testID === 'session-discussion-anchor' &&
                  typeof node.props.onPress === 'function',
              )[0]?.props.onPress;
        expect(screen.getTextContent()).toContain('Source unavailable');
        expect(readOpen()).toBeUndefined();
        const source = createSessionFixture({
          id: 'session-a',
          serverId: 'server-a',
          metadata: { name: 'Release review', path: '/project', host: 'host' },
        });
        await act(async () => {
          getStorage().setState({
            sessionListRowsByServerId: {
              'server-a': {
                'session-a': buildSessionListRenderableFromSession(source),
              },
            },
          });
        });
        expect(getStorage().getState().sessions['session-a']).toBeUndefined();
        if (device === 'phone')
          await act(async () => {
            readOpen()!();
          });
        else await screen.pressByTestIdAsync('session-discussion-anchor');
        expect(committedHrefs).toHaveLength(1);
        const opened = new URL(committedHrefs[0]!, 'https://happier.invalid');
        expect(opened.pathname).toBe(
          '/session/session-a/message/server%3Acommitted%2Fanswer',
        );
        expect(opened.searchParams.get('serverId')).toBe('server-a');
        const activeTab =
          workspace.tabs[
            workspace.groups[workspace.focusedGroupId].activeTabId
          ];
        expect(activeTab.target.params).toMatchObject({
          id: 'session-a',
          serverId: 'server-a',
          messageId: 'server:committed/answer',
        });
        const retainedOpen = readOpen()!;
        committedHrefs.length = 0;
        await act(async () => {
          getStorage().setState({
            sessionListRowsByServerId: {
              'server-a': {
                'session-a': buildSessionListRenderableFromSession({
                  ...source,
                  metadata: null,
                  ownerMetadataView: null,
                  encryptionMode: 'e2ee',
                  encryptedContentAvailability: 'encrypted_content_unavailable',
                }),
              },
            },
          });
        });
        expect(screen.getTextContent()).toContain('Source unavailable');
        await act(async () => {
          retainedOpen();
        });
        expect(committedHrefs).toEqual([]);
        await act(async () => {
          getStorage().setState({
            sessionListRowsByServerId: {
              'server-b': {
                'session-a': buildSessionListRenderableFromSession(
                  createSessionFixture({
                    id: 'session-a',
                    serverId: 'server-b',
                    metadata: {
                      name: 'Other Home secret',
                      path: '/other',
                      host: 'host',
                    },
                  }),
                ),
              },
            },
          });
        });
        expect(screen.getTextContent()).toContain('Source unavailable');
        expect(screen.getTextContent()).not.toContain('Other Home secret');
        committedHrefs.length = 0;
        await act(async () => {
          retainedOpen();
        });
        expect(committedHrefs).toEqual([]);
        await act(async () => {
          getStorage().setState({
            sessionListRowsByServerId: {
              'server-a': {
                'session-a': buildSessionListRenderableFromSession(source),
              },
            },
          });
        });
        // Retiring the captured Account cannot turn a retained header callback into a new Account's navigation.
        exactHomeBinding.current.isCurrent = () => false;
        await act(async () => {
          readOpen()!();
        });
        expect(committedHrefs).toEqual([]);
      } finally {
        snapshot.threads['discussion-a'].messages = messages;
      }
    },
  );

  it('shows a private Task source and reply as unavailable without guessing a configured connection or exposing raw ids', async () => {
    const task = {
      kind: 'task' as const,
      entry: {
        source: { pluginId: 'tasks-source', localId: 'issues' },
        kindId: 'issue',
        collisionScope: 'private-scope',
        entryId: 'private-entry-id',
      },
    };
    snapshot.threads['discussion-a'].summary.anchor = task;
    const messages = snapshot.threads['discussion-a'].messages;
    const reply = messages[1]!;
    snapshot.threads['discussion-a'].messages = [
      { ...reply, replyTarget: task },
    ];
    try {
      const screen = await renderScreen(
        <DiscussionDetailsView
          target={{
            kind: 'discussion',
            address: { serverId: 'server-a' },
            discussionId: 'discussion-a',
          }}
          active
        />,
      );
      expect(
        screen.findByTestId(`discussion-reply-quote-${reply.id}.unavailable`),
      ).not.toBeNull();
      expect(screen.getTextContent()).toContain('Source unavailable');
      expect(screen.getTextContent()).not.toContain('private-entry-id');
      expect(
        screen.findAll(
          (node) =>
            node.props.testID === 'session-discussion-anchor' &&
            typeof node.props.onPress === 'function',
        ),
      ).toHaveLength(0);
    } finally {
      snapshot.threads['discussion-a'].messages = messages;
    }
  });

  it.each([
    [
      'a new conversation',
      { kind: 'new' as const, address: { serverId: 'server-a' } },
    ],
    [
      'an existing conversation',
      {
        kind: 'discussion' as const,
        address: { serverId: 'server-a' },
        discussionId: 'discussion-a',
      },
    ],
  ])(
    'keeps the empty editor available while Send alone remains unavailable for %s',
    async (_label, target) => {
      await renderScreen(<DiscussionDetailsView target={target} active />);

      expect(composerProps.current?.disabled).toBe(false);
      expect((composerProps.current?.value as { text: string }).text).toBe('');
    },
  );

  it('keeps a new Home Discussion usable when an optional source Session refuses input', async () => {
    draftState.text = 'Private draft I am still writing';
    const target = { kind: 'new' as const, address: { serverId: 'server-a' } };
    const screen = await renderScreen(
      <DiscussionDetailsView target={target} active />,
    );
    expect(composerProps.current?.disabled).toBe(false);

    // Known refusal from the exact Session's own access projection.
    shellSession.current = createSessionFixture({
      id: 'session-a',
      serverId: 'server-a',
      accessLevel: 'view',
    });
    await screen.update(<DiscussionDetailsView target={target} active />);

    expect(composerProps.current?.disabled).toBe(false);
    expect(screen.getTextContent()).not.toContain(
      'You can no longer post in this Session.',
    );
    // A write downgrade is not access loss: the private draft survives.
    expect(draftState.purgePresentation).not.toHaveBeenCalled();
    expect((composerProps.current?.value as { text: string }).text).toBe(
      'Private draft I am still writing',
    );

    shellSession.current = createSessionFixture({
      id: 'session-a',
      serverId: 'server-a',
      accessLevel: 'edit',
    });
    await screen.update(<DiscussionDetailsView target={target} active />);
    expect(composerProps.current?.disabled).toBe(false);
    expect((composerProps.current?.value as { text: string }).text).toBe(
      'Private draft I am still writing',
    );
  });

  it('keeps the new-conversation flow usable while the exact Session write capability is unknown', async () => {
    shellSession.current = null;
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{ kind: 'new', address: { serverId: 'server-a' } }}
        active
      />,
    );

    expect(composerProps.current?.disabled).toBe(false);
    expect(screen.getTextContent()).not.toContain(
      'You can no longer post in this Session.',
    );
  });

  it('shows the exact opened parent in a reply quote and withholds it when the source becomes unavailable', async () => {
    const messages = snapshot.threads['discussion-a'].messages;
    const parent = messages[0]!;
    const reply = messages[1]!;
    messages[1] = {
      ...reply,
      replyTarget: { kind: 'message', messageId: parent.id },
    };
    const target = {
      kind: 'discussion' as const,
      address: { serverId: 'server-a' },
      discussionId: 'discussion-a',
    };
    try {
      const screen = await renderScreen(
        <DiscussionDetailsView target={target} active />,
      );
      expect(
        screen.findByTestId(`discussion-reply-quote-${reply.id}.text`)?.props
          .children,
      ).toContain('Check this');
      await press(screen, `discussion-reply-quote-${reply.id}`);
      expect(routerPush).toHaveBeenCalledWith(
        expect.stringContaining('messageId=message-a'),
      );
      messages[0] = { ...parent, content: null };
      snapshot.threads['discussion-a'].messages = [...messages];
      await screen.update(<DiscussionDetailsView target={target} active />);
      expect(
        screen.findByTestId(`discussion-reply-quote-${reply.id}.text`),
      ).toBeNull();
      expect(
        screen.findByTestId(`discussion-reply-quote-${reply.id}.unavailable`),
      ).not.toBeNull();
    } finally {
      messages[0] = parent;
      messages[1] = reply;
      snapshot.threads['discussion-a'].messages = messages;
    }
  });

  it('shows the captured Doc passage in the real Doc-origin new Discussion draft', async () => {
    draftState.passage = captureDocPassageV1({
      ref: { kind: 'doc', artifactId: 'runbook', serverId: 'server-a' },
      revision: { headerVersion: 2, bodyVersion: 4 },
      source: 'Repeated passage. Selected passage.',
      range: { start: 18, end: 35 },
    });
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{ kind: 'new', address: { serverId: 'server-a' } }}
        active
      />,
    );
    // The passage is a composer badge, as a Session's context items are: it opens its Doc and can be dropped.
    expect(screen.findByTestId('discussion-draft-passage-quote')).toBeNull();
    const badge = readComposerBadge('discussion-composer-passage');
    expect(badge.label).toBe(draftState.passage.quote);
    draftState.setPassage.mockClear();
    routerPush.mockClear();
    await act(async () => { badge.onPress?.(); });
    expect(routerPush).toHaveBeenCalledWith('/artifacts/runbook');
    await act(async () => { badge.onRemove?.(); });
    expect(draftState.setPassage).toHaveBeenCalledWith(null);
  });

  it('shows the passage a thread is being re-attached to above its composer and lets the person drop it', async () => {
    draftState.passage = captureDocPassageV1({
      ref: { kind: 'doc', artifactId: 'runbook', serverId: 'server-a' },
      revision: { headerVersion: 2, bodyVersion: 5 },
      source: 'A reworded passage.',
      range: { start: 0, end: 19 },
    });
    draftState.setPassage.mockClear();
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );
    expect(screen.findByTestId('discussion-draft-passage-quote')).toBeNull();
    const badge = readComposerBadge('discussion-composer-passage');
    expect(badge.label).toBe(draftState.passage.quote);
    await act(async () => { badge.onRemove?.(); });
    expect(draftState.setPassage).toHaveBeenCalledWith(null);
  });

  it('quotes a passage once where its thread starts, not again on each reply about it', async () => {
    const messages = snapshot.threads['discussion-a'].messages;
    const [first, second] = [messages[0]!, messages[1]!];
    const ref = {
      kind: 'doc' as const,
      artifactId: 'runbook',
      serverId: 'server-a',
    };
    const passage = captureDocPassageV1({
      ref,
      revision: { headerVersion: 1, bodyVersion: 1 },
      source: 'The original passage.',
      range: { start: 0, end: 21 },
    });
    messages[0] = {
      ...first,
      content: DiscussionMessageContentV1Schema.parse({
        kind: 'doc_passage_comment',
        passage,
        content: { v: 1, parts: [{ t: 'text', text: 'Review this passage.' }] },
      }),
    };
    messages[1] = {
      ...second,
      content: DiscussionMessageContentV1Schema.parse({
        kind: 'doc_edit_proposal',
        proposal: {
          target: passage,
          baseRevision: passage.revision,
          before: passage.quote,
          after: 'A revised passage.',
          reason: 'Clarify.',
        },
      }),
    };
    try {
      const screen = await renderScreen(
        <DiscussionDetailsView
          target={{
            kind: 'discussion',
            address: { serverId: 'server-a' },
            discussionId: 'discussion-a',
          }}
          active
        />,
      );
      expect(
        screen.findByTestId(`discussion-reply-quote-${first.id}.text`)?.props
          .children,
      ).toBe(passage.quote);
      expect(
        screen.findByTestId(`discussion-reply-quote-${second.id}`),
      ).toBeNull();
      expect(
        screen.findByTestId(`discussion-proposal-${second.id}`),
      ).not.toBeNull();
    } finally {
      messages[0] = first;
      messages[1] = second;
    }
  });

  it.each(['doc_passage_comment', 'doc_edit_proposal'] as const)(
    'keeps the original passage basis visible for opened %s content',
    async (kind) => {
      const messages = snapshot.threads['discussion-a'].messages;
      const original = messages[0]!;
      const passage = captureDocPassageV1({
        ref: { kind: 'doc', artifactId: 'runbook', serverId: 'server-a' },
        revision: { headerVersion: 2, bodyVersion: 4 },
        source: 'The original passage.',
        range: { start: 0, end: 21 },
      });
      const content = DiscussionMessageContentV1Schema.parse(
        kind === 'doc_passage_comment'
          ? {
              kind,
              passage,
              content: {
                v: 1,
                parts: [{ t: 'text', text: 'Review this passage.' }],
              },
            }
          : {
              kind,
              proposal: {
                target: passage,
                baseRevision: passage.revision,
                before: passage.quote,
                after: 'A revised passage.',
                reason: 'Clarify the text.',
              },
            },
      );
      messages[0] = { ...original, content };
      try {
        const screen = await renderScreen(
          <DiscussionDetailsView
            target={{
              kind: 'discussion',
              address: { serverId: 'server-a' },
              discussionId: 'discussion-a',
            }}
            active
          />,
        );
        expect(
          screen.findByTestId(`discussion-reply-quote-${original.id}.text`)
            ?.props.children,
        ).toBe(passage.quote);
      } finally {
        messages[0] = original;
      }
    },
  );

  it('retains selected messages when its optional Session anchor disappears', async () => {
    const target = {
      kind: 'discussion' as const,
      address: { serverId: 'server-a' },
      discussionId: 'discussion-a',
    };
    const screen = await renderScreen(
      <DiscussionDetailsView target={target} active />,
    );
    await press(screen, 'session-discussion-select-message-a');
    expect(screen.findByTestId('transcript-selection-toolbar')).not.toBeNull();

    snapshot.threads['discussion-a'].summary.anchor = null;
    await screen.update(<DiscussionDetailsView target={target} active />);
    expect(composerProps.current?.disabled).toBe(false);
    await press(screen, 'transcript-selection-copy');
    expect(clipboard).toHaveBeenCalledWith('**Alice:**\n\nCheck this@Bob');
    expect(metadataWrites).not.toHaveBeenCalled();
  });

  it('exposes the conversation title as the details heading', async () => {
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    expect(
      screen.findByTestId('session-discussion-header.title')?.props
        .accessibilityRole,
    ).toBe('header');
  });

  it('presents recent authors, quiet lifecycle actions, producer-aware groups, and accessible timestamps', async () => {
    const messages = snapshot.threads['discussion-a']
      .messages as unknown as Array<
      (typeof snapshot.threads)['discussion-a']['messages'][number]
    >;
    messages.push({
      ...messages[1]!,
      id: 'message-agent-followup',
      seq: 3,
      content: { v: 1, parts: [{ t: 'text', text: 'Agent follow-up' }] },
      createdAt: 3,
    });
    try {
      const screen = await renderScreen(
        <DiscussionDetailsView
          target={{
            kind: 'discussion',
            address: { serverId: 'server-a' },
            discussionId: 'discussion-a',
          }}
          active
        />,
      );

      expect(
        screen.findByTestId('session-discussion-message-group-start-message-a'),
      ).not.toBeNull();
      expect(
        screen.findByTestId(
          'session-discussion-message-group-start-message-agent',
        ),
      ).not.toBeNull();
      expect(
        screen.findByTestId(
          'session-discussion-message-group-continuation-message-agent-followup',
        ),
      ).not.toBeNull();
      // One header per author group: a continuation carries no second name or time.
      expect(
        screen.findByTestId(
          'session-discussion-message-actor-message-agent-followup',
        ),
      ).toBeNull();
      expect(
        screen.findByTestId(
          'session-discussion-message-timestamp-message-agent-followup',
        ),
      ).toBeNull();

      const timestamp = screen.findByTestId(
        'session-discussion-message-timestamp-message-a',
      );
      expect(timestamp?.props.accessibilityRole).toBe('text');
      expect(timestamp?.props.accessibilityLabel).toBe(
        new Date(1).toLocaleString(),
      );

      expect(
        screen.findByTestId('session-discussion-actions-menu'),
      ).not.toBeNull();
      expect(dropdownProps.current?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'rename',
            title: 'Rename conversation',
          }),
          expect.objectContaining({
            id: 'archive',
            title: 'Archive conversation',
          }),
        ]),
      );
      expect(
        screen.tree.findAll(
          (item) => item.props?.accessibilityLabel === 'Rename conversation',
        ),
      ).toHaveLength(0);
      expect(
        screen.tree.findAll(
          (item) => item.props?.accessibilityLabel === 'Archive conversation',
        ),
      ).toHaveLength(0);
      await act(async () => {
        (dropdownProps.current?.onSelect as (itemId: string) => void)(
          'archive',
        );
      });
      expect(repositoryArchive).toHaveBeenCalledWith('discussion-a');
    } finally {
      messages.pop();
    }
  });

  it('keeps rename text and presents typed unknown/refusal outcomes until the next lifecycle success', async () => {
    repositoryRename
      .mockResolvedValueOnce({ kind: 'failed', errorCode: 'outcome_unknown' })
      .mockResolvedValueOnce({
        kind: 'failed',
        errorCode: 'discussion_manage_denied',
      })
      .mockResolvedValueOnce({ kind: 'succeeded', value: {} });
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    act(() => {
      (dropdownProps.current?.onSelect as (itemId: string) => void)('rename');
    });
    const input = screen.findByTestId('session-discussion-rename-input');
    act(() => input?.props.onChangeText('Still editing'));
    const save = screen.find(
      (item) =>
        item.props?.accessibilityLabel === 'Save' &&
        typeof item.props.onPress === 'function',
    );
    await act(async () => {
      await save.props.onPress();
    });

    expect(
      screen.findByTestId('session-discussion-rename-input')?.props.value,
    ).toBe('Still editing');
    expect(screen.getTextContent()).toContain('Delivery unknown');
    expect(screen.getTextContent()).not.toContain(
      'Conversations could not be loaded.',
    );

    await act(async () => {
      await save.props.onPress();
    });
    expect(
      screen.findByTestId('session-discussion-rename-input')?.props.value,
    ).toBe('Still editing');
    expect(screen.getTextContent()).toContain('Permission denied');
    expect(screen.getTextContent()).not.toContain(
      'Conversations could not be loaded.',
    );

    await act(async () => {
      await save.props.onPress();
    });
    expect(screen.getTextContent()).not.toContain('Permission denied');
    expect(screen.findByTestId('session-discussion-rename-input')).toBeNull();
  });

  it('binds details repository lifetime to the exact Session Home rather than the active Home', async () => {
    exactHomeBinding.current = {
      serverId: 'server-b',
      accountId: 'viewer-b',
      scope: { serverId: 'server-b', accountId: 'viewer-b' },
      revision: 4,
      isCurrent: () => true,
      onRetire: () => ({ dispose: () => undefined }),
    };
    exactHomeBindings.current = new Map([
      [exactHomeBinding.current.serverId, exactHomeBinding.current],
    ]);

    await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-b' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    expect(repositoryOptions.current).toEqual(
      expect.objectContaining({
        scope: { serverId: 'server-b', accountId: 'viewer-b' },
        address: { serverId: 'server-b' },
        accountLifetime: exactHomeBinding.current,
      }),
    );
  });

  it('creates with an optional title derived from the first nonempty message line', async () => {
    draftState.text = '\n  Release status  \nPlease review';
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{ kind: 'new', address: { serverId: 'server-a' } }}
        active
      />,
    );

    expect(composerProps.current?.disabled).toBe(false);
    await act(async () => {
      await (
        composerProps.current?.onSend as (content: unknown) => Promise<void>
      )({ v: 1, parts: [{ t: 'text', text: draftState.text }] });
    });
    expect(repositoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Release status' }),
    );
    expect(screen.findByTestId('session-discussion-title')).not.toBeNull();
  });

  it('keeps a mention-only first message as a draft until the user supplies a title', async () => {
    draftState.text = '@Alex';
    draftState.mentions = [{ start: 0, end: 5, accountId: 'account-a' }];
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{ kind: 'new', address: { serverId: 'server-a' } }}
        active
      />,
    );

    await act(async () => {
      await (
        composerProps.current?.onSend as (content: unknown) => Promise<void>
      )({
        v: 1,
        parts: [
          {
            t: 'mention',
            participant: { kind: 'account', accountId: 'account-a' },
          },
        ],
      });
    });

    expect(repositoryCreate).not.toHaveBeenCalled();
    expect(
      screen.findByTestId('session-discussion-title-required')?.props.children,
    ).toBe('Add a title to start this conversation.');
    expect((composerProps.current?.value as { text: string }).text).toBe(
      '@Alex',
    );
  });

  it('opens a linked execution Run through the canonical Run Details command', async () => {
    activity.subagents = [
      {
        id: 'execution_run:run-linked',
        kind: 'execution_run',
        status: 'running',
        display: { title: 'Linked run' },
        transcript: {},
        runRef: {
          runId: 'run-linked',
          launchOrigin: {
            kind: 'discussion',
            serverId: 'server-a',
            discussionId: 'discussion-a',
            messageIds: ['message-a'],
          },
        },
        recipient: null,
        capabilities: {
          canOpen: true,
          canSend: false,
          canStop: false,
          canLaunchChild: false,
          canDelete: false,
          canOpenAdvancedRun: true,
        },
        timestamps: {},
      },
    ];
    activity.readExecutionRunEntry.mockReturnValue({
      id: 'execution_run:run-linked',
      kind: 'execution_run',
      status: 'running',
      title: 'Linked run',
      metaDetail: null,
      startedAtMs: 1,
      endedAtMs: null,
      provenance: 'local',
      detailState: 'loaded',
      parentId: null,
      runId: 'run-linked',
      sidechainId: null,
      subagentId: 'execution_run:run-linked',
      attentionKinds: [],
    });
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    await press(screen, 'session-discussion-agent-activity:run-linked');
    expect(pane.openDetailsTab).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'executionRun',
        resource: { kind: 'executionRun', runId: 'run-linked' },
      }),
      { intent: 'preview' },
    );
  });

  it('selects a trusted Agent-posted row with its Session label and Via Agent attribution, and keeps Run cards ineligible', async () => {
    activity.subagents = [
      {
        id: 'execution_run:run-linked',
        kind: 'execution_run',
        status: 'running',
        display: { title: 'Linked run' },
        transcript: {},
        runRef: {
          runId: 'run-linked',
          launchOrigin: {
            kind: 'discussion',
            serverId: 'server-a',
            discussionId: 'discussion-a',
            messageIds: ['message-a'],
          },
        },
        recipient: null,
        capabilities: {
          canOpen: true,
          canSend: false,
          canStop: false,
          canLaunchChild: false,
          canDelete: false,
          canOpenAdvancedRun: true,
        },
        timestamps: {},
      },
    ];
    activity.readExecutionRunEntry.mockReturnValue({
      id: 'execution_run:run-linked',
      kind: 'execution_run',
      status: 'running',
      title: 'Linked run',
      metaDetail: null,
      startedAtMs: 1,
      endedAtMs: null,
      provenance: 'local',
      detailState: 'loaded',
      parentId: null,
      runId: 'run-linked',
      sidechainId: null,
      subagentId: 'execution_run:run-linked',
      attentionKinds: [],
    });
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    // A Run activity card is a resource reference, never a selectable message.
    expect(
      screen.tree.findAll(
        (item) =>
          typeof item.props?.testID === 'string' &&
          item.props.testID.startsWith('session-discussion-select-run'),
      ),
    ).toHaveLength(0);

    await press(screen, 'session-discussion-select-message-agent');
    await press(screen, 'transcript-selection-copy');
    expect(clipboard).toHaveBeenCalledWith(
      '**Session participant · Via Agent:**\n\nAgent result',
    );
    expect(clipboard.mock.calls[0]?.[0]).not.toContain('Assistant');
    expect(clipboard.mock.calls[0]?.[0]).not.toContain('account-private-123');

    await press(screen, 'session-discussion-selection-ask-agent');
    expect(pane.openDetailsTab).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'executionRunLauncher',
        resource: expect.objectContaining({
          initialInstructions: '**Session participant · Via Agent:**\n\nAgent result',
          source: expect.objectContaining({
            kind: 'discussion',
            serverId: 'server-a',
            discussionId: 'discussion-a',
            messageIds: ['message-agent'],
          }),
        }),
      }),
      { intent: 'preview' },
    );
  });

  it('keeps the select mark out of the reading until a fine pointer hovers the row or selection mode starts', async () => {
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );
    const slotRevealed = (messageId: string) => {
      const slot = screen.findByTestId(
        `session-discussion-select-slot-${messageId}`,
      );
      const style = [slot?.props.style]
        .flat(Infinity)
        .reduce<Record<string, unknown>>(
          (all, part) => ({ ...all, ...(part ?? {}) }),
          {},
        );
      return style.pointerEvents !== 'none';
    };
    expect(slotRevealed('message-a')).toBe(false);
    expect(slotRevealed('message-agent')).toBe(false);

    const row = screen.findByTestId(
      'session-discussion-message-group-start-message-a',
    );
    await act(async () => {
      row?.props.onPointerEnter();
    });
    expect(slotRevealed('message-a')).toBe(true);
    expect(slotRevealed('message-agent')).toBe(false);
    await act(async () => {
      row?.props.onPointerLeave();
    });
    expect(slotRevealed('message-a')).toBe(false);

    // Once selecting, every eligible row carries its mark.
    await press(screen, 'session-discussion-select-message-a');
    expect(slotRevealed('message-agent')).toBe(true);
  });

  it('offers Save as decision on a committed message and opens the sheet for that exact message', async () => {
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );
    expect(screen.findByTestId('save-memory-decision')).toBeNull();
    await press(screen, 'session-discussion-save-decision-message-a');
    expect(screen.findByTestId('save-memory-decision')).toBeTruthy();
    expect(
      screen.findByTestId('save-memory-decision.text')?.props.value,
    ).toContain('Check this');
  });

  it('mounts row selection, copies canonical labeled text, and opens the interactive Agent draft', async () => {
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    expect(
      screen.findAllByType('EnrichedMarkdownText')[0]?.props.markdown,
    ).toBe('Check this[Bob](happier-ref:account:mention-private-456)');
    expect(
      screen.findByTestId('session-discussion-message-actor-message-a')?.props
        .children,
    ).toBe('Alice');
    expect(
      screen.findByTestId('session-discussion-message-actor-message-agent')
        ?.props.children,
    ).toBe('Session participant');
    expect(
      screen.findByTestId('session-discussion-message-producer-message-agent')
        ?.props.children,
    ).toBe('Via Agent');

    await press(screen, 'session-discussion-select-message-a');
    await press(screen, 'transcript-selection-copy');
    expect(clipboard).toHaveBeenCalledWith('**Alice:**\n\nCheck this@Bob');
    expect(clipboard.mock.calls[0]?.[0]).not.toContain('account-private-123');

    await press(screen, 'session-discussion-selection-ask-agent');
    expect(pane.openDetailsTab).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'executionRunLauncher',
        resource: expect.objectContaining({
          kind: 'executionRunLauncher',
          mode: 'conversation',
          initialInstructions: '**Alice:**\n\nCheck this@Bob',
          source: expect.objectContaining({
            kind: 'discussion',
            serverId: 'server-a',
            discussionId: 'discussion-a',
            messageIds: ['message-a'],
            draftCorrelationId: expect.any(String),
          }),
        }),
      }),
      { intent: 'preview' },
    );
  });

  it('signs every Agent answer as its own Session: the title when it has one, otherwise its Agent', async () => {
    // A Workflow-spawned reviewer answers with no person's request stamped on it; it is still not the
    // Account owner speaking.
    const titled = createSessionFixture({
      id: 'session-a',
      serverId: 'server-a',
    });
    getStorage().setState({
      sessions: {
        [titled.id]: {
          ...titled,
          metadata: { ...titled.metadata!, name: 'Fresh reviewer 1' },
        },
      },
    });
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );
    expect(
      screen.findByTestId('session-discussion-message-actor-message-agent')
        ?.props.children,
    ).toBe('Fresh reviewer 1');
    expect(
      screen.findByTestId('session-discussion-message-producer-message-agent')
        ?.props.children,
    ).toBe('Via Agent');

    // Untitled no-folder Session: its Agent names it, never the generic "New chat".
    await act(async () => {
      getStorage().setState({
        sessions: {
          [titled.id]: {
            ...titled,
            metadata: {
              ...titled.metadata!,
              flavor: 'codex',
              sessionDirectoryV1: { v: 1, kind: 'managed' },
            },
          },
        },
      });
    });
    expect(
      screen.findByTestId('session-discussion-message-actor-message-agent')
        ?.props.children,
    ).toBe('Codex');
  });

  it('leaves Open run to the Run itself: neither a Session answer in a Workflow round nor the Workflow\'s own result repeats it', async () => {
    const messages = snapshot.threads['discussion-a']
      .messages as unknown as Array<
      (typeof snapshot.threads)['discussion-a']['messages'][number]
    >;
    const agent = messages[1]!;
    const { messageRef: _agentRef, ...base } = agent;
    const round = {
      runId: 'run-w',
      invocationRecordId: 'invocation-w',
      invocationAttempt: '0',
    };
    messages[1] = openedMessage({
      ...base,
      producerV1: {
        v: 1,
        kind: 'agent',
        sessionId: 'session-a',
        runId: 'run-w',
        replyReturn: {
          serverId: 'server-a',
          requestLocalId: 'request-w',
          outcome: 'answer',
          workflow: round,
        },
      },
    });
    messages.push(
      openedMessage({
        ...base,
        id: 'message-workflow',
        seq: 3,
        createdAt: 3,
        producerV1: {
          v: 1,
          kind: 'workflow',
          ...round,
          execution: {
            kind: 'action',
            actionId: 'workflow.discussion.round.project',
          },
          outcome: 'answer',
        },
        content: { v: 1, parts: [{ t: 'text', text: 'Workflow result' }] },
      }),
    );
    try {
      const screen = await renderScreen(
        <DiscussionDetailsView
          target={{
            kind: 'discussion',
            address: { serverId: 'server-a' },
            discussionId: 'discussion-a',
          }}
          active
        />,
      );
      // The run's header carries Open run; the result it published reads as the message it is.
      expect(
        screen.findByTestId(
          'session-discussion-workflow-open-message-workflow',
        ),
      ).toBeNull();
      expect(
        screen.findByTestId('session-discussion-workflow-open-message-agent'),
      ).toBeNull();
      // The answer still says what it read.
      expect(
        screen.findByTestId('session-discussion-message-cutoff-message-agent'),
      ).not.toBeNull();
    } finally {
      messages.pop();
      messages[1] = agent;
    }
  });

  it('gives each speaker its own face: a person their avatar, an Agent answer its Agent mark, a Workflow result the Run mark', async () => {
    const messages = snapshot.threads['discussion-a']
      .messages as unknown as Array<
      (typeof snapshot.threads)['discussion-a']['messages'][number]
    >;
    const agent = messages[1]!;
    const { messageRef: _agentRef, ...base } = agent;
    const round = {
      runId: 'run-w',
      invocationRecordId: 'invocation-w',
      invocationAttempt: '0',
    };
    messages.push(
      openedMessage({
        ...base,
        id: 'message-workflow',
        seq: 3,
        createdAt: 3,
        producerV1: {
          v: 1,
          kind: 'workflow',
          ...round,
          execution: {
            kind: 'action',
            actionId: 'workflow.discussion.round.project',
          },
          outcome: 'answer',
        },
        content: { v: 1, parts: [{ t: 'text', text: 'Workflow result' }] },
      }),
    );
    try {
      const screen = await renderScreen(
        <DiscussionDetailsView
          target={{
            kind: 'discussion',
            address: { serverId: 'server-a' },
            discussionId: 'discussion-a',
          }}
          active
        />,
      );
      // The Agent answer is stamped with the asking person's Account, but that person did not write it.
      expect(
        screen.findByTestId('session-discussion-message-face-person-message-a'),
      ).not.toBeNull();
      expect(
        screen.findByTestId(
          'session-discussion-message-face-agent-message-agent',
        ),
      ).not.toBeNull();
      expect(
        screen.findByTestId(
          'session-discussion-message-face-person-message-agent',
        ),
      ).toBeNull();
      expect(
        screen.findByTestId(
          'session-discussion-message-face-workflow-message-workflow',
        ),
      ).not.toBeNull();
      expect(
        screen.findByTestId(
          'session-discussion-message-face-person-message-workflow',
        ),
      ).toBeNull();
    } finally {
      messages.pop();
    }
  });

  it('names a typed Session mention only through its accessible exact-Home title and refuses unknown selection text', async () => {
    const messages = snapshot.threads['discussion-a'].messages;
    messages.push(
      openedMessage({
        id: 'message-session-mention',
        discussionId: 'discussion-a',
        localId: null,
        seq: 3,
        authorAccountId: 'account-private-123',
        accountActor: messages[0]!.accountActor,
        producerV1: null,
        createdAt: 3,
        content: {
          v: 1,
          parts: [
            { t: 'text', text: 'Ask ' },
            {
              t: 'mention',
              participant: {
                kind: 'session',
                sessionId: 'private-participant-session',
              },
            },
          ],
        },
        mentionedAccountIds: [],
      }),
    );
    const participant = createSessionFixture({
      id: 'private-participant-session',
      serverId: 'server-b',
    });
    const namedParticipant = {
      ...participant,
      metadata: { ...participant.metadata!, name: 'Review agent' },
    };
    getStorage().setState({ sessions: { [participant.id]: namedParticipant } });
    try {
      const screen = await renderScreen(
        <DiscussionDetailsView
          target={{
            kind: 'discussion',
            address: { serverId: 'server-a' },
            discussionId: 'discussion-a',
          }}
          active
        />,
      );
      expect(screen.getTextContent()).not.toContain('Review agent');
      const reference = screen
        .findAllByType(MarkdownView)
        .find(
          (node) =>
            node.props.testID ===
            'session-discussion-message-content-message-session-mention',
        )!;
      expect(
        reference.props.inlineReferences.resolve(
          'session:private-participant-session',
        ),
      ).toMatchObject({ label: 'Session participant' });
      const run = screen
        .findAllByType('EnrichedMarkdownText')
        .find((node) => node.props.markdown.startsWith('Ask '))!;
      await act(async () => {
        run.props.onLinkPress({
          url: 'happier-ref:session:private-participant-session',
        });
      });
      expect(routerPush).not.toHaveBeenCalled();
      await press(screen, 'session-discussion-select-message-session-mention');
      await press(screen, 'transcript-selection-copy');
      expect(clipboard).not.toHaveBeenCalled();

      await act(async () => {
        getStorage().setState({
          sessions: {
            [participant.id]: { ...namedParticipant, serverId: 'server-a' },
          },
        });
      });
      expect(
        screen
          .findAllByType('EnrichedMarkdownText')
          .some(
            (node) =>
              node.props.markdown ===
              'Ask [Review agent](happier-ref:session:private-participant-session)',
          ),
      ).toBe(true);
      await press(screen, 'transcript-selection-copy');
      expect(clipboard).toHaveBeenCalledWith('**Alice:**\n\nAsk @Review agent');
    } finally {
      messages.pop();
    }
  });

  it('preserves selection and composer handoff state when Send to Session fails, then retries once', async () => {
    metadataWrites
      .mockRejectedValueOnce(new Error('temporary metadata write failure'))
      .mockImplementationOnce(async (_sessionId, update, options) => ({
        metadata: update({}),
        options,
      }));
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    await press(screen, 'session-discussion-select-message-a');
    await press(screen, 'transcript-selection-send');

    expect(metadataWrites).toHaveBeenCalledTimes(1);
    expect(pane.closeDetails).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    expect(focusComposer).not.toHaveBeenCalled();
    expect(
      screen.findByTestId('transcript-selection-toolbar-count')?.props.children,
    ).toBe('1 message selected');
    const announcements = screen.root.findAll(
      (node) =>
        typeof node.type === 'string' &&
        node.props.role === 'status' &&
        node.findAll(
          (child) =>
            child.props.testID === 'session-discussion-selection-handoff-error',
        ).length > 0,
    );
    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.props.accessibilityLiveRegion).toBe('polite');
    expect(announcements[0]?.props['aria-live']).toBe('polite');
    expect(screen.getTextContent()).toContain(
      'The selected messages could not be added to the Session composer.',
    );

    await press(screen, 'session-discussion-selection-handoff-retry');

    expect(metadataWrites).toHaveBeenCalledTimes(2);
    expect(metadataWrites).toHaveBeenLastCalledWith(
      'session-a',
      expect.any(Function),
      { serverId: 'server-a' },
    );
    expect(pane.closeDetails).toHaveBeenCalledTimes(1);
    expect(focusComposer).toHaveBeenCalledTimes(1);
    expect(routerReplace).not.toHaveBeenCalled();
    expect(
      screen.findByTestId('session-discussion-selection-handoff-error'),
    ).toBeNull();
  });

  it('uses the safe historical fallback without exposing a deleted Account id', async () => {
    type MutableActorMessage = Omit<
      (typeof snapshot.threads)['discussion-a']['messages'][number],
      'accountActor'
    > & { accountActor: SessionMessageAccountActorV1 };
    const message = snapshot.threads['discussion-a']
      .messages[0]! as MutableActorMessage;
    const agentMessage = snapshot.threads['discussion-a']
      .messages[1]! as MutableActorMessage;
    const originalActor = message.accountActor;
    const originalAgentActor = agentMessage.accountActor;
    message.accountActor = {
      v: 1,
      accountId: 'account-private-123',
      profile: null,
    };
    agentMessage.accountActor = {
      v: 1,
      accountId: 'account-private-123',
      profile: null,
    };
    try {
      const screen = await renderScreen(
        <DiscussionDetailsView
          target={{
            kind: 'discussion',
            address: { serverId: 'server-a' },
            discussionId: 'discussion-a',
          }}
          active
        />,
      );
      const label = screen.findByTestId(
        'session-discussion-message-actor-message-a',
      )?.props.children;
      expect(label).toBe('Former member');
      expect(JSON.stringify(screen.tree.toJSON())).not.toContain(
        'account-private-123',
      );
    } finally {
      message.accountActor = originalActor;
      agentMessage.accountActor = originalAgentActor;
    }
  });

  it('keeps the generic author label when authenticated historical actor evidence is absent', async () => {
    type MutableActorMessage = Omit<
      (typeof snapshot.threads)['discussion-a']['messages'][number],
      'accountActor'
    > & { accountActor: SessionMessageAccountActorV1 | null };
    const message = snapshot.threads['discussion-a']
      .messages[0]! as MutableActorMessage;
    const agentMessage = snapshot.threads['discussion-a']
      .messages[1]! as MutableActorMessage;
    const originalActor = message.accountActor;
    const originalAgentActor = agentMessage.accountActor;
    message.accountActor = null;
    agentMessage.accountActor = null;
    try {
      const screen = await renderScreen(
        <DiscussionDetailsView
          target={{
            kind: 'discussion',
            address: { serverId: 'server-a' },
            discussionId: 'discussion-a',
          }}
          active
        />,
      );
      expect(
        screen.findByTestId('session-discussion-message-actor-message-a')?.props
          .children,
      ).toBe('Collaborator');
      expect(
        screen.findByTestId('session-discussion-message-actor-message-a')?.props
          .children,
      ).not.toBe('Presence Alice');
    } finally {
      message.accountActor = originalActor;
      agentMessage.accountActor = originalAgentActor;
    }
  });

  it('fails closed instead of attaching a mismatched safe profile to another author id', async () => {
    type MutableActorMessage = Omit<
      (typeof snapshot.threads)['discussion-a']['messages'][number],
      'accountActor'
    > & { accountActor: SessionMessageAccountActorV1 };
    const message = snapshot.threads['discussion-a']
      .messages[0]! as MutableActorMessage;
    const originalActor = message.accountActor;
    message.accountActor = {
      v: 1,
      accountId: 'different-private-account',
      profile: {
        name: 'Mallory',
        firstName: 'Mallory',
        lastName: null,
        username: null,
        avatarUrl: null,
      },
    };
    try {
      const screen = await renderScreen(
        <DiscussionDetailsView
          target={{
            kind: 'discussion',
            address: { serverId: 'server-a' },
            discussionId: 'discussion-a',
          }}
          active
        />,
      );
      expect(
        screen.findByTestId('session-discussion-message-actor-message-a')?.props
          .children,
      ).toBe('Collaborator');
      expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Mallory');
      expect(JSON.stringify(screen.tree.toJSON())).not.toContain(
        'different-private-account',
      );
    } finally {
      message.accountActor = originalActor;
    }
  });

  it('appends through the exact Home metadata owner, then reveals and focuses the primary composer', async () => {
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    await press(screen, 'session-discussion-select-message-a');
    await press(screen, 'transcript-selection-send');

    expect(metadataWrites).toHaveBeenCalledTimes(1);
    expect(metadataWrites.mock.calls[0]?.[0]).toBe('session-a');
    expect(metadataWrites.mock.calls[0]?.[2]).toEqual({ serverId: 'server-a' });
    expect(metadataWrites.mock.results[0]?.value).toBeInstanceOf(Promise);
    const written = await metadataWrites.mock.results[0]!.value;
    expect(written.metadata).toEqual(
      expect.objectContaining({
        sessionInitialPromptV1: expect.objectContaining({
          mode: 'append',
          source: {
            kind: 'discussion',
            serverId: 'server-a',
            discussionId: 'discussion-a',
            messageIds: ['message-a'],
          },
        }),
      }),
    );
    expect(pane.closeDetails).toHaveBeenCalledTimes(1);
    expect(focusComposer).toHaveBeenCalledWith({
      serverId: 'server-a',
      sessionId: 'session-a',
    });
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('returns from the phone discussion route to the exact Session and focuses after its composer registers', async () => {
    deviceType.current = 'phone';
    snapshot.threads['discussion-a'].summary.anchor = {
      kind: 'session',
      sessionId: 'session/a',
    };
    exactHomeBinding.current = {
      ...exactHomeBinding.current,
      serverId: 'https://home.example.test:8443',
      scope: {
        serverId: 'https://home.example.test:8443',
        accountId: 'viewer',
      },
    };
    exactHomeBindings.current = new Map([
      [exactHomeBinding.current.serverId, exactHomeBinding.current],
    ]);
    const originalMessages = snapshot.threads['discussion-a'].messages;
    activeScope?.dispose();
    activeScope = await activateStorageAccountScope(
      exactHomeBinding.current.scope,
      getStorage(),
    );
    shellSession.current = createSessionFixture({
      id: 'session/a',
      serverId: exactHomeBinding.current.serverId,
    });
    snapshot.threads['discussion-a'].messages = originalMessages.map(
      ({ messageRef: _messageRef, ...message }) =>
        openedMessage(message, exactHomeBinding.current.serverId),
    );
    try {
      const screen = await renderScreen(
        <DiscussionDetailsView
          target={{
            kind: 'discussion',
            address: { serverId: 'https://home.example.test:8443' },
            discussionId: 'discussion-a',
          }}
          active
        />,
      );

      await press(screen, 'session-discussion-select-message-a');
      await press(screen, 'transcript-selection-send');

      expect(metadataWrites.mock.calls[0]?.[0]).toBe('session/a');
      expect(metadataWrites.mock.calls[0]?.[2]).toEqual({
        serverId: 'https://home.example.test:8443',
      });
      expect(routerReplace).toHaveBeenCalledWith(
        '/session/session%2Fa?serverId=https%3A%2F%2Fhome.example.test%3A8443',
      );
      expect(pane.closeDetails).not.toHaveBeenCalled();
      expect(focusComposer).toHaveBeenCalledWith({
        serverId: 'https://home.example.test:8443',
        sessionId: 'session/a',
      });
    } finally {
      snapshot.threads['discussion-a'].messages = originalMessages;
    }
  });

  it("authors the viewer's own unacknowledged message with their name, not as a generic collaborator", async () => {
    // The viewer's own signed-in profile, scoped to the exact Home the conversation lives on.
    const current = getStorage().getState().profile;
    getStorage().setState({
      profileScope: { serverId: 'server-a', accountId: 'viewer' },
      profile: {
        ...current!,
        name: 'Maya Chen',
        firstName: 'Maya',
        lastName: 'Chen',
        username: 'maya',
      },
    });
    (snapshot.mutations as Record<string, unknown>)['post-local-unknown'] = {
      kind: 'post',
      localId: 'post-local-unknown',
      discussionId: 'discussion-a',
      status: 'outcome_unknown',
      errorCode: 'outcome_unknown',
      content: { v: 1, parts: [{ t: 'text', text: 'Checklist reviewed' }] },
      mentionedAccountIds: [],
      draftSubmission: {
        scope: { serverId: 'server-a', accountId: 'viewer' },
        address: { kind: 'discussion', discussionId: 'discussion-a' },
        currentness: { v: 1, fields: {} },
      },
    };
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );
    expect(
      screen.findByTestId('session-discussion-message-actor-post-local-unknown')
        ?.props.children,
    ).toBe('Maya Chen');
  });

  it('presents a settled unknown outcome distinctly and retries the retained identity only on request', async () => {
    (snapshot.mutations as Record<string, unknown>)['post-local-unknown'] = {
      kind: 'post',
      localId: 'post-local-unknown',
      discussionId: 'discussion-a',
      status: 'outcome_unknown',
      errorCode: 'outcome_unknown',
      content: { v: 1, parts: [{ t: 'text', text: 'Uncertain message' }] },
      mentionedAccountIds: [],
      draftSubmission: {
        scope: { serverId: 'server-a', accountId: 'viewer' },
        address: { kind: 'discussion', discussionId: 'discussion-a' },
        currentness: { v: 1, fields: {} },
      },
    };
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    expect(
      screen.findByTestId(
        'session-discussion-message-status-post-local-unknown',
      )?.props.accessibilityLiveRegion,
    ).toBe('polite');
    expect(
      screen
        .findAllByType(MarkdownView)
        .find(
          (node) =>
            node.props.testID ===
            'session-discussion-message-content-post-local-unknown',
        )?.props.markdown,
    ).toBe('Uncertain message');
    expect(
      screen.findByTestId('session-discussion-mutation-retry')?.props,
    ).toEqual(
      expect.objectContaining({
        accessibilityRole: 'button',
        accessibilityLabel: 'Try again',
      }),
    );
    expect(repositoryRetry).not.toHaveBeenCalled();
    await press(screen, 'session-discussion-mutation-retry');
    expect(repositoryRetry).toHaveBeenCalledWith('post-local-unknown');
  });

  it('keeps retained messages and draft visible offline while disabling mutation controls', async () => {
    snapshot.threads['discussion-a'].status = 'offline';
    snapshot.threads['discussion-a'].errorCode = 'offline';

    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    expect(
      screen.findByTestId('session-discussion-message-content-message-a'),
    ).not.toBeNull();
    expect(screen.getTextContent()).toContain(
      'You’re offline. Reconnect to continue.',
    );
    expect(composerProps.current?.disabled).toBe(true);
    expect(dropdownProps.current?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'rename', disabled: true }),
        expect.objectContaining({ id: 'archive', disabled: true }),
      ]),
    );
  });

  it('renders Account and Session mentions through the shared inline chips and opens the exact Home Session', async () => {
    const messages = snapshot.threads['discussion-a'].messages;
    const original = messages[0]!;
    const { messageRef: _messageRef, ...message } = original;
    messages[0] = openedMessage({
      ...message,
      content: DiscussionMessageContentV1Schema.parse({
        v: 1,
        parts: [
          { t: 'text', text: 'Ask ' },
          {
            t: 'mention',
            participant: { kind: 'account', accountId: 'mention-private-456' },
          },
          { t: 'text', text: ' about ' },
          {
            t: 'mention',
            participant: { kind: 'session', sessionId: 'review-session' },
          },
        ],
      }),
    });
    const session = createSessionFixture({
      id: 'review-session',
      serverId: 'server-a',
    });
    getStorage().setState({
      sessions: {
        [session.id]: {
          ...session,
          metadata: { ...session.metadata!, name: 'Auth fix' },
        },
      },
    });
    try {
      const screen = await renderScreen(
        <DiscussionDetailsView
          target={{
            kind: 'discussion',
            address: { serverId: 'server-a' },
            discussionId: 'discussion-a',
          }}
          active
        />,
      );

      const run = screen
        .findAllByType('EnrichedMarkdownText')
        .find((node) => node.props.markdown.includes('Ask [Bob]'));
      expect(run).toBeDefined();
      expect(run!.props.markdown).toBe(
        'Ask [Bob](happier-ref:account:mention-private-456) about [Auth fix](happier-ref:session:review-session)',
      );
      const markdown = screen
        .findAllByType(MarkdownView)
        .find(
          (node) =>
            node.props.testID ===
            'session-discussion-message-content-message-a',
        )!;
      expect(
        markdown.props.inlineReferences.resolve('account:mention-private-456'),
      ).toMatchObject({ label: 'Bob', glyph: 'assigned' });
      expect(
        markdown.props.inlineReferences.resolve('session:review-session'),
      ).toMatchObject({ label: 'Auth fix', glyph: 'conversations' });
      await act(async () => {
        run!.props.onLinkPress({ url: 'happier-ref:session:review-session' });
      });
      expect(routerPush).toHaveBeenCalledWith(
        '/session/review-session?serverId=server-a',
      );
      await press(screen, 'session-discussion-select-message-a');
      await press(screen, 'transcript-selection-copy');
      expect(clipboard).toHaveBeenCalledWith(
        '**Alice:**\n\nAsk @Bob about @Auth fix',
      );
    } finally {
      messages[0] = original;
    }
  });

  it('keeps retained messages under one freshness line whose Retry re-reads the conversation', async () => {
    snapshot.threads['discussion-a'].status = 'offline';
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    expect(screen.findByTestId('session-discussion-freshness')).not.toBeNull();
    expect(
      screen.findByTestId('session-discussion-message-content-message-a'),
    ).not.toBeNull();
    repositoryRefreshDiscussion.mockClear();
    await press(screen, 'session-discussion-freshness-action');
    expect(repositoryRefreshDiscussion).toHaveBeenCalledWith('discussion-a');
  });

  it('offers Close tab when access to the conversation is removed', async () => {
    const thread = snapshot.threads['discussion-a'];
    const previousStatus = thread.status;
    thread.status = 'revoked';
    try {
      const screen = await renderScreen(
        <DiscussionDetailsView
          target={{
            kind: 'discussion',
            address: { serverId: 'server-a' },
            discussionId: 'discussion-a',
          }}
          active
        />,
      );

      expect(screen.getTextContent()).toContain(
        'You no longer have access to this conversation',
      );
      await press(screen, 'session-discussion-details-state-action');
      expect(pane.closeDetails).toHaveBeenCalled();
    } finally {
      thread.status = previousStatus;
    }
  });

  it.each([
    ['offline', 'This conversation isn’t available offline', true],
    ['locked', 'Can’t open this conversation on this device yet', true],
    ['error', 'Couldn’t open this conversation', true],
    ['revoked', 'You no longer have access to this conversation', false],
  ] as const)(
    'renders the distinct empty %s recovery state before any content is available',
    async (status, expected, retryable) => {
      const thread = snapshot.threads['discussion-a'];
      const previousStatus = thread.status;
      const previousSummary = thread.summary;
      const previousMessages = thread.messages;
      thread.status = status;
      thread.summary = null as never;
      thread.messages = [] as never;
      try {
        const screen = await renderScreen(
          <DiscussionDetailsView
            target={{
              kind: 'discussion',
              address: { serverId: 'server-a' },
              discussionId: 'discussion-a',
            }}
            active
          />,
        );

        expect(screen.getTextContent()).toContain(expected);
        expect(
          screen.findByTestId('session-discussion-details-state-action') !==
            null,
        ).toBe(true);
        // Recoverable states offer Try again; a removed access offers Close tab instead.
        expect(screen.getTextContent().includes('Try again')).toBe(retryable);
      } finally {
        thread.status = previousStatus;
        thread.summary = previousSummary;
        thread.messages = previousMessages;
      }
    },
  );

  it.each([
    ['offline', 'This conversation isn’t available offline'],
    ['locked', 'Can’t open this conversation on this device yet'],
    ['error', 'Couldn’t open this conversation'],
  ] as const)(
    'says a failed %s read in the thread\u2019s own words, never as the list\u2019s empty or load-error copy',
    async (status, expected) => {
      const thread = snapshot.threads['discussion-a'];
      const previousStatus = thread.status;
      const previousMessages = thread.messages;
      thread.status = status;
      thread.messages = [] as never;
      try {
        const screen = await renderScreen(
          <DiscussionDetailsView
            target={{ kind: 'discussion', address: { serverId: 'server-a' }, discussionId: 'discussion-a' }}
            active
          />,
        );

        const text = screen.getTextContent();
        expect(text).toContain(expected);
        expect(text).not.toContain('No active conversations yet.');
        expect(text).not.toContain('Conversations could not be loaded.');
        expect(text).not.toContain('Delivery unknown');
        expect(screen.findByTestId('session-discussion-empty')).toBeNull();
        expect(screen.findByTestId('session-discussion-freshness')).toBeNull();
        repositoryRefreshDiscussion.mockClear();
        await press(screen, 'session-discussion-thread-state-action');
        expect(repositoryRefreshDiscussion).toHaveBeenCalledWith('discussion-a');
      } finally {
        thread.status = previousStatus;
        thread.messages = previousMessages;
      }
    },
  );

  it('presents an archived conversation as readable and restorable without a composer', async () => {
    snapshot.threads['discussion-a'].summary.archivedAt = 10;
    snapshot.threads['discussion-a'].summary.capabilities = {
      postMessages: false,
      rename: false,
      archive: false,
      restore: true,
      askAgent: false,
      sendToSession: false,
      manageAccess: true,
      leave: false,
    };

    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    expect(
      screen.findByTestId('session-discussion-message-content-message-a'),
    ).not.toBeNull();
    expect(screen.getTextContent()).toContain('This conversation is archived.');
    expect(dropdownProps.current?.items).toEqual([
      expect.objectContaining({
        id: 'save-as-pattern',
        testID: 'discussion-save-as-pattern',
      }),
      expect.objectContaining({ id: 'restore', title: 'Restore conversation' }),
    ]);
    expect(composerProps.current).toBeNull();
  });

  it('names the Home that cannot sync this draft and keeps the conversation usable', async () => {
    draftState.status = 'unsupported';

    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    // Not the generic load error, and not a dead composer: the draft is kept
    // on this device and the conversation still accepts messages.
    expect(screen.getTextContent()).toContain(
      'Not synced — this Home can’t sync this draft',
    );
    expect(screen.getTextContent()).not.toContain(
      'Conversations could not be loaded.',
    );
    expect(composerProps.current?.disabled).toBe(false);
  });

  it('renders the canonical V2 draft conflict resolution for a Discussion field', async () => {
    draftState.status = 'conflict';
    draftState.conflict = {
      fields: [
        {
          fieldId: 'composer.text',
          path: { kind: 'composer', field: 'text' },
          mine: 'My local reply',
          synced: 'Reply from another device',
        },
      ],
    };

    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    expect(
      screen.findByTestId('session-draft-conflict:composer.text'),
    ).not.toBeNull();
    expect(composerProps.current?.disabled).toBe(true);
  });

  it('never advances the private cursor from a locally optimistic message frontier', async () => {
    (snapshot.mutations as Record<string, unknown>)['post-local-optimistic'] = {
      kind: 'post',
      localId: 'post-local-optimistic',
      discussionId: 'discussion-a',
      status: 'sending',
      content: { v: 1, parts: [{ t: 'text', text: 'Optimistic' }] },
      mentionedAccountIds: [],
      draftSubmission: {
        scope: { serverId: 'server-a', accountId: 'viewer' },
        address: { kind: 'discussion', discussionId: 'discussion-a' },
        currentness: {
          address: { kind: 'discussion', discussionId: 'discussion-a' },
          mutationIds: {},
        },
      },
    };
    await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );
    const optimistic = (
      transcriptProps.current?.data as readonly {
        kind: string;
        message?: { id: string; seq: number };
      }[]
    ).find(
      (item) =>
        item.kind === 'human_message' &&
        item.message?.id === 'post-local-optimistic',
    );

    await act(async () => {
      (
        transcriptProps.current?.onViewableItemsChanged as (
          input: unknown,
        ) => void
      )({
        viewableItems: [{ isViewable: true, item: optimistic }],
      });
    });

    expect(observeVisibleMessageSeqs).toHaveBeenLastCalledWith([]);
    delete (snapshot.mutations as Record<string, unknown>)[
      'post-local-optimistic'
    ];
  });

  it('retries a pending visible-read frontier when the canonical repository refreshes after reconnect', async () => {
    snapshot.threads['discussion-a'].summary.lastReadSeq = 0;
    const target = {
      kind: 'discussion' as const,
      address: { serverId: 'server-a' },
      discussionId: 'discussion-a',
    };
    const screen = await renderScreen(
      <DiscussionDetailsView target={target} active />,
    );
    const callsBeforeRefresh = updateVisibleReadEligibility.mock.calls.length;

    snapshot.threads['discussion-a'].status = 'loading';
    await screen.update(<DiscussionDetailsView target={target} active />);

    expect(updateVisibleReadEligibility.mock.calls.length).toBeGreaterThan(
      callsBeforeRefresh,
    );
    expect(updateVisibleReadEligibility).toHaveBeenLastCalledWith({
      activeAndVisible: true,
      lastReadSeq: 0,
    });
  });

  it('purges draft presentation and decrypted rows when access is explicitly revoked', async () => {
    const thread = snapshot.threads['discussion-a'];
    const previousStatus = thread.status;
    thread.status = 'revoked';
    try {
      const screen = await renderScreen(
        <DiscussionDetailsView
          target={{
            kind: 'discussion',
            address: { serverId: 'server-a' },
            discussionId: 'discussion-a',
          }}
          active
        />,
      );
      await vi.waitFor(() =>
        expect(draftState.purgePresentation).toHaveBeenCalled(),
      );
      expect(
        screen.findByTestId('session-discussion-message-content-message-a'),
      ).toBeNull();
    } finally {
      thread.status = previousStatus;
    }
  });

  it('purges source material from the private draft when the Doc source becomes unavailable', async () => {
    const thread = snapshot.threads['discussion-a'];
    const previous = {
      status: thread.status,
      errorCode: thread.errorCode,
      messages: thread.messages,
    };
    thread.status = 'locked';
    thread.errorCode = 'discussion_content_unavailable';
    thread.messages = [];
    try {
      await renderScreen(
        <DiscussionDetailsView
          target={{
            kind: 'discussion',
            address: { serverId: 'server-a' },
            discussionId: 'discussion-a',
          }}
          active
        />,
      );
      await vi.waitFor(() =>
        expect(draftState.purgeSourcePresentation).toHaveBeenCalled(),
      );
      expect(draftState.purgePresentation).not.toHaveBeenCalled();
    } finally {
      Object.assign(thread, previous);
    }
  });

  it('offers Ask Agent only while the Session can launch an interactive run', async () => {
    launchability.current = false;
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    await press(screen, 'session-discussion-select-message-a');
    expect(
      screen.findByTestId('session-discussion-selection-ask-agent'),
    ).toBeNull();
    expect(screen.findByTestId('transcript-selection-send')).not.toBeNull();
  });

  function failedPost(errorCode: string, recovery: 'retry' | 'dismiss') {
    (snapshot.mutations as Record<string, unknown>)['post-local-failed'] = {
      kind: 'post',
      localId: 'post-local-failed',
      discussionId: 'discussion-a',
      status: 'failed',
      errorCode,
      recovery,
      content: { v: 1, parts: [{ t: 'text', text: 'Refused message' }] },
      mentionedAccountIds: [],
      draftSubmission: {
        scope: { serverId: 'server-a', accountId: 'viewer' },
        address: { kind: 'discussion', discussionId: 'discussion-a' },
        currentness: {
          address: { kind: 'discussion', discussionId: 'discussion-a' },
          mutationIds: {},
        },
      },
    };
  }

  it('re-enables the composer after a definitive refusal, names the reason, and dismisses it with the draft intact', async () => {
    failedPost('discussion_invalid_mention', 'dismiss');
    draftState.text = 'Refused message';
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    expect(composerProps.current?.disabled).toBe(false);
    expect(
      screen.findByTestId('session-discussion-message-status-post-local-failed')
        ?.props.children,
    ).toBe('Someone you mentioned can no longer read this Session.');
    expect(screen.findByTestId('session-discussion-mutation-retry')).toBeNull();

    await press(screen, 'session-discussion-mutation-dismiss');
    expect(draftState.releaseSubmittedAttempt).toHaveBeenCalledTimes(1);
    expect(repositoryDismiss).toHaveBeenCalledWith('post-local-failed');
    expect((composerProps.current?.value as { text: string }).text).toBe(
      'Refused message',
    );
  });

  it('keeps a transient failure retryable under its own reason', async () => {
    failedPost('offline', 'retry');
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    expect(composerProps.current?.disabled).toBe(true);
    expect(
      screen.findByTestId('session-discussion-message-status-post-local-failed')
        ?.props.children,
    ).toBe('You’re offline. Reconnect to continue.');
    expect(
      screen.findByTestId('session-discussion-mutation-dismiss'),
    ).toBeNull();
    await press(screen, 'session-discussion-mutation-retry');
    expect(repositoryRetry).toHaveBeenCalledWith('post-local-failed');
  });

  it('replaces a dismissable refusal with a fresh attempt on the next send', async () => {
    failedPost('discussion_archived', 'dismiss');
    draftState.text = 'Second try';
    await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    await act(async () => {
      await (
        composerProps.current?.onSend as (content: unknown) => Promise<void>
      )({ v: 1, parts: [{ t: 'text', text: 'Second try' }] });
    });

    expect(repositoryDismiss).toHaveBeenCalledWith('post-local-failed');
    expect(repositoryPost).toHaveBeenCalledTimes(1);
    expect(
      (repositoryPost.mock.calls[0] as unknown as [{ localId: string }])[0]
        .localId,
    ).not.toBe('post-local-failed');
  });

  it('lets a refused conversation creation be dismissed and drafted again', async () => {
    (snapshot.mutations as Record<string, unknown>)['create-local-failed'] = {
      kind: 'create',
      localId: 'create-local-failed',
      messageLocalId: 'create-message-failed',
      status: 'failed',
      errorCode: 'discussion_post_denied',
      recovery: 'dismiss',
      content: {
        v: 1,
        parts: [
          { t: 'text', text: 'Refused opener ' },
          {
            t: 'mention',
            participant: { kind: 'account', accountId: 'mention-private-456' },
          },
        ],
      },
      mentionedAccountIds: [],
      draftSubmission: {
        scope: { serverId: 'server-a', accountId: 'viewer' },
        address: { kind: 'newDiscussion' },
        currentness: { address: { kind: 'newDiscussion' }, mutationIds: {} },
      },
    };
    draftState.text = 'Refused opener';
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{ kind: 'new', address: { serverId: 'server-a' } }}
        active
      />,
    );

    expect(composerProps.current?.disabled).toBe(false);
    expect(
      screen
        .findAllByType('EnrichedMarkdownText')
        .some(
          (node) =>
            node.props.markdown ===
            'Refused opener [Collaborator](happier-ref:account:mention-private-456)',
        ),
    ).toBe(true);
    expect(
      screen.findByTestId(
        'session-discussion-message-status-create-message-failed',
      )?.props.children,
    ).toBe('You can no longer post in this Session.');
    expect(screen.findByTestId('session-discussion-mutation-retry')).toBeNull();

    await press(screen, 'session-discussion-mutation-dismiss');
    expect(draftState.releaseSubmittedAttempt).toHaveBeenCalledTimes(1);
    expect(repositoryDismiss).toHaveBeenCalledWith('create-local-failed');
  });

  it('hands mobile Ask Agent to the qualified Run route without exposing selected text in history', async () => {
    deviceType.current = 'phone';
    const screen = await renderScreen(
      <DiscussionDetailsView
        target={{
          kind: 'discussion',
          address: { serverId: 'server-a' },
          discussionId: 'discussion-a',
        }}
        active
      />,
    );

    await press(screen, 'session-discussion-select-message-a');
    await press(screen, 'session-discussion-selection-ask-agent');

    expect(pane.openDetailsTab).not.toHaveBeenCalled();
    const href = routerPush.mock.calls[0]?.[0] as string;
    expect(href).toMatch(
      /^\/session\/session-a\/runs\/new\?serverId=server-a&draftCorrelationId=/,
    );
    expect(href).not.toContain('Check');
    const correlationId = new URL(
      `https://example.test${href}`,
    ).searchParams.get('draftCorrelationId');
    expect(
      consumeInteractiveExecutionRunDraftNavigationIntent({
        address: { serverId: 'server-a', sessionId: 'session-a' },
        correlationId: correlationId ?? '',
      }),
    ).toEqual({
      initialText: '**Alice:**\n\nCheck this@Bob',
      source: {
        kind: 'discussion',
        serverId: 'server-a',
        discussionId: 'discussion-a',
        messageIds: ['message-a'],
        draftCorrelationId: correlationId,
      },
    });
  });
});
