import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMachineFixture, createRootLayoutFeaturesResponse, createSessionFixture,
    createSessionListRenderableSessionFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { setServerReachabilityNetworkAllowed } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } =
    await import('@/sync/domains/machines/reachability/machineReachability');
const { SessionFollowSourcesEditor } = await import('./SessionFollowSourcesEditor');
const before = storage.getState();
beforeEach(() => network.resetRequests());

afterEach(() => { setServerReachabilityNetworkAllowed(true); standardCleanup(); storage.setState(before, true);
    clearMachineRequestReachabilityForTest(); network.resetRequests(); });
afterAll(() => network.dispose());

async function mountRetryEditor(requestFailed = false) {
    const home = await network.addHome('https://follow-retry.test', 'follow-account');
    setActiveServerId(home.id);
    publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 1 });
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, following: { enabled: true } } } });
    network.setHttpResponder(async input => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/features') return Response.json(features);
        if (path === '/v2/sessions/destination/follows/sessions') return Response.json({ sources: [{
            sourceSessionId: 'source', destinationSessionId: 'destination', mode: 'next_turn',
            deliveryState: 'eligible', hasPendingUpdates: false,
        }] });
        // An unavailable source key is retryable, not transferable. The real crypto reader
        // classifies the server's unavailable detail; no crypto or preparation owner is mocked.
        if (path === '/v2/sessions/source') return Response.json({ error: 'not_found' }, { status: 404 });
        return null;
    });
    const machine = createMachineFixture({ id: 'runner', kind: 'ephemeral_session_runner', activeAt: Date.now(),
        operationProtocolCapabilities: { sessionFollow: { contextV1: true } } });
    const source = createSessionListRenderableSessionFixture({ id: 'source', serverId: home.id, encryptionMode: 'e2ee' });
    storage.setState(state => ({ profileScope: { serverId: home.id, accountId: home.accountId },
        profile: { ...state.profile, id: home.accountId }, machines: { [machine.id]: machine },
        machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' },
        sessionListRowsByServerId: { [home.id]: { [source.id]: source } } }));
    const scope = { serverId: home.id, accountId: home.accountId };
    if (requestFailed) recordMachineRequestFailed({ ...scope, machineId: machine.id });
    const screen = await renderScreen(<SessionFollowSourcesEditor destination={createSessionFixture({ id: 'destination', serverId: home.id })}
        serverId={home.id} destinationMachineId={machine.id} />);
    const sourceRequests = () => network.httpRequests.filter(request => new URL(request.url).pathname === '/v2/sessions/source').length;
    return { screen, scope, sourceRequests };
}

it('keeps an explicit source-key Retry enabled and dispatches while automatic network work is paused', async () => {
    const { screen, sourceRequests } = await mountRetryEditor();
    const retryId = 'session-follow-source-source-retry';
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId(retryId)).toBeTruthy(); });
    await vi.waitFor(() => expect(sourceRequests()).toBeGreaterThan(0));
    await vi.waitFor(() => expect(screen.findAllByTestId(retryId)[0]?.props.disabled).toBe(false));
    const beforeRetry = sourceRequests();
    await act(async () => { setServerReachabilityNetworkAllowed(false); });
    expect(Boolean(screen.findAllByTestId(retryId)[0]?.props.disabled)).toBe(false);
    await screen.pressByTestIdAsync(retryId);
    await vi.waitFor(() => expect(sourceRequests(), JSON.stringify({
        endpointStatus: storage.getState().endpointStatus,
        requests: network.requests.map(({ method, targetId }) => ({ method, targetId })),
        httpPaths: network.httpRequests.map(request => new URL(request.url).pathname),
        subtitle: screen.findByTestId('session-follow-source-source')?.props.subtitle,
    })).toBeGreaterThan(beforeRetry));
    await screen.unmount();
});

it('resumes automatic source preparation only when the exact Account request failure heals', async () => {
    const { screen, scope, sourceRequests } = await mountRetryEditor(true);
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('session-follow-source-source')).toBeTruthy(); });
    expect(sourceRequests(), JSON.stringify(network.requests.map(({ method, targetId }) => ({ method, targetId })))).toBe(0);
    await act(async () => { recordMachineRequestSucceeded({ ...scope, accountId: 'another-account', machineId: 'runner' }); });
    await flushHookEffects();
    expect(sourceRequests()).toBe(0);
    await act(async () => { recordMachineRequestSucceeded({ ...scope, machineId: 'runner' }); });
    await vi.waitFor(() => expect(sourceRequests()).toBeGreaterThan(0));
    await screen.unmount();
});
