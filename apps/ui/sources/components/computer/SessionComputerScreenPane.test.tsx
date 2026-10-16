import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DirectRouteGrantScopeV1Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantScopesV1';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { MACHINE_LIVE_STREAM_SOCKET_EVENT, MachineLiveStreamRelayAuthorizationV1Schema, MachineLiveStreamRelayEnvelopeV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { DaemonMachineLiveStreamRelayStartRequestV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/relayStartRpcV1';
import { DaemonComputerActionExecuteRequestV1Schema } from '@happier-dev/protocol/computer/v1';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import type { SessionViewerController } from '@/components/sessions/viewer/SessionViewerController';
import { sealMachineLiveStreamEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    // Image measurement is native/browser-owned; the actual stream and picture remain real.
    return createReactNativeWebMock({ Image: Object.assign(
        (props: Record<string, unknown>) => React.createElement('Image', props),
        { getSize: (_url: string, ready: (width: number, height: number) => void) => ready(800, 600) },
    ) });
});

// Resolve the genuine cold graph only after its external network boundary is
// installed. Collection cost is not a Computer owner readiness deadline.
const network = await installSessionOpsNetworkBoundary();
await import('@/sync/ops/actions/defaultActionExecutor');
await import('./SessionComputerScreenPane');
await import('./ComputerScreenViewer');
await import('@/components/appShell/workspace/DestinationInstanceHost');
await import('@/components/ui/presentation/retainedPresentationSlots');
await import('@/components/sessions/viewer/SessionViewerSourceAccountScope');

describe('SessionComputerScreenPane retained source', () => {
    let failedOwnerDiagnostic: (() => unknown) | null = null;
    beforeEach(() => { network.resetRequests(); failedOwnerDiagnostic = null; });
    afterEach(context => {
        if (context.task.result?.state === 'fail' && failedOwnerDiagnostic) {
            // Test-only phase evidence distinguishes setup failures from missing retention.
            console.error('Computer pane owner diagnostic', failedOwnerDiagnostic());
        }
    });
    afterAll(async () => { await network.dispose(); });

    it('retains the real Computer body and exact destination scope while parking ordinary read and stream demand', async () => {
        // Only HTTP/Socket.IO and device credentials are replaced; the actual pane,
        // model, control projection, Action executor and stream ingestion remain real.
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const { createRetainedPresentationSlotsStore, RetainedPresentationSlotsProvider } = await import('@/components/ui/presentation/retainedPresentationSlots');
        const { SessionViewerSourceAccountScopeProvider } = await import('@/components/sessions/viewer/SessionViewerSourceAccountScope');
        const { SessionViewerControllerProvider } = await import('@/components/sessions/viewer/SessionViewerControllerProvider');
        const { useOptionalSessionViewerController } = await import('@/components/sessions/viewer/SessionViewerController');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const executorModule = await loadVitestModuleForNodeRequire(
            new URL('../../sync/ops/actions/defaultActionExecutor.ts', import.meta.url),
            () => import('@/sync/ops/actions/defaultActionExecutor'),
        );
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { getActiveServerSnapshot, setActiveServer } = await import('@/sync/domains/server/serverRuntime');
        const previousSelection = getActiveServerSnapshot();
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const home = await network.addHome('https://computer-retention.test', 'computer-account');
        const sessionId = 'retained-computer-session';
        const machineId = 'retained-computer-machine';
        const target = { kind: 'window', displayId: ':77', pid: 123, windowId: 456 } as const;
        const sourceId = 'computer:retained';
        const initialStatus = createDeferred<void>();
        const activeStreams = new Set<string>();
        let delayStart: ReturnType<typeof createDeferred<void>> | null = null;
        let pendingStart: ReturnType<typeof createDeferred<void>> | null = null;
        network.setSocketConfigurator(({ socket }) => {
            socket.emit.mockImplementation((event, payload) => {
                if (event !== MACHINE_LIVE_STREAM_SOCKET_EVENT) return;
                const envelope = MachineLiveStreamRelayEnvelopeV1Schema.parse(payload);
                if (envelope.message.kind === 'control' && envelope.message.control.kind === 'stop') {
                    activeStreams.delete(envelope.message.control.streamId);
                }
            });
        });
        let phase = 'installing the real Home and Machine';
        let readBody: () => unknown = () => null;
        failedOwnerDiagnostic = () => ({ phase, body: readBody(),
            actions: network.requests.flatMap(request => {
                const parsed = DaemonComputerActionExecuteRequestV1Schema.safeParse(request.payload);
                return parsed.success ? [parsed.data.actionId] : [];
            }), http: network.httpRequests.map(request => request.url),
            credentials: network.credentialRequests,
        });
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') {
                const base = createRootLayoutFeaturesResponse();
                return Response.json(createRootLayoutFeaturesResponse({
                    features: { machines: { ...base.features.machines, enabled: true, liveStream: { enabled: true,
                        directPeer: { enabled: false }, serverRouted: { enabled: true } } } },
                    capabilities: { machines: { ...base.capabilities.machines,
                        liveStream: { serverRouted: { caps: {}, disabledReason: null } } } },
                }));
            }
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/machines/peer/mediation/route-grants') {
                const raw: unknown = JSON.parse(String(init?.body));
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected a relay grant request');
                const request = raw as Readonly<Record<string, unknown>>;
                const scope = DirectRouteGrantScopeV1Schema.parse(request.scope);
                if (scope.kind !== 'live_stream') throw new Error('Expected a live-stream grant');
                const { kind: _kind, ...streamScope } = scope;
                const now = Date.now();
                return Response.json({ ok: true, relayAuthorization: MachineLiveStreamRelayAuthorizationV1Schema.parse({
                    payload: { v: 1, grantId: `grant:${scope.streamId}`, accountId: home.accountId,
                        sourceMachineId: request.machineId, targetMachineId: request.targetMachineId,
                        flowKind: 'live_stream', routeKind: 'server_relay', ...streamScope,
                        viewerSocketId: request.viewerSocketId, codecId: request.codecId, viewerCodecs: request.viewerCodecs,
                        iat: now, exp: now + DIRECT_ROUTE_GRANT_TTL_MS.serverRelayedLiveStream,
                        aud: 'happier-live-stream-relay-authorization' },
                    signature: { keyId: 'network-boundary', alg: 'Ed25519', valueBase64Url: 'AbCdEf012_-' },
                }) });
            }
            return null;
        });
        network.setRpcResponder(async request => {
            if (request.method === RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START) {
                const { startRequest } = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse(request.payload);
                pendingStart?.resolve();
                if (delayStart) await delayStart.promise;
                if (activeStreams.has(startRequest.streamId)) return { protocolVersion: 1,
                    result: { ok: false, reasonCode: 'duplicate_stream_id' } };
                activeStreams.add(startRequest.streamId);
                return { protocolVersion: 1, result: { ok: true, streamId: startRequest.streamId } };
            }
            if (request.method !== RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE) throw new Error(`Unexpected Computer RPC: ${request.method}`);
            const payload = DaemonComputerActionExecuteRequestV1Schema.parse(request.payload);
            expect(payload.sessionId).toBe(sessionId);
            expect(request.targetId).toBe(machineId);
            if (payload.actionId === 'computer.targets.list') return { protocolVersion: 1, result: {
                targets: [{ target }], grants: { capture: 'granted', input: 'granted' },
            } };
            if (payload.actionId === 'computer.target.get') return { protocolVersion: 1, result: {
                consentGranted: true, selectedTarget: target, sourceId,
                approvalDisplay: { machineDisplayName: 'Retained computer', requiresTargetSelection: false, target: { kind: 'window', title: 'Retained window' } },
            } };
            if (payload.actionId === 'computer.control.status') {
                initialStatus.resolve();
                return { protocolVersion: 1, result: {
                    target, sourceId, controller: 'agent', controlEpoch: 1, stopping: false, uncertain: false,
                } };
            }
            throw new Error(`Unexpected Computer control: ${payload.actionId}`);
        });
        await setActiveServer({ serverId: home.id });
        storage.getState().activateProfileScope({ serverId: home.id, accountId: home.accountId });
        storage.getState().applyProfile({ ...storage.getState().profile, id: home.accountId });
        storage.getState().applyMachines([createMachineFixture({ id: machineId, storageMode: 'plain' })], false, { sourceServerId: home.id });
        const sessionFixture = createSessionFixture({ id: sessionId, serverId: home.id, thinking: false });
        const session = { ...sessionFixture, metadata: { ...sessionFixture.metadata!, machineId } };
        storage.getState().applySessions([session]);
        publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 1 });
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        apiSocket.initialize({ endpoint: home.serverUrl, token: home.token, serverId: home.id, generation: 1 }, null);
        phase = 'waiting for the real socket connection';
        const socketReady = createDeferred<void>();
        const stopStatus = apiSocket.onStatusChange(status => { if (status === 'connected') socketReady.resolve(); });
        const stopError = apiSocket.onError(error => { if (error) socketReady.reject(error); });
        try { await socketReady.promise; } finally { stopStatus(); stopError(); }
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime?.isCurrent()).toBe(true);
        phase = 'validating the real Action selection';
        // Establish the real parsed selection outcome before presentation work.
        // A refusal from this front door is fixture setup, never retention RED.
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const producerDiagnostic = await createFrontDoorActionExecute()('computer.target.get', { machineId }, {
            surface: 'ui', authority: 'present_user', defaultSessionId: sessionId,
            serverId: home.id, expectedAccountId: home.accountId,
        });
        expect(producerDiagnostic, JSON.stringify({ http: network.httpRequests, credentials: network.credentialRequests }))
            .toMatchObject({ ok: true, result: { selectedTarget: target, sourceId } });
        phase = 'mounting the real Computer body';
        const { SessionComputerScreenPane } = await import('./SessionComputerScreenPane');
        const { ComputerScreenViewer } = await import('./ComputerScreenViewer');
        const { useRouter } = await import('expo-router');
        const store = createRetainedPresentationSlotsStore();
        const destinationId = 'computer-destination';
        const slotId = `${createSessionPaneScopeId(sessionId, home.id, destinationId)}:viewer:computer`;
        let viewerController: SessionViewerController | null = null;
        function PresenceOwner() {
            viewerController = useOptionalSessionViewerController();
            return null;
        }
        const canPresentSource = () => true;
        const openDocked = () => undefined;
        function Harness(props: Readonly<{ shell: 'pane' | 'floating' | 'closed' }>) {
            // The existing Expo test boundary supplies the destination's platform navigation.
            // Keep the real retained destination and approval owners beneath it.
            const navigation = useRouter();
            const pane = props.shell === 'pane' ? <SessionComputerScreenPane key="desktop"
                sessionId={sessionId} serverId={home.id} machineId={machineId} />
                : props.shell === 'floating' ? <SessionComputerScreenPane key="phone"
                    sessionId={sessionId} serverId={home.id} machineId={machineId} presentationSlotId={slotId} presentation="viewer" /> : null;
            return <SessionViewerControllerProvider sessionId={sessionId} serverId={home.id}
                phone={props.shell === 'floating'} canPresentSource={canPresentSource} openDocked={openDocked}>
                <PresenceOwner />
                <SessionViewerSourceAccountScopeProvider accountLifetime={accountLifetime}><RetainedPresentationSlotsProvider store={store}>
                {props.shell !== 'closed' ? <DestinationInstanceHost tabId={destinationId}
                    ref={{ kind: 'session', params: { id: sessionId } }} pathname={`/session/${sessionId}`} focused visible navigation={navigation}>
                    {pane}
                </DestinationInstanceHost> : pane}
            </RetainedPresentationSlotsProvider></SessionViewerSourceAccountScopeProvider></SessionViewerControllerProvider>;
        }
        const screen = await renderScreen(<Harness shell="pane" />);
        async function waitForMountedStream(): Promise<string> {
            let mountedStreamId = '';
            await vi.waitFor(async () => {
                await flushHookEffects();
                const stream = screen.root.findByType(ComputerScreenViewer).props.stream;
                if (!stream?.input) throw new Error('The remounted Computer stream is not ready');
                mountedStreamId = stream.input.streamId;
                expect(activeStreams.has(mountedStreamId)).toBe(true);
                expect(activeStreams.size).toBe(1);
            });
            return mountedStreamId;
        }
        let lastBody: unknown = null;
        readBody = () => {
            try {
                const body = screen.root.findByType(ComputerScreenViewer);
                lastBody = { shared: body.props.shared, title: body.props.targetTitle,
                    presence: body.props.presence, stream: body.props.stream !== null,
                    streamDiagnostic: body.props.stream?.playerState?.diagnostic,
                    player: body.props.stream?.playerState,
                    accountScope: accountLifetime?.scope, accountCurrent: accountLifetime?.isCurrent() };
            } catch { /* Preserve the last mounted observation after genuine teardown. */ }
            return lastBody;
        };
        try {
            // Physical status completion follows the initial get/list phases;
            // microtask count alone is not an owner readiness predicate.
            phase = 'waiting for mounted get/list/status completion';
            await act(async () => { await initialStatus.promise; });
            await flushHookEffects();
            const body = screen.root.findByType(ComputerScreenViewer);
            expect(body.props.shared, JSON.stringify({ targetTitle: body.props.targetTitle, presence: body.props.presence,
                accountCurrent: accountLifetime?.isCurrent(), producer: producerDiagnostic,
                actions: network.requests.flatMap(request => {
                    const parsed = DaemonComputerActionExecuteRequestV1Schema.safeParse(request.payload);
                    return parsed.success ? [parsed.data.actionId] : [];
                }) })).toBe(true);
            expect(body.props.targetTitle).toBe('Retained window');
            expect(body.props.stream).not.toBeNull();
            phase = 'waiting for real grant and daemon stream admission';
            await act(async () => { await vi.waitFor(() => expect(activeStreams.size,
                JSON.stringify({ stream: body.props.stream?.playerState, http: network.httpRequests.map(request => request.url) })).toBe(1)); });
            await flushHookEffects();
            expect(activeStreams.size).toBe(1);
            phase = 'checking the retained source slot';
            expect(store.getPortalSnapshot().map(entry => entry.slotId)).toEqual([slotId]);
            await screen.update(<Harness shell="floating" />);
            expect(screen.root.findByType(ComputerScreenViewer)).toBe(body);
            expect(viewerController!.presence.get('computer')?.presence.kind).toBe('agent');
            await screen.update(<Harness shell="closed" />);
            expect(screen.root.findByType(ComputerScreenViewer)).toBe(body);
            expect(body.props.stream).toBeNull();
            expect(activeStreams.size).toBe(0);
            const parkedReads = network.requests.length;
            await act(async () => { storage.getState().applySessions([{ ...session, thinking: true }]); });
            await flushHookEffects();
            expect(network.requests).toHaveLength(parkedReads);
            await screen.update(<Harness shell="pane" />);
            await flushHookEffects();
            expect(screen.root.findByType(ComputerScreenViewer)).toBe(body);
            expect(body.props.targetTitle).toBe('Retained window');
            expect(store.getPortalSnapshot().map(entry => entry.slotId)).toEqual([slotId]);
            expect(activeStreams.size).toBe(1);
            phase = 'remounting the responsive shell while stream admission is pending';
            await screen.update(<Harness shell="closed" />);
            delayStart = createDeferred<void>();
            pendingStart = createDeferred<void>();
            await screen.update(<Harness shell="pane" />);
            await act(async () => { await pendingStart!.promise; });
            await screen.update(<Harness key="phone-layout" shell="floating" />);
            await act(async () => { delayStart!.resolve(); });
            await flushHookEffects();
            const mountedStreamId = await waitForMountedStream();
            expect(screen.root.findByType(ComputerScreenViewer).props.stream?.playerState?.phase).not.toBe('error');
            expect(viewerController!.presence.get('computer')?.presence.kind).toBe('agent');
            const frame = await sealMachineLiveStreamEnvelopeV1({
                v: 1, sourceMachineId: machineId, targetMachineId: machineId, viewerSocketId: apiSocket.getSocketId(),
                message: { kind: 'frame', frame: { v: 1, streamId: mountedStreamId, sequence: 1,
                    timestampMs: 1234, codecId: 'image.frame.v1', payloadKind: 'image_keyframe',
                    payloadEncoding: 'binary_base64', payloadBase64: 'AQID', payloadSizeBytes: 3 } },
            }, { mode: 'plain' });
            expect(frame.ok).toBe(true);
            if (!frame.ok) throw new Error(frame.code);
            await act(async () => {
                for (const socket of network.socketBoundaries) socket.trigger(MACHINE_LIVE_STREAM_SOCKET_EVENT, frame.value);
            });
            await vi.waitFor(async () => {
                await flushHookEffects();
                const player = screen.root.findByType(ComputerScreenViewer).props.stream?.playerState;
                expect(player?.lastFrameAtMs, JSON.stringify(player)).toBe(1234);
            });
            expect(viewerController!.presence.get('computer')?.presence.kind).toBe('agent');
            await screen.update(<Harness key="phone-layout" shell="closed" />);
            await flushHookEffects();
            delayStart = null;
            await screen.update(<Harness shell="pane" />);
            await waitForMountedStream();
            phase = 'closing a stream whose daemon start is still settling';
            await screen.update(<Harness shell="closed" />);
            delayStart = createDeferred<void>();
            pendingStart = createDeferred<void>();
            await screen.update(<Harness shell="pane" />);
            await act(async () => { await pendingStart!.promise; });
            await screen.update(<Harness shell="closed" />);
            await screen.update(<Harness shell="pane" />);
            await act(async () => { delayStart!.resolve(); });
            await flushHookEffects();
            await waitForMountedStream();
            await screen.update(<Harness shell="closed" />);
            await flushHookEffects();
            expect(activeStreams.size).toBe(0);
        } finally {
            delayStart?.resolve();
            readBody();
            await screen.unmount();
            apiSocket.disconnect();
            await setActiveServer({ serverId: previousSelection.serverId });
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
            executorModule.dispose();
        }
    });
});
