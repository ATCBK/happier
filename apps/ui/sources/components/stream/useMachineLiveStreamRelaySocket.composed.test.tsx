import * as React from 'react';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    MACHINE_LIVE_STREAM_SOCKET_EVENT,
    MachineLiveStreamDecodedEnvelopeV1Schema,
    MachineLiveStreamStartRequestV1Schema,
} from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { sealMachineLiveStreamEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';
import { renderHook, flushHookEffects } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

// HTTP Account/route discovery is external; the relay uses a real loopback Socket.IO
// connection through the production pool, shared relay owner and mounted hook.
const boundary = await installSessionOpsNetworkBoundary();
const physicalClients: Socket[] = [];
vi.doMock('socket.io-client', async importOriginal => {
    const actual = await importOriginal<typeof import('socket.io-client')>();
    return { ...actual, io: (...args: Parameters<typeof actual.io>) => {
        const socket = actual.io(...args);
        physicalClients.push(socket);
        return socket;
    } };
});
const { useMachineLiveStreamRelaySocket } = await import('./useMachineLiveStreamRelaySocket');
const { useMachineLiveStreamId } = await import('./useMachineLiveStreamId');
const { useSimulatorRelayIngestion } = await import('@/components/devices/simulator/relay/useSimulatorRelayIngestion');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');

const http = createServer();
const io = new Server(http, { path: '/v1/updates/' });
let home: Awaited<ReturnType<typeof boundary.addHome>>;
const live = new Map<string, string>();
const admissions: Array<{ streamId: string; viewerSocketId: string }> = [];
io.on('connection', socket => {
    socket.on(MACHINE_LIVE_STREAM_SOCKET_EVENT, raw => {
        const envelope = MachineLiveStreamDecodedEnvelopeV1Schema.parse(raw);
        if (envelope.message.kind === 'control' && envelope.message.control.kind === 'stop') {
            live.delete(envelope.message.control.streamId);
        }
    });
    socket.on('disconnect', () => {
        for (const [streamId, viewer] of live) if (viewer === socket.id) live.delete(streamId);
    });
});

beforeAll(async () => {
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback server');
    home = await boundary.addHome(`http://127.0.0.1:${address.port}`, 'account-stream');
});
beforeEach(async () => {
    boundary.resetRequests();
    await boundary.addHome(home.serverUrl, home.accountId);
});
afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    for (const socket of physicalClients.splice(0)) socket.disconnect();
    await resetServerReachabilitySupervisors();
    live.clear(); admissions.length = 0;
});
afterAll(async () => {
    await boundary.dispose();
    http.closeAllConnections();
    await new Promise<void>(resolve => io.close(() => resolve()));
});

function useViewer() {
    const socket = useMachineLiveStreamRelaySocket({ machineId: 'machine-1', serverId: home.id,
        disconnectTag: 'stream-reconnect-test' });
    const transport = React.useMemo(() => socket ? {
        send: (_event: typeof MACHINE_LIVE_STREAM_SOCKET_EVENT, envelope: Parameters<typeof socket.sendEnvelope>[0]) => socket.sendEnvelope(envelope),
        onEnvelope: socket.onEnvelope,
    } : null, [socket]);
    const streamId = useMachineLiveStreamId(socket?.socketId ? `stream:${socket.socketId}` : '');
    const ingestion = useSimulatorRelayIngestion({ enabled: Boolean(streamId), transport,
        serverId: home.id, sourceMachineId: 'machine-1', targetMachineId: 'machine-1',
        viewerSocketId: socket?.socketId, simulatorId: 'fixture', streamId, streamFamily: 'screen',
        caps: {}, sourceCodecs: ['image.mjpeg'],
        // Grant issuance and capture RPC are external services. Keep relayClient,
        // identity derivation, subscription, framing and lifecycle logic real.
        startProduction: async input => {
            const startRequest = MachineLiveStreamStartRequestV1Schema.parse({
                v: 1, ...input, authorization: {
                    payload: { v: 1, grantId: 'fixture-grant', accountId: home.accountId,
                        sourceMachineId: input.sourceMachineId, targetMachineId: input.targetMachineId,
                        viewerSocketId: input.viewerSocketId, flowKind: 'live_stream', routeKind: 'server_relay',
                        streamId: input.streamId, streamFamily: input.streamFamily,
                        codecId: input.codecId, viewerCodecs: input.viewerCodecs,
                        iat: Date.now(), exp: Date.now() + 60_000, aud: 'happier-live-stream-relay-authorization' },
                    signature: { keyId: 'fixture-key', alg: 'Ed25519', valueBase64Url: 'AbCdEf012_-' },
                },
            });
            return { ok: true, routeKind: 'server_relay', startRequest, relayAuthorization: startRequest.authorization! };
        },
        startDaemonRelay: async ({ startRequest }) => {
            const admitted = { streamId: startRequest.streamId, viewerSocketId: startRequest.viewerSocketId! };
            admissions.push(admitted); live.set(admitted.streamId, admitted.viewerSocketId);
            return { ok: true, streamId: admitted.streamId };
        },
    });
    return { socketId: socket?.socketId ?? '', streamId, player: ingestion.playerStatesBySimulatorId.fixture };
}

async function frame(streamId: string) {
    const viewerSocketId = live.get(streamId);
    if (!viewerSocketId) throw new Error('Expected an admitted live viewer');
    const envelope = MachineLiveStreamDecodedEnvelopeV1Schema.parse({ v: 1,
        sourceMachineId: 'machine-1', targetMachineId: 'machine-1', viewerSocketId,
        message: { kind: 'frame', frame: { v: 1, streamId, sequence: 1, timestampMs: 1,
            payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64', payloadBase64: 'AQID', payloadSizeBytes: 3 } },
    });
    const wire = await sealMachineLiveStreamEnvelopeV1(envelope, { mode: 'plain' });
    if (!wire.ok) throw new Error(wire.code);
    const physical = io.sockets.sockets.get(viewerSocketId);
    if (!physical) throw new Error('Expected physical viewer');
    await act(async () => {
        const acknowledged = new Promise<void>(resolve => {
            const receive = (raw: unknown) => {
                const parsed = MachineLiveStreamDecodedEnvelopeV1Schema.safeParse(raw);
                if (!parsed.success || parsed.data.message.kind !== 'control'
                    || parsed.data.message.control.streamId !== streamId || parsed.data.message.control.kind !== 'ack') return;
                physical.off(MACHINE_LIVE_STREAM_SOCKET_EVENT, receive);
                resolve();
            };
            physical.on(MACHINE_LIVE_STREAM_SOCKET_EVENT, receive);
        });
        io.to(viewerSocketId).emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, wire.value);
        await acknowledged;
    });
    await flushHookEffects();
}

describe('mounted shared live-stream socket (real reconnect)', () => {
    it('retires the old stream and admits the quiet mounted viewer after reconnect without rerender or remount', async () => {
        const hook = await renderHook(useViewer);
        try {
            await vi.waitFor(async () => { await flushHookEffects(); expect(admissions, JSON.stringify(hook.getCurrent())).toHaveLength(1); });
            const previous = hook.getCurrent();
            await frame(previous.streamId);
            await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().player?.phase).toBe('playing'); });
            const heldFrame = hook.getCurrent().player?.lastFrameUrl;
            expect(heldFrame).toBeTruthy();
            const physical = io.sockets.sockets.get(previous.socketId);
            if (!physical) throw new Error('Expected actual viewer connection');
            const client = physicalClients.find(socket => socket.id === previous.socketId);
            if (!client) throw new Error('Expected actual pooled Socket.IO client');
            await act(async () => {
                const disconnected = new Promise<void>(resolve => { client.once('disconnect', () => resolve()); });
                physical.conn.close();
                await disconnected;
            });
            await vi.waitFor(() => expect(live.has(previous.streamId)).toBe(false));
            await flushHookEffects();
            expect(hook.getCurrent().player?.lastFrameUrl).toBe(heldFrame);
            // Drive the same real pooled client's network reconnect. Observing the
            // SDK factory above does not replace connect/events or rerender React.
            await act(async () => {
                const connected = new Promise<void>(resolve => { client.once('connect', () => resolve()); });
                client.connect();
                await connected;
            });
            await vi.waitFor(async () => { await flushHookEffects(); expect(admissions).toHaveLength(2); }, { timeout: 10_000 });
            const replacement = hook.getCurrent();
            expect(replacement.socketId).not.toBe(previous.socketId);
            expect(replacement.streamId).not.toBe(previous.streamId);
            expect(replacement.player?.phase).toBe('reconnecting');
            expect(replacement.player?.lastFrameUrl).toBe(heldFrame);
            expect(live.get(replacement.streamId)).toBe(replacement.socketId);
            await frame(replacement.streamId);
            await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().player?.phase).toBe('playing'); });
        } finally { await hook.unmount(); }
    });

    it('gives a remount a distinct stream while another mounted viewer stays alive on the pooled connection', async () => {
        const first = await renderHook(useViewer);
        const other = await renderHook(useViewer);
        try {
            await vi.waitFor(async () => { await flushHookEffects(); expect(admissions).toHaveLength(2); });
            const retired = first.getCurrent().streamId;
            const kept = other.getCurrent().streamId;
            expect(first.getCurrent().socketId).toBe(other.getCurrent().socketId);
            expect(retired).not.toBe(kept);
            await first.unmount();
            const replacement = await renderHook(useViewer);
            try {
                await vi.waitFor(async () => { await flushHookEffects(); expect(admissions).toHaveLength(3); });
                await vi.waitFor(() => expect(live.has(retired)).toBe(false));
                expect(replacement.getCurrent().streamId).not.toBe(retired);
                expect(live.has(kept)).toBe(true);
                await frame(kept);
                await vi.waitFor(async () => { await flushHookEffects(); expect(other.getCurrent().player?.phase).toBe('playing'); });
            } finally { await replacement.unmount(); }
        } finally { await other.unmount(); }
    });
});
