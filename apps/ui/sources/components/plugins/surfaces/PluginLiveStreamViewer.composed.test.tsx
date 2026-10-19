import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DirectRouteGrantScopeV1Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantScopesV1';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { MACHINE_LIVE_STREAM_SOCKET_EVENT, MachineLiveStreamRelayAuthorizationV1Schema, MachineLiveStreamRelayEnvelopeV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { DaemonMachineLiveStreamRelayStartRequestV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/relayStartRpcV1';
import { sealMachineLiveStreamEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';
import { flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock, createMeasuredImageMock } = await import('@/dev/testkit/mocks/reactNative');
    // Native image measurement is a platform boundary; the real player still renders the image.
    return createReactNativeWebMock({ Image: createMeasuredImageMock({ width: 800, height: 600 }) });
});

// Install HTTP/Socket.IO before loading the actual mount, relay and admission graph.
const network = await installSessionOpsNetworkBoundary();
const { PluginLiveStreamViewer } = await import('./PluginLiveStreamViewer');
const { createBoundPluginSurfaceController } = await import('./boundPluginSurfaceController');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { LiveStreamPlayer } = await import('@/components/stream/LiveStreamPlayer');

afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    await resetServerReachabilitySupervisors();
});
afterAll(async () => { await network.dispose(); });

it('keeps an admitted plugin picture through socket reconnect and clears it when the physical mount retires', async () => {
    network.resetRequests();
    const home = await network.addHome('https://plugin-live-viewer.test', 'plugin-viewer-account');
    const source = { sourceId: 'host-screen', sourceOccurrenceId: 'screen-1', streamFamily: 'screen',
        supportedCodecs: ['image.mjpeg'], requiresApproval: false };
    const active = new Map<string, string>();
    const starts: Array<{ streamId: string; viewerSocketId: string }> = [];
    let reconnectAllowed = true;
    network.setSocketConfigurator(({ socket }) => {
        const connect = socket.connect.getMockImplementation();
        let connectedOnce = false;
        socket.connect.mockImplementation(() => {
            if (socket.connected || (connectedOnce && !reconnectAllowed)) return;
            socket.id = connectedOnce ? 'plugin-socket-reconnected' : 'plugin-socket-initial';
            connectedOnce = true;
            connect?.();
        });
        // The relay server retires streams addressed to a disconnected physical socket.
        socket.on('disconnect', () => {
            for (const [streamId, viewerSocketId] of active) {
                if (viewerSocketId === socket.id) active.delete(streamId);
            }
        });
        socket.emit.mockImplementation((event, payload) => {
            if (event !== MACHINE_LIVE_STREAM_SOCKET_EVENT) return;
            const envelope = MachineLiveStreamRelayEnvelopeV1Schema.parse(payload);
            if (envelope.message.kind === 'control' && envelope.message.control.kind === 'stop') {
                active.delete(envelope.message.control.streamId);
            }
        });
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
        if (path !== '/v1/machines/peer/mediation/route-grants') return null;
        const raw: unknown = JSON.parse(String(init?.body));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected live-stream grant request');
        const request = raw as Readonly<Record<string, unknown>>;
        const scope = DirectRouteGrantScopeV1Schema.parse(request.scope);
        if (scope.kind !== 'live_stream') throw new Error('Expected live-stream scope');
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
    });
    network.setRpcResponder(async request => {
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_CAPTURE_SOURCE_READ) return { ok: true, source };
        if (request.method !== RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START) throw new Error(`Unexpected plugin viewer RPC: ${request.method}`);
        const { startRequest } = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse(request.payload);
        expect(startRequest.sourceId).toBe(source.sourceId);
        expect(startRequest.sourceOccurrenceId).toBe(source.sourceOccurrenceId);
        const admission = { streamId: startRequest.streamId, viewerSocketId: startRequest.viewerSocketId! };
        starts.push(admission);
        active.set(admission.streamId, admission.viewerSocketId);
        return { protocolVersion: 1, result: { ok: true, streamId: admission.streamId } };
    });
    const account = await renderHook(() => useServerCredentialAccountScopeBinding(home.id));
    let controller: ReturnType<typeof createBoundPluginSurfaceController> | undefined;
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
        await vi.waitFor(async () => { await flushHookEffects(); expect(account.getCurrent().binding?.isCurrent()).toBe(true); });
        const pluginId = 'acme.viewer';
        const occurrenceId = 'viewer-1';
        // The real bound controller constructs the live-stream owner, Action Host API and
        // mount lifetime. This plugin's own capture source needs no host-viewing approval;
        // host consent is covered by pluginSurfaceLiveStream.test.ts.
        controller = createBoundPluginSurfaceController({ facts: {
            pluginId, contributionId: 'viewer', surfaceId: 'plugin-viewer-surface', placement: 'appSurface', platform: 'web',
            machineId: 'machine-1', serverId: home.id, occurrenceId, projectionGeneration: 1,
            executionOrigin: { serverIdentityId: 'plugin-home', materializationRef: { pluginId,
                machineId: 'machine-1', materializationId: 'viewer-materialization' } },
            targetedContributions: { target: { pluginId, occurrenceId,
                sourceCustody: { kind: 'development', registeredRootId: 'viewer-root' } }, points: [] },
            accountLifetime: account.getCurrent().binding, interactionEnabled: true, daemonInteractionEnabled: true,
        } });
        expect(controller.hostApi.installedMethods).toContain('watchLiveStream');
        screen = await renderScreen(<PluginLiveStreamViewer reference={{ kind: 'plugin', source: { pluginId, localId: 'screen' } }}
            hostApi={controller.hostApi} mountLifetime={controller} surface={controller.surfaceContext}
            machineId="machine-1" serverId={home.id} readViewing={controller.readLiveStreamViewing} />);
        const player = () => screen!.root.findByType(LiveStreamPlayer).props.state;
        const picture = () => screen!.root.findAllByType('Image').map(image => image.props.source?.uri);
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(starts, JSON.stringify({ phase: player().phase, diagnostic: player().diagnostic,
                rpc: network.requests.map(request => request.method),
                http: network.httpRequests.map(request => new URL(request.url).pathname) })).toHaveLength(1);
        });
        const deliverFrame = async (admission: (typeof starts)[number], timestampMs: number, expectDisplayed = true) => {
            const frame = await sealMachineLiveStreamEnvelopeV1({ v: 1, sourceMachineId: 'machine-1', targetMachineId: 'machine-1',
                viewerSocketId: admission.viewerSocketId, message: { kind: 'frame', frame: { v: 1, streamId: admission.streamId,
                    sequence: 1, timestampMs, payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64',
                    payloadBase64: 'AQID', payloadSizeBytes: 3 } } }, { mode: 'plain' });
            if (!frame.ok) throw new Error(frame.code);
            await act(async () => {
                for (const socket of network.socketBoundaries) socket.trigger(MACHINE_LIVE_STREAM_SOCKET_EVENT, frame.value);
            });
            await flushHookEffects();
            if (expectDisplayed) await vi.waitFor(async () => { await flushHookEffects(); expect(player().lastFrameAtMs).toBe(timestampMs); });
        };
        await deliverFrame(starts[0]!, 1000);
        expect(player().phase).toBe('playing');
        const heldPicture = picture();
        expect(heldPicture).toHaveLength(1);
        expect(heldPicture[0]).toBeTruthy();
        const socket = network.socketBoundaries.find(boundary => boundary.socket.id === starts[0]!.viewerSocketId);
        expect(socket).toBeDefined();
        reconnectAllowed = false;
        await act(async () => { socket!.trigger('disconnect', 'transport close'); });
        await flushHookEffects();
        expect(picture()).toEqual(heldPicture);
        reconnectAllowed = true;
        await act(async () => { socket!.socket.connect(); });
        await vi.waitFor(async () => { await flushHookEffects(); expect(starts).toHaveLength(2); });
        expect(starts[1]!.streamId).not.toBe(starts[0]!.streamId);
        expect(starts[1]!.viewerSocketId).not.toBe(starts[0]!.viewerSocketId);
        expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_PLUGIN_UI_CAPTURE_SOURCE_READ)).toHaveLength(1);
        expect(picture()).toEqual(heldPicture);
        await deliverFrame(starts[1]!, 2000);
        expect(player().phase).toBe('playing');
        await act(async () => { controller!.dispose(); });
        await vi.waitFor(async () => { await flushHookEffects(); expect(active.size).toBe(0); });
        expect(controller.isCurrent()).toBe(false);
        expect(picture()).toHaveLength(0);
        expect(player().phase).toBe('error');
        await deliverFrame(starts[1]!, 3000, false);
        expect(picture()).toHaveLength(0);
    } finally {
        reconnectAllowed = true;
        await screen?.unmount();
        controller?.dispose();
        await account.unmount();
    }
});
