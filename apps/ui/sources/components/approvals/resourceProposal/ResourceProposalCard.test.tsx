import {
  renderWithSessionTranscriptSource,
  createTestSessionTranscriptSource,
} from '@/dev/testkit';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
  API_TOKEN_FULL_GRANT_V1,
  ApprovalRequestSchema,
  ApprovalRequestV2Schema,
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  StrictJsonValueSchema,
  buildApprovalRequestArtifactHeaderV1,
  computeExternalActionRequestEnvelopeDigestV1,
  encodePlainArtifactStoredContent,
  signExternalActionApprovalInputV1,
  type ApprovalRequestV2,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type {
  MachineStorageTrashMoveInputV1,
  PileApplyResultV1,
  PileReviewV1,
} from '@happier-dev/protocol/storage/storageV1';
import tweetnacl from 'tweetnacl';

import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createServerScopedMachineRpcBoundaryMock } from '@/dev/testkit/mocks/serverScopedRpc';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import {
  createMachineFixture,
  createPlainMachineRowFixture,
} from '@/dev/testkit/fixtures/machineFixtures';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Real boundaries only: the Home (artifacts, machine census) and the Machine network. The card, the
// approval decision owner, the Action front door, narrowing and the storage clients all run for real.
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
const daemonRpc = vi.hoisted(() =>
  vi.fn<Parameters<typeof createServerScopedMachineRpcBoundaryMock>[0]>(),
);
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => createServerScopedMachineRpcBoundaryMock(daemonRpc),
);

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    View: (props: any) => React.createElement('View', props, props.children),
    Pressable: (props: any) =>
      React.createElement('Pressable', props, props.children),
    ActivityIndicator: (props: any) =>
      React.createElement('ActivityIndicator', props, null),
  });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@expo/vector-icons', () => ({
  Ionicons: (props: any) => React.createElement('Ionicons', props, null),
}));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: { push: vi.fn() } }).module;
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/components/ui/text/Text', () => ({
  Text: (props: any) => React.createElement('Text', props, props.children),
}));
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock().module;
});

await loadSyncSingletonForTests();
const { ApprovalPromptCard } =
  await import('@/components/tools/shell/approvals/ApprovalPromptCard');
const { storage } = await import('@/sync/domains/state/storage');
const { createSessionFixture } =
  await import('@/dev/testkit/fixtures/sessionFixtures');
const initialState = storage.getState();

const GB = 1_000_000_000;
const MACHINE = 'machine-exact';
const ids = [
  'wt-merged',
  'node-modules',
  'turbo',
  'runtime-build',
  'playwright',
  'old-wt',
] as const;
const ref = (itemId: string) => ({
  itemId,
  path: `/Users/leeroy/happier/${itemId}`,
  identity: {
    dev: '1',
    ino: `${ids.indexOf(itemId as never) + 2}`,
    kind: 'directory' as const,
  },
  collectedAt: 1,
  collectedBy: { accountId: 'account-1', kind: 'agent' as const },
});
const proposalArgs: MachineStorageTrashMoveInputV1 = {
  machineId: MACHINE,
  items: ids.map((itemId) => ({
    ref: ref(itemId),
    expect: `claimed-${itemId}`,
    claimedVerdict: 'safe' as const,
    reason: { code: 'rebuilds' as const },
  })),
};
const size = (bytes: number) => ({
  allocatedBytes: bytes,
  freesBytes: bytes,
  sharedBytes: 0,
  sharedExtentsUnmeasured: false,
  atLeast: false,
});

let homeId: string;
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;
let checkExpect: (itemId: string) => string;

function signed(request: ApprovalRequestV2): ApprovalRequestV2 {
  const origin = request.executionOriginV1;
  if (
    !origin.machineId ||
    !origin.target ||
    !origin.serverIdentityId ||
    !origin.accountId ||
    !origin.principalId ||
    !origin.credentialId
  ) {
    throw new Error('API admission fixture is incomplete');
  }
  const authorization = {
    v: 1 as const,
    token: 'approval-invocation-authorization',
    binding: {
      serverIdentityId: origin.serverIdentityId,
      accountId: origin.accountId,
      custodianAccountId: origin.accountId,
      installationId: 'installation-exact',
      principalId: origin.principalId,
      credentialId: origin.credentialId,
      grant: API_TOKEN_FULL_GRANT_V1,
      machineId: origin.machineId,
      actionId: request.actionId,
      requestId: origin.requestId,
      target: origin.target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({
        v: 1,
        requestId: origin.requestId,
        target: origin.target,
        input: StrictJsonValueSchema.parse(request.actionArgs),
      }),
    },
  };
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
  return ApprovalRequestV2Schema.parse({
    ...request,
    executionOriginV1: {
      ...origin,
      externalActionExecutionAuthorization: authorization,
      externalActionInputSignature: signExternalActionApprovalInputV1({
        authorizationToken: authorization.token,
        actionId: request.actionId,
        target: origin.target,
        input: request.actionArgs,
        privateKey: key.secretKey,
      }),
    },
  });
}

function proposal(
  overrides: Partial<ApprovalRequestV2> = {},
): ApprovalRequestV2 {
  const base: ApprovalRequestV2 = {
    v: 2,
    status: 'open',
    createdAtMs: 1,
    updatedAtMs: 1,
    createdBy: { surface: 'system', sessionId: 'session-1' },
    requestedSurface: 'api',
    executionOriginV1: {
      v: 1,
      authority: 'account_automation',
      surface: 'api',
      caller: { kind: 'host' },
      serverId: 'local-A',
      serverIdentityId: 'srv_stable-home-a',
      accountId: 'account-1',
      principalId: 'principal-1',
      credentialId: 'credential-1',
      sessionId: 'session-1',
      machineId: MACHINE,
      target: { kind: 'session', sessionId: 'session-1' },
      actionId: 'machines.storage.trash.move',
      requestId: 'request-1',
    },
    actionId: 'machines.storage.trash.move',
    actionArgs: proposalArgs,
    summary: 'Find 20 GB to free on leeroy-mbp',
  };
  return overrides.status && overrides.status !== 'open'
    ? ApprovalRequestV2Schema.parse({ ...signed(base), ...overrides })
    : signed(base);
}

async function seed(request: ApprovalRequestV2) {
  const response = await home.artifacts(homeId).handle('/v1/artifacts', {
    method: 'POST',
    body: JSON.stringify({
      id: 'approval-1',
      header: encodePlainArtifactStoredContent(
        buildApprovalRequestArtifactHeaderV1(request),
      ),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }),
  });
  expect(response?.ok).toBe(true);
}

const readApproval = () =>
  ApprovalRequestSchema.parse(
    JSON.parse(home.artifacts(homeId).readPlainBody('approval-1') ?? 'null'),
  );
const calls = (method: string) =>
  daemonRpc.mock.calls
    .map(([call]) => call)
    .filter((call) => call.method === method);

async function render(request: ApprovalRequestV2) {
  await seed(request);
  return renderWithSessionTranscriptSource(
    <ApprovalPromptCard
      artifact={{ id: 'approval-1', header: { title: null, serverId: homeId } }}
      approval={request}
      sessionId="session-1"
      canApprove
    />,
    createTestSessionTranscriptSource({
      sessionId: 'session-1',
      interaction: { canSendMessages: true, canApprovePermissions: true },
      actions: {
        respondToPermission: async () => {},
        answerUserAction: async () => {},
        abort: async () => {},
        submitMessage: async () => {},
      },
    }),
  );
}

describe('resource proposal card', () => {
  beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    await home.reset();
    homeId = await home.addHome({
      name: 'Home A',
      serverUrl: 'https://proposal-home.example',
      serverIdentityId: 'srv_stable-home-a',
      accountId: 'account-1',
    });
    home.answer(homeId, 'GET /v1/machines', {
      body: [
        {
          ...createPlainMachineRowFixture({
            id: MACHINE,
            accountId: 'account-1',
          }),
          installationId: 'installation-exact',
        },
      ],
    });
    storage.setState({
      sessions: {
        'session-1': createSessionFixture({
          id: 'session-1',
          serverId: homeId,
        }),
      },
      machines: {},
      machineListByServerId: {
        [homeId]: [
          createMachineFixture({
            id: MACHINE,
            activeAt: Date.now(),
            storageMode: 'plain',
            isShared: false,
          }),
        ],
      },
      machineListStatusByServerId: { [homeId]: 'idle' },
    });
    checkExpect = (itemId) => `claimed-${itemId}`;
    daemonRpc.mockReset();
    daemonRpc.mockImplementation(async (call) => {
      const payload = (call.payload ?? {}) as {
        refs?: ReadonlyArray<{ itemId: string }>;
        items?: unknown[];
      };
      switch (call.method) {
        case RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK: {
          const review: PileReviewV1 = {
            items: (payload.refs ?? []).map((entry) => ({
              ref: ref(entry.itemId),
              expect: checkExpect(entry.itemId),
              verdict: 'safe',
              reason: { code: 'rebuilds' },
              size: size(GB),
              absorbs: [],
            })),
            staying: [],
            countedOnceBytes: 6 * GB,
            totalFreesBytes: 6 * GB,
            trashVolumes: [],
          };
          return review;
        }
        case RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_DECLINE:
          return { revision: 2, declinedCount: payload.items?.length ?? 0 };
        case RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE: {
          const items = (payload.items ?? []) as Array<{ ref: { itemId: string } }>;
          return { batchId: 'batch-ui', mode: 'trash', inTrashBytes: items.length * GB, freedBytes: 0,
            outcomes: items.map((item) => ({ itemId: item.ref.itemId, status: 'moved' })) };
        }
        case RPC_METHODS.MACHINES_PROCESSES_START_AGAIN:
          return { status: 'started' };
        case RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE:
          return { outcomes: [{ entryId: 'entry-old-wt', status: 'restored' }] };
        case RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY:
          return {
            outcomes: ids
              .slice(0, 5)
              .map((itemId) => ({
                entryId: `entry-${itemId}`,
                status: 'deleted',
              })),
            freedBytes: 5 * GB,
          };
        case RPC_METHODS.DAEMON_STORAGE_WATCH:
          return new Promise(() => {});
        case RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED:
          return { ok: true, result: { status: 'executed' } };
        default:
          return undefined;
      }
    });
  });
  afterEach(async () => {
    standardCleanup();
    await home.reset();
    storage.setState(initialState, true);
    webLocks?.restore();
    webLocks = undefined;
  });

  it('approves 5 of 6 with refreshed expectations, then remembers the sixth as declined', async () => {
    checkExpect = (itemId) => `fresh-${itemId}`;
    const screen = await render(proposal());
    // The facts changed since the agent looked: nothing is approvable until it is checked again.
    await vi.waitFor(() =>
      expect(screen.findByTestId('resource-proposal-stale')).toBeTruthy(),
    );
    await screen.pressByTestIdAsync('resource-proposal-check-again');
    await vi.waitFor(() =>
      expect(screen.findByTestId('resource-proposal-stale')).toBeNull(),
    );
    await screen.pressByTestIdAsync('resource-proposal-item-old-wt');
    await screen.pressByTestIdAsync('approval-prompt-approve');
    await vi.waitFor(() =>
      expect(readApproval()).toMatchObject({
        status: 'approved',
        decision: { kind: 'approve' },
      }),
    );
    const decision =
      readApproval().v === 2
        ? (readApproval() as ApprovalRequestV2).decision
        : undefined;
    const kept = (
      decision?.narrowedInput as {
        items: Array<{ ref: { itemId: string }; expect: string }>;
      }
    ).items;
    expect(kept.map((item) => item.ref.itemId)).toEqual(ids.slice(0, 5));
    expect(kept.map((item) => item.expect)).toEqual(
      ids.slice(0, 5).map((itemId) => `fresh-${itemId}`),
    );
    await vi.waitFor(() =>
      expect(
        calls(RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_DECLINE),
      ).toHaveLength(1),
    );
    expect(
      calls(RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_DECLINE)[0]!.payload,
    ).toMatchObject({
      machineId: MACHINE,
      items: [{ ref: { itemId: 'old-wt' }, expect: 'fresh-old-wt' }],
    });
  });

  it('declines every item on Not now and changes nothing', async () => {
    const screen = await render(proposal());
    await vi.waitFor(() =>
      expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)).toHaveLength(1),
    );
    // The header chip reflects this Action's own setting for the asking caller (default: Ask first).
    expect(screen.findByTestId('resource-proposal-mode-ask_first')).toBeTruthy();
    await screen.pressByTestIdAsync('approval-prompt-reject');
    await vi.waitFor(() =>
      expect(readApproval()).toMatchObject({ status: 'rejected' }),
    );
    await vi.waitFor(() =>
      expect(
        calls(RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_DECLINE),
      ).toHaveLength(1),
    );
    const declined = (
      calls(RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_DECLINE)[0]!.payload as {
        items: Array<{ ref: { itemId: string } }>;
      }
    ).items;
    expect(declined.map((item) => item.ref.itemId)).toEqual([...ids]);
    expect(calls(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)).toHaveLength(0);
  });

  it('withholds approval while an item changed since the agent proposed it', async () => {
    checkExpect = (itemId) =>
      itemId === 'turbo' ? 'grew-turbo' : `claimed-${itemId}`;
    const screen = await render(proposal());
    await vi.waitFor(() =>
      expect(screen.findByTestId('resource-proposal-stale')).toBeTruthy(),
    );
    await screen.pressByTestIdAsync('approval-prompt-approve');
    // Give a (wrongly) admitted decision every chance to land before asserting nothing moved.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(readApproval().status).toBe('open');
    expect(calls(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)).toHaveLength(0);
  });

  it('says "in Trash" after the move and "freed" only once the Trash is emptied', async () => {
    const result: PileApplyResultV1 = {
      batchId: 'batch-1',
      mode: 'trash',
      inTrashBytes: 5 * GB,
      freedBytes: 0,
      outcomes: [
        ...ids
          .slice(0, 5)
          .map((itemId) => ({ itemId, status: 'moved' as const })),
        {
          itemId: 'old-wt',
          status: 'skipped' as const,
          reason: { code: 'changed_since_review' as const },
        },
      ],
    };
    const screen = await render(
      proposal({
        status: 'executed',
        updatedAtMs: 3,
        decision: {
          kind: 'approve',
          decidedAtMs: 2,
          authority: 'present_user',
          narrowedInput: StrictJsonValueSchema.parse(proposalArgs),
        },
        execution: { executedAtMs: 3, ok: true, result },
      }),
    );
    await vi.waitFor(() =>
      expect(screen.getTextContent()).toContain('machineStorage.pile.inTrash'),
    );
    expect(screen.getTextContent()).not.toContain('machineStorage.pile.freed');
    expect(screen.findByTestId('resource-proposal-item-old-wt')).toBeTruthy();
    await screen.pressByTestIdAsync('machine-storage-pile-empty');
    await vi.waitFor(() =>
      expect(screen.getTextContent()).toContain('machineStorage.pile.freed'),
    );
    expect(
      calls(RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY)[0]!.payload,
    ).toMatchObject({ machineId: MACHINE, batchId: 'batch-1' });
  });

  it('keeps a declined proposal as one line; Reopen runs the same Action from the UI and the request stays rejected', async () => {
    const screen = await render(proposal({
      status: 'rejected', updatedAtMs: 2, decision: { kind: 'reject', decidedAtMs: 2 },
    }));
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-declined')).toBeTruthy());
    await screen.pressByTestIdAsync('resource-proposal-reopen');
    await vi.waitFor(() => expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)).toHaveLength(1));
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-run')).toBeTruthy());
    await screen.pressByTestIdAsync('resource-proposal-item-old-wt');
    await screen.pressByTestIdAsync('resource-proposal-run');
    await vi.waitFor(() => expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE)).toHaveLength(1));
    const moved = (calls(RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE)[0]!.payload as { items: Array<{ ref: { itemId: string } }> }).items;
    expect(moved.map((item) => item.ref.itemId)).toEqual(ids.slice(0, 5));
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('machineStorage.pile.inTrash'));
    expect(readApproval().status).toBe('rejected');
    expect(calls(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)).toHaveLength(0);
  });

  it('tries a skipped item again as a new invocation for that item only', async () => {
    const result: PileApplyResultV1 = {
      batchId: 'batch-1', mode: 'trash', inTrashBytes: 5 * GB, freedBytes: 0,
      outcomes: [...ids.slice(0, 5).map((itemId) => ({ itemId, status: 'moved' as const })),
        { itemId: 'old-wt', status: 'skipped' as const, reason: { code: 'in_use' as const } }],
    };
    const screen = await render(proposal({
      status: 'executed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user', narrowedInput: StrictJsonValueSchema.parse(proposalArgs) },
      execution: { executedAtMs: 3, ok: true, result },
    }));
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-retry-old-wt')).toBeTruthy());
    await screen.pressByTestIdAsync('resource-proposal-retry-old-wt');
    await vi.waitFor(() => expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE)).toHaveLength(1));
    const moved = (calls(RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE)[0]!.payload as { items: Array<{ ref: { itemId: string } }> }).items;
    expect(moved.map((item) => item.ref.itemId)).toEqual(['old-wt']);
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-retry-old-wt')).toBeNull());
    // The retry has its own receipt, from its own settled result and batch.
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-retry-receipt-batch-ui')).toBeTruthy());
    const undoButtons = screen.findAll((node) => node.props.testID === 'machine-storage-pile-undo' && typeof node.props.onPress === 'function');
    await act(async () => { await undoButtons[undoButtons.length - 1]!.props.onPress(); });
    await vi.waitFor(() => expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE)).toHaveLength(1));
    expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE)[0]!.payload).toMatchObject({ batchId: 'batch-ui' });
  });

  it('starts a stopped process again through the process owner’s Start again', async () => {
    const stopArgs = { machineId: MACHINE, targets: [{ ref: 'cHJvYzox', expect: { level: 'proven' as const, owner: { kind: 'browser_sidecar' as const } } }] };
    const base = proposal();
    const request = ApprovalRequestV2Schema.parse({
      ...base, actionId: 'machines.processes.stop', actionArgs: stopArgs,
      executionOriginV1: { ...base.executionOriginV1, actionId: 'machines.processes.stop' },
      status: 'executed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user', narrowedInput: StrictJsonValueSchema.parse(stopArgs) },
      execution: { executedAtMs: 3, ok: true, result: { status: 'ended', outcomes: [{ ref: 'cHJvYzox', outcome: 'ended', freedBytes: GB }] } },
    });
    const screen = await render(request);
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-start-again-cHJvYzox')).toBeTruthy());
    expect(screen.getTextContent()).toContain('resourceProposal.stoppedFreed');
    await screen.pressByTestIdAsync('resource-proposal-start-again-cHJvYzox');
    await vi.waitFor(() => expect(calls(RPC_METHODS.MACHINES_PROCESSES_START_AGAIN)).toHaveLength(1));
    expect(calls(RPC_METHODS.MACHINES_PROCESSES_START_AGAIN)[0]!.payload).toMatchObject({ machineId: MACHINE, ref: 'cHJvYzox' });
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('resourceProposal.startedAgain'));
  });

  it.each(['machines.processes.kill', 'machines.processes.leftBehind.cleanUp'] as const)('checks and approves only the selected %s references', async (actionId) => {
    const refs = ['cHJvYzox', 'cHJvYzoy'];
    const level = actionId === 'machines.processes.kill' ? 'proven' : 'left_behind';
    const actionArgs = actionId === 'machines.processes.kill'
      ? { machineId: MACHINE, tree: true, targets: refs.map(ref => ({ ref, expect: { level } })) }
      : { machineId: MACHINE, refs };
    const boundary = daemonRpc.getMockImplementation()!;
    daemonRpc.mockImplementation(async (call) => call.method === RPC_METHODS.MACHINES_PROCESSES_CHECK
      ? { checks: refs.map(ref => ({ ref, present: true, identityEqual: true, level, memoryBytes: GB })) }
      : boundary(call));
    const base = proposal();
    const request = signed(ApprovalRequestV2Schema.parse({ ...base, actionId, actionArgs,
      executionOriginV1: { ...base.executionOriginV1, actionId } }));
    const screen = await render(request);
    await vi.waitFor(() => expect(calls(RPC_METHODS.MACHINES_PROCESSES_CHECK)).toHaveLength(1));
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-item-cHJvYzoy')).toBeTruthy());
    await screen.pressByTestIdAsync('resource-proposal-item-cHJvYzoy');
    await screen.pressByTestIdAsync('approval-prompt-approve');
    await vi.waitFor(() => expect(readApproval()).toMatchObject({ status: 'approved' }));
    expect((readApproval() as ApprovalRequestV2).decision?.narrowedInput).toEqual(actionId === 'machines.processes.kill'
      ? { machineId: MACHINE, tree: true, targets: [{ ref: refs[0], expect: { level } }] }
      : { machineId: MACHINE, refs: [refs[0]] });
  });

  it('renders cleanup ended/skipped receipts without offering Start again for left-behind work', async () => {
    const actionId = 'machines.processes.leftBehind.cleanUp';
    const base = proposal();
    const request = ApprovalRequestV2Schema.parse({ ...base, actionId, actionArgs: { machineId: MACHINE, refs: ['cHJvYzox', 'cHJvYzoy'] },
      executionOriginV1: { ...base.executionOriginV1, actionId }, status: 'executed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' },
      execution: { executedAtMs: 3, ok: true, result: { ended: [{ ref: 'cHJvYzox', freedBytes: GB }], skipped: [{ ref: 'cHJvYzoy', reason: 'owner_returned' }] } } });
    const screen = await render(request);
    expect(screen.getTextContent()).toContain('resourceProposal.stoppedFreed');
    expect(screen.findByTestId('resource-proposal-retry-cHJvYzoy')).toBeTruthy();
    expect(screen.findByTestId('resource-proposal-start-again-cHJvYzox')).toBeNull();
  });
});
