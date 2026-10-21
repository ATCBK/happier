import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import axios from 'axios';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { SessionBroadcastContainerSchema } from '@happier-dev/protocol/updates';
import { UpdateSchema } from '@/api/types';
import type { ChangeEntry } from '@/api/changes';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumerSessionAdapter } from '@/agent/runtime/waitForNextPermissionModeMessage';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import { createWorkflowOriginContextInputPort } from '@/agent/runtime/session/contextOnly/workflowOriginInput';
import { publishSessionFollowWakeInvalidation } from '@/agent/runtime/session/follow/sessionFollowWakeSignal';
import { resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { ApiSessionClient } from './sessionClient';

it('keeps an idle context consumer parked for unrelated Account writes and wakes for its own durable or exact Session changes', async () => {
    const sessionId = 'wake-destination';
    const initialSession = createPlainSessionFixture({ id: sessionId });
    const credentials = { token: 'context-wake-owner', encryption: null };
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: {} });
    const http = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(features));
    });
    const sockets = new Server(http, { path: '/v1/updates' });
    sockets.on('connection', socket => {
        void socket.join(socket.handshake.auth.clientType === 'user-scoped' ? 'account' : 'destination');
        socket.onAny((event: string, ...args: unknown[]) => {
            const ack = args.at(-1);
            if (typeof ack === 'function') ack(resolveApiSessionSocketDefaultAck(event, args[0]));
        });
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const home = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    let changes: ChangeEntry[] = [];
    let cursor = 0;
    let changeReads = 0;
    // Home HTTP/authentication are system boundaries. The socket ingress,
    // changes parser/cursor, Session client, workflow port and consumer are real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/profile') return { status: 200, data: { id: 'wake-account' } };
        if (path === '/v2/changes') {
            changeReads++;
            return { status: 200, data: { nextCursor: cursor, changes } };
        }
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } };
        if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: {
            session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
                metadata: JSON.stringify(initialSession.metadata), metadataVersion: initialSession.metadataVersion, share: null }),
        } };
        return { status: 404, data: {} };
    });
    const accountSocket = io(home, { path: '/v1/updates', transports: ['websocket'],
        auth: { clientType: 'user-scoped' }, reconnection: false });
    const sessionSocket = io(home, { path: '/v1/updates', transports: ['websocket'],
        auth: { clientType: 'session-scoped' }, autoConnect: false, reconnection: false });
    const lifetime = new AbortController();
    let client: ApiSessionClient | undefined;
    let waiting: Promise<unknown> | undefined;
    let workflowReads = 0;
    let takes = 0;
    let invalidations = 0;
    try {
        await new Promise<void>((resolve, reject) => {
            accountSocket.once('connect', resolve);
            accountSocket.once('connect_error', reject);
        });
        client = new ApiSessionClient(credentials.token, initialSession, {
            localMachineId: 'wake-machine',
            metadataAuthority: { kind: 'owner', credentials, readCurrentCredentials: async () => credentials },
            onSessionFollowInvalidated: () => { invalidations++; publishSessionFollowWakeInvalidation(); },
            transport: { serverId: 'context-wake-home', serverUrl: home,
                createAccountUpdatesSocket: () => accountSocket,
                createSessionSocketTransport: () => ({ socket: sessionSocket, transport: createSocketTransportAdapter(sessionSocket) }) },
        });
        await vi.waitFor(() => expect(invalidations).toBeGreaterThan(0));
        const workflow = createWorkflowOriginContextInputPort({
            accountId: 'wake-account', originSessionId: sessionId, machineId: 'wake-machine',
            storage: { execute: async () => { workflowReads++; return { runs: [] }; } },
            resolveEncryption: async () => { throw new Error('No workflow content to open'); },
            readDispatchFact: async () => 'not_dispatched', onDispatchedInput() {},
            onError: error => { throw error; },
        });
        const consumer = createSessionProviderInputConsumer({
            messageQueue: new MessageQueue2<string, string>(() => 'mode'),
            session: createSessionProviderInputConsumerSessionAdapter(client),
            reconcileWhenEmpty: 'skip', refreshBeforeQueuedBatch: false,
            waitForContextOnlyInputChange: signal => workflow.waitForChange(signal),
            takeContextOnlyInput: async signal => { takes++; await workflow.take(signal); return null; },
        });
        waiting = consumer.waitForNextInput({ abortSignal: lifetime.signal });
        await vi.waitFor(() => expect(workflowReads).toBe(1));
        const drain = async () => { for (let turn = 0; turn < 5; turn++) await new Promise<void>(resolve => setImmediate(resolve)); };
        await drain();
        const baseline = takes;
        for (const entityId of ['other-session-a', 'other-session-b', 'other-session-c']) {
            const before = changeReads;
            cursor++;
            changes = [{ cursor, kind: 'session', entityId, changedAt: cursor }];
            sockets.to('account').emit('update', UpdateSchema.parse({ id: `account-${cursor}`, seq: cursor,
                createdAt: cursor, body: { t: 'account-change' } }));
            await vi.waitFor(() => expect(changeReads).toBeGreaterThan(before));
            await drain();
        }
        expect({ takes, workflowReads }).toEqual({ takes: baseline, workflowReads: 1 });

        // Workflow delivery is durable on its origin Session, even without an
        // exact socket broadcast (e.g. change-feed recovery after disconnect).
        const beforeOwnChange = { workflowReads, invalidations };
        cursor++;
        changes = [{ cursor, kind: 'session', entityId: sessionId, changedAt: cursor,
            hint: { kind: 'workflow-run-delivery', runId: 'origin-run', revision: 2 } }];
        sockets.to('account').emit('update', UpdateSchema.parse({ id: `account-${cursor}`, seq: cursor,
            createdAt: cursor, body: { t: 'account-change' } }));
        await vi.waitFor(() => {
            expect(invalidations).toBeGreaterThan(beforeOwnChange.invalidations);
            expect(workflowReads).toBeGreaterThan(beforeOwnChange.workflowReads);
        });
        await drain();
        // The existing destination broadcast remains the direct Follow path.
        const beforeExactChange = workflowReads;
        sockets.to('destination').emit('session', SessionBroadcastContainerSchema.parse({ id: 'source-message', createdAt: 10,
            body: { t: 'session-changed', sessionId } }));
        await vi.waitFor(() => expect(workflowReads).toBeGreaterThan(beforeExactChange));
    } finally {
        lifetime.abort();
        await waiting;
        await client?.close();
        accountSocket.close(); sessionSocket.close();
        await new Promise<void>(resolve => sockets.close(() => resolve()));
        get.mockRestore();
    }
});
