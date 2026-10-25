import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  createSessionFixture,
  renderHook,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: { push: navigation.push } }).module;
});

// Home credentials and the server socket are the boundaries; the Session store, the awareness owner and the
// pending-navigation landing stay real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
// The content-demand owner reaches the Sync singleton; load it after the transport boundaries.
await loadSyncSingletonForTests();
const { DiscussionParticipantRequestLine } =
  await import('./DiscussionParticipantRequestLine');
const { storage } = await import('@/sync/domains/state/storageStore');
const { useServerCredentialAccountScopeBindings } =
  await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { activateStorageAccountScope } =
  await import('@/dev/testkit/runtime/storageRuntime');
const { usePendingNavigationLanding, clearPendingNavigationState } =
  await import('@/activity/source/pendingNavigationRuntime');
let activeScope: Awaited<
  ReturnType<typeof activateStorageAccountScope>
> | null = null;

beforeEach(async () => {
  await homes.reset();
  navigation.push.mockReset();
  clearPendingNavigationState();
});
afterEach(() => {
  standardCleanup();
  activeScope?.dispose();
  activeScope = null;
});

it('shows a participant waiting on its native permission and opens that request in its own Session', async () => {
  const serverId = await homes.addHome({
    name: 'Discussion Home',
    serverUrl: 'https://discussion-request.test',
    accountId: 'alice',
    currentAccount: true,
  });
  activeScope = await activateStorageAccountScope(
    { serverId, accountId: 'alice' },
    storage,
  );
  const sessionId = 'reviewer-session';
  const base = createSessionFixture({
    id: sessionId,
    serverId,
    encryptionMode: 'plain',
    active: true,
    presence: 'online',
    updatedAt: Date.now(),
    activeAt: Date.now(),
    latestTurnStatus: 'in_progress',
    agentState: { requests: {} },
    pendingPermissionRequestCount: 0,
    pendingUserActionRequestCount: 0,
    pendingRequestObservedAt: null,
  });
  storage.setState({ sessions: { [sessionId]: base } });
  const scopes = await renderHook(() =>
    useServerCredentialAccountScopeBindings([serverId]),
  );
  await vi.waitFor(() =>
    expect(scopes.getCurrent().get(serverId)).toBeDefined(),
  );
  const accountLifetime = scopes.getCurrent().get(serverId)!;
  const screen = await renderScreen(
    <DiscussionParticipantRequestLine
      sessionId={sessionId}
      serverId={serverId}
      accountLifetime={accountLifetime}
      enabled
      label="Retry reviewer"
    />,
  );
  // Nothing waits: the line is absent, not an empty warning.
  expect(
    screen.findByTestId(`session-discussion-participant-request-${sessionId}`),
  ).toBeNull();

  const request = {
    tool: 'Bash',
    kind: 'permission' as const,
    arguments: { command: 'ls' },
    createdAt: Date.now(),
    turnId: 'turn-1',
  };
  await act(async () => {
    storage.setState({
      sessions: {
        [sessionId]: {
          ...base,
          agentState: { requests: { 'exec-1': request } },
        },
      },
    });
  });
  expect(
    screen.findByTestId(`session-discussion-participant-request-${sessionId}`),
  ).not.toBeNull();
  const landing = await renderHook(() =>
    usePendingNavigationLanding({ serverId, sessionId }, 'exec-1'),
  );
  expect(landing.getCurrent()).toBeNull();
  await act(async () => {
    screen
      .findByTestId(`session-discussion-participant-request-open-${sessionId}`)!
      .props.onPress();
  });
  expect(navigation.push).toHaveBeenCalledWith(
    `/session/${sessionId}?serverId=${encodeURIComponent(serverId)}`,
  );
  expect(landing.getCurrent()).toMatchObject({
    requestId: 'exec-1',
    state: 'pending',
    focusTarget: 'prompt',
  });

  // Answered in its Session: the line leaves with the request.
  await act(async () => {
    storage.setState({
      sessions: {
        [sessionId]: {
          ...base,
          agentState: {
            requests: { 'exec-1': request },
            completedRequests: {
              'exec-1': {
                ...request,
                completedAt: Date.now() + 1,
                status: 'approved',
              },
            },
          },
        },
      },
    });
  });
  expect(
    screen.findByTestId(`session-discussion-participant-request-${sessionId}`),
  ).toBeNull();

  // Another Account on the same Home never sees this Session's request through the Discussion.
  await act(async () => {
    storage.setState({
      sessions: {
        [sessionId]: {
          ...base,
          agentState: { requests: { 'exec-1': request } },
        },
      },
    });
  });
  expect(
    screen.findByTestId(`session-discussion-participant-request-${sessionId}`),
  ).not.toBeNull();
  await act(async () => {
    await homes.switchAccount(serverId, 'bob');
  });
  expect(
    screen.findByTestId(`session-discussion-participant-request-${sessionId}`),
  ).toBeNull();
  await landing.unmount();
  await scopes.unmount();
});
