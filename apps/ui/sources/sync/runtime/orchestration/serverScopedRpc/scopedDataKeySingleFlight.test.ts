import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    resetScopedMachineTransportCacheForTests,
    resolveScopedMachineTransport,
} from './serverScopedRpcPool';
import {
    resolveScopedSessionCryptoContext,
} from './resolveScopedSessionDataKey';
import { resetSessionByIdHttpReadsForTests } from '@/sync/engine/sessions/sessionByIdHttp';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { createCapturedServerReadTransport } from './capturedServerReadTransport';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { MachineReadBatchRequestV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';
import { createFakeCryptoWorker } from '@/sync/encryption/nativeCryptoWorker/fakeCryptoWorker';

async function createMachineKeyOpeningFixture() {
    const secret = new Uint8Array(32).fill(11);
    const encryption = await Encryption.create(secret);
    const worker = createFakeCryptoWorker();
    const openedEnvelopes: string[] = [];
    encryption.configureNativeCryptoWorker({ worker: { ...worker,
        decryptDataKeyEnvelopeV1: async request => {
            openedEnvelopes.push(...request.items.map(item => item.envelopeBase64));
            return worker.decryptDataKeyEnvelopeV1(request);
        },
    }, routing: { mode: 'auto', minPayloadBytes: 0 } });
    const credentials = { token: 'token-b', secret: encodeBase64(secret, 'base64') };
    const readTransport = createCapturedServerReadTransport({ serverId: 'server-b',
        profile: { serverUrl: 'https://server-b.example.test' }, credentials });
    const seal = (value: number) => encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: new Uint8Array(32).fill(value),
        recipientPublicKey: encryption.contentDataKey, randomBytes: length => new Uint8Array(length).fill(3) }), 'base64');
    return { encryption, credentials, readTransport, openedEnvelopes, seal };
}

const runtimeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

function isReachabilityProbe(input: unknown): boolean {
    const url = String(input ?? '');
    return url.endsWith('/health') || url.endsWith('/v1/auth/ping');
}

function reachabilityOk() {
    return { ok: true, status: 200, json: async () => ({}) };
}

function machineBody(machineId: string, dataEncryptionKey: string) {
    return { machine: { id: machineId, dataEncryptionKey } };
}

function sessionByIdBody(sessionId: string, dataEncryptionKey: string) {
    return {
        session: {
            id: sessionId,
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: 'metadata',
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey,
        },
    };
}

function countCalls(match: string): number {
    return runtimeFetchMock.mock.calls.filter(([input]) => String(input).includes(match)).length;
}

function expectMachineDataKey(transport: Awaited<ReturnType<typeof resolveScopedMachineTransport>>, bytes: readonly number[]) {
    expect(transport?.mode).toBe('e2ee');
    expect(transport?.mode === 'e2ee' ? transport.dataKey : null).toEqual(new Uint8Array(bytes));
}

describe('scoped data-key resolution coalesces concurrent callers', () => {
    afterEach(async () => {
        runtimeFetchMock.mockReset();
        resetScopedMachineTransportCacheForTests();
        resetSessionByIdHttpReadsForTests();
        try {
            const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
            await resetServerReachabilitySupervisors();
        } catch {
            // ignore
        }
    });

    it('opens the machine data-key envelope once for a burst of concurrent probes', async () => {
        const { encryption, credentials, readTransport, openedEnvelopes, seal } = await createMachineKeyOpeningFixture();
        const envelope = seal(9);
        runtimeFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
            if (isReachabilityProbe(input)) return reachabilityOk();
            const demand = MachineReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body)));
            return Response.json({ results: demand.machineIds.map(machineId => ({ machineId, status: 'found',
                machine: { id: machineId, metadata: null, metadataVersion: 0, daemonState: null,
                    daemonStateVersion: 0, dataEncryptionKey: envelope } })) });
        });

        // The new-session screen fires ~8-10 capability preflight probes against one
        // machine at once; every one of them resolves the same machine transport.
        const results = await Promise.all(Array.from({ length: 8 }, () => resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: credentials.token, readTransport, encryption,
            machineId: 'machine-1',
            decryptEncryptionKey: value => encryption.decryptEncryptionKey(value),
        })));

        for (const result of results) {
            expectMachineDataKey(result, Array.from(new Uint8Array(32).fill(9)));
        }
        expect(openedEnvelopes).toEqual([envelope]);
        expect(countCalls('/v1/machines/read-batch')).toBe(1);
    });

    it('keeps concurrent machine transports separate per machine id', async () => {
        const { encryption, credentials, readTransport, openedEnvelopes, seal } = await createMachineKeyOpeningFixture();
        const envelopes = { first: seal(1), second: seal(2) };
        runtimeFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
            if (isReachabilityProbe(input)) return reachabilityOk();
            const demand = MachineReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body)));
            return Response.json({ results: demand.machineIds.map(machineId => ({ machineId, status: 'found',
                machine: { id: machineId, metadata: null, metadataVersion: 0, daemonState: null,
                    daemonStateVersion: 0, dataEncryptionKey: machineId === 'machine-2' ? envelopes.second : envelopes.first } })) });
        });

        const request = (machineId: string) => resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: credentials.token, readTransport, encryption,
            machineId,
            decryptEncryptionKey: value => encryption.decryptEncryptionKey(value),
        });

        const [a, b, c, d] = await Promise.all([
            request('machine-1'),
            request('machine-2'),
            request('machine-1'),
            request('machine-2'),
        ]);

        expectMachineDataKey(a, Array.from(new Uint8Array(32).fill(1)));
        expectMachineDataKey(c, Array.from(new Uint8Array(32).fill(1)));
        expectMachineDataKey(b, Array.from(new Uint8Array(32).fill(2)));
        expectMachineDataKey(d, Array.from(new Uint8Array(32).fill(2)));
        expect(openedEnvelopes.sort()).toEqual([envelopes.first, envelopes.second].sort());
        expect(countCalls('/v1/machines/read-batch')).toBe(1);
    });

    it('does not retain a failed machine transport resolution for later callers', async () => {
        let machineCalls = 0;
        runtimeFetchMock.mockImplementation(async (input: unknown) => {
            if (isReachabilityProbe(input)) return reachabilityOk();
            machineCalls += 1;
            if (machineCalls === 1) {
                return { ok: false, status: 500, json: async () => ({}) };
            }
            return { ok: true, status: 200, json: async () => machineBody('machine-1', 'envelope-1') };
        });
        const decrypt = vi.fn(async () => new Uint8Array([7]));

        const request = () => resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decrypt,
            timeoutMs: 50,
        });

        // The failing burst is coalesced into a single attempt...
        const failed = await Promise.allSettled([request(), request(), request()]);
        for (const result of failed) {
            expect(result).toMatchObject({ status: 'rejected', reason: {
                name: 'HappyError', status: 500, kind: 'server', canTryAgain: true,
            } });
        }
        expect(machineCalls).toBe(1);

        // ...and a failure is never retained, so the next caller retries for real.
        expectMachineDataKey(await request(), [7]);
        expect(machineCalls).toBe(2);
    });

    it('shares the authenticated Session observation while the real encryption owner admits its envelope', async () => {
        const secret = new Uint8Array(32).fill(7);
        const encryption = await Encryption.create(secret);
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const key = new Uint8Array(32).fill(9);
        const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
            recipientPublicKey: encryption.contentDataKey, randomBytes: length => new Uint8Array(length).fill(3) }), 'base64');
        const credentials = { token: 'token', secret: encodeBase64(secret, 'base64') };
        const readTransport = createCapturedServerReadTransport({ serverId: 's-id',
            profile: { serverUrl: 'https://server.example.test' }, credentials });
        runtimeFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
            if (isReachabilityProbe(input)) return reachabilityOk();
            const demand = SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body)));
            return Response.json({ results: demand.sessionIds.map(sessionId => ({ sessionId,
                detail: { status: 200, body: sessionByIdBody(sessionId, envelope) } })) });
        });

        const results = await Promise.all(Array.from({ length: 6 }, () => resolveScopedSessionCryptoContext({
            serverId: 's-id',
            serverUrl: 'https://server.example.test',
            token: 'token',
            sessionId: 'session-1',
            credentials, readTransport,
            decryptEncryptionKey: value => encryption.decryptEncryptionKey(value),
        })));

        for (const result of results) {
            expect(result).toEqual({ encryptionMode: 'e2ee', sessionDataKey: new Uint8Array(32).fill(9) });
        }
        expect(countCalls('/v2/sessions/read-batch')).toBe(1);
        expect(encryption.getSessionEncryption('session-1')).toBeNull();
    });

    it('keeps concurrent session keys separate per session id', async () => {
        const secret = new Uint8Array(32).fill(7);
        const encryption = await Encryption.create(secret);
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const seal = (value: number) => encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: new Uint8Array(32).fill(value),
            recipientPublicKey: encryption.contentDataKey, randomBytes: length => new Uint8Array(length).fill(3) }), 'base64');
        const envelopes = { first: seal(1), second: seal(2) };
        const credentials = { token: 'token', secret: encodeBase64(secret, 'base64') };
        const readTransport = createCapturedServerReadTransport({ serverId: 's-id',
            profile: { serverUrl: 'https://server.example.test' }, credentials });
        runtimeFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
            if (isReachabilityProbe(input)) return reachabilityOk();
            const demand = SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body)));
            return Response.json({ results: demand.sessionIds.map(sessionId => ({ sessionId,
                detail: { status: 200, body: sessionByIdBody(sessionId, sessionId === 'session-2' ? envelopes.second : envelopes.first) } })) });
        });

        const request = async (sessionId: string) => (await resolveScopedSessionCryptoContext({
            serverId: 's-id',
            serverUrl: 'https://server.example.test',
            token: 'token',
            sessionId,
            credentials, readTransport,
            decryptEncryptionKey: value => encryption.decryptEncryptionKey(value),
        })).sessionDataKey;

        const [a, b, c, d] = await Promise.all([
            request('session-1'),
            request('session-2'),
            request('session-1'),
            request('session-2'),
        ]);

        expect(a).toEqual(new Uint8Array(32).fill(1));
        expect(c).toEqual(new Uint8Array(32).fill(1));
        expect(b).toEqual(new Uint8Array(32).fill(2));
        expect(d).toEqual(new Uint8Array(32).fill(2));
        expect(countCalls('/v2/sessions/read-batch')).toBe(1);
        const input = runtimeFetchMock.mock.calls.find(([path]) => String(path).includes('/v2/sessions/read-batch'))?.[1];
        expect(SessionReadBatchRequestV1Schema.parse(JSON.parse(String(input?.body))).sessionIds).toEqual(['session-1', 'session-2']);
    });
});
