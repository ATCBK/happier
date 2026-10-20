import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMachineFixture, createRootLayoutFeaturesResponse, createSessionFixture,
    createSessionListRenderableSessionFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// The anchored panel's portal and window measurement are the platform boundary; the panel's own parts stay real.
vi.mock('@/components/ui/popover', async (importOriginal) => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

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

async function mountRetryEditor(requestFailed = false, initialPolicy: FollowPolicyV1 = { preset: 'important' },
    onSourceRead?: (signal?: AbortSignal | null) => Promise<Response>) {
    const home = await network.addHome('https://follow-retry.test', 'follow-account');
    setActiveServerId(home.id);
    publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 1 });
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, following: { enabled: true } } } });
    let policy = initialPolicy;
    let refusePolicyWrite = false;
    const policyWrites: unknown[] = [];
    network.setHttpResponder(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/features') return Response.json(features);
        if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
        if (path === '/v2/account/session-follow-rules') return Response.json({ rules: [] });
        if (path === '/v2/sessions/destination/follows/sessions/source' && init?.method === 'PUT') {
            const body = JSON.parse(String(init.body));
            policyWrites.push(body);
            if (refusePolicyWrite) return Response.json({ error: 'session_archived' }, { status: 409 });
            policy = body.policy;
            return Response.json({ changed: true, source: { sourceSessionId: 'source', destinationSessionId: 'destination',
                policy, deliveryState: 'eligible', hasPendingUpdates: false } });
        }
        if (path === '/v2/sessions/destination/follows/sessions') return Response.json({ sources: [{
            sourceSessionId: 'source', destinationSessionId: 'destination', policy,
            deliveryState: 'eligible', hasPendingUpdates: false,
        }] });
        // An unavailable source key is retryable, not transferable. The real crypto reader
        // classifies the server's unavailable detail; no crypto or preparation owner is mocked.
        if (path === '/v2/sessions/source') return onSourceRead
            ? await onSourceRead(init?.signal) : Response.json({ error: 'not_found' }, { status: 404 });
        return null;
    });
    const machine = createMachineFixture({ id: 'runner', kind: 'ephemeral_session_runner', activeAt: Date.now(),
        operationProtocolCapabilities: { sessionFollow: { contextV1: true } } });
    const source = createSessionListRenderableSessionFixture({ id: 'source', encryptionMode: 'e2ee' });
    storage.setState(state => ({ profileScope: { serverId: home.id, accountId: home.accountId },
        profile: { ...state.profile, id: home.accountId }, machines: { [machine.id]: machine },
        machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' },
        sessionListRowsByServerId: { [home.id]: { [source.id]: source } } }));
    const scope = { serverId: home.id, accountId: home.accountId };
    if (requestFailed) recordMachineRequestFailed({ ...scope, machineId: machine.id });
    const screen = await renderScreen(<SessionFollowSourcesEditor destination={createSessionFixture({ id: 'destination', serverId: home.id })}
        serverId={home.id} destinationMachineId={machine.id} />);
    const sourceRequests = () => network.httpRequests.filter(request => new URL(request.url).pathname === '/v2/sessions/source').length;
    return { screen, scope, sourceRequests, policyWrites, refusePolicyWrites: (value: boolean) => { refusePolicyWrite = value; } };
}

it('cancels pending source-key preparation when its editor unmounts', async () => {
    let signal: AbortSignal | null | undefined;
    const { screen } = await mountRetryEditor(false, { preset: 'important' }, async value => {
        signal = value;
        return await new Promise<Response>((_resolve, reject) => value?.addEventListener('abort',
            () => reject(new Error('aborted')), { once: true }));
    });
    await vi.waitFor(() => expect(signal).toBeDefined());
    await screen.unmount();
    expect(signal?.aborted).toBe(true);
});

it('writes an explicit policy through the real Follow Action and retries the failed draft without replacing committed policy', async () => {
    const custom: FollowPolicyV1 = { preset: 'custom', events: { person_wrote: { delivery: 'interrupt' }, finished: { delivery: 'quiet' } } };
    const { screen, policyWrites, refusePolicyWrites } = await mountRetryEditor(false, custom);
    const rowId = 'session-follow-source-source';
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId(rowId), JSON.stringify({
        content: screen.getTextContent(), paths: network.httpRequests.map(request => new URL(request.url).pathname),
    })).toBeTruthy(); });
    await screen.pressByTestIdAsync(rowId);
    const quietSegment = () => screen.findAllByTestId(`${rowId}-policy.preset.quiet`).find((node) => typeof node.props.onPress === 'function');
    refusePolicyWrites(true);
    await act(async () => { quietSegment()?.props.onPress(); });
    await vi.waitFor(() => expect(screen.findByTestId('session-follow-sources-error')).toBeTruthy());
    expect(policyWrites).toEqual([{ policy: { preset: 'quiet', voice: false } }]);
    expect(quietSegment()?.props.checked).toBe(true);
    refusePolicyWrites(false);
    await screen.pressByTestIdAsync('session-follow-sources-error');
    await vi.waitFor(() => expect(policyWrites).toHaveLength(2));
    expect(policyWrites[1]).toEqual(policyWrites[0]);
    await vi.waitFor(() => expect(screen.findByTestId('session-follow-sources-error')).toBeNull());
    await screen.unmount();
});

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
