import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { FilesystemDownloadInputSchema, FilesystemUploadInputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import {
    PreparedTransferRpcRequestV1Schema,
    PreparedTransferRpcResponseV1Schema,
    resolvePreparedTransferRpcPhaseV1,
    type PreparedTransferRpcRequestV1,
} from '@happier-dev/protocol/machines/transfer/preparedTransferRpcV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createDeferred } from '@/dev/testkit';
import { parseBrowserIrohClientCommand, type BrowserIrohClientCommand, type BrowserIrohWorkerReply } from '@/sync/runtime/browserIroh/protocol';
import type { BrowserIrohMessagePort } from '@/sync/runtime/browserIroh/workerConnection';

// Only the physical Home network is replaced. Scoped RPC selection, its Account
// codec, prepared phase binding, byte encryption and both transfer drivers stay real.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const outgoing: SocketRpcRequestPayload[] = [];
let respond: (request: SocketRpcRequestPayload) => Promise<unknown>;
installDisconnectedServerSocketBoundary(socket => {
    socket.connected = true;
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, request: SocketRpcRequestPayload) => {
        if (event !== 'rpc-call') return { ok: true };
        outgoing.push(request);
        return await respond(request);
    });
});
// Import source wiring after boundary installation, outside the behavior hook.
await import('@/sync/syncEngine');

let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let ownsBrowserEndpointBoundary = false;
const machineId = 'prepared-machine';
const expiresAt = () => Date.now() + 60_000;
const endpoint = (id: string) => `http://127.0.0.1:46001/machine-transfers/direct/${Buffer.from(id).toString('base64url')}`;
const importEndpoint = (id: string) => `http://127.0.0.1:46001/machine-transfers/direct/imports/${encodeURIComponent(id)}`;
const rpcResponse = (body: unknown, extra: Record<string, string> = {}) => PreparedTransferRpcResponseV1Schema.parse({
    status: 200, contentType: 'application/json', body: JSON.stringify(body), ...extra,
});

async function requester(operationId: string) {
    const { resolveMachineCarrierRoute } = await import('./machineCarrierHttpLease');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    expect(accountLifetime?.isCurrent()).toBe(true);
    const route = await resolveMachineCarrierRoute(machineId, serverId);
    expect(route.kind).toBe('server_rpc');
    if (route.kind === 'unavailable') throw new Error(route.error);
    const carrier = await route.acquire({ operationId, accountLifetime: accountLifetime! });
    if (carrier.kind === 'native_http') throw new Error('Browser transfer must have a requester');
    return carrier.request;
}

function readPhase(request: SocketRpcRequestPayload): PreparedTransferRpcRequestV1 {
    const payload = PreparedTransferRpcRequestV1Schema.parse(request.params);
    expect(request.method).toBe(`${machineId}:${resolvePreparedTransferRpcPhaseV1(payload.path, payload.httpMethod, payload.body)}`);
    return payload;
}

/** SharedWorker is the OS boundary; the packaged client and acquisition stay real. */
function installUnavailableBrowserEndpointBoundary(options: Readonly<{ hold?: Promise<void>; refuseRelease?: boolean }> = {}) {
    ownsBrowserEndpointBoundary = true;
    const attempted = createDeferred<void>();
    const commands: BrowserIrohClientCommand[] = [];
    vi.stubGlobal('location', { origin: 'https://prepared-transfer.test' });
    vi.stubGlobal('SharedWorker', class UnavailableSharedWorker {
        onerror: ((event: unknown) => void) | null = null;
        readonly port: BrowserIrohMessagePort;
        constructor(scriptUrl: string) {
            expect(new URL(scriptUrl).pathname).toBe('/vendor/iroh/happier-iroh-worker.js');
            let receive: ((event: { data: unknown }) => void) | undefined;
            this.port = {
                addEventListener: (_type, listener) => { receive = listener; },
                postMessage: message => {
                    const command = parseBrowserIrohClientCommand(message);
                    if (!command) throw new Error('Malformed browser endpoint command');
                    commands.push(command);
                    if (command.kind === 'acquireLease') attempted.resolve();
                    void Promise.resolve(command.kind === 'acquireLease' ? options.hold : undefined).then(() => {
                        const reply: BrowserIrohWorkerReply = command.kind === 'acquireLease' && options.refuseRelease
                            ? { v: 1, kind: 'leaseAcquired', requestId: command.requestId, leaseId: 'held-browser-lease',
                                endpointId: 'b'.repeat(64), appliedRelayUrls: command.relayUrls }
                            : command.kind === 'releaseClient'
                            ? { v: 1, kind: 'released', requestId: command.requestId }
                            : { v: 1, kind: 'error', requestId: command.requestId,
                                code: 'endpoint_unavailable', message: command.kind === 'releaseLease'
                                    ? 'Shared endpoint lease release failed' : 'Browser endpoint failed to become ready' };
                        receive?.({ data: reply });
                    });
                },
            };
        }
    });
    return { attempted: attempted.promise, commands };
}

async function preferredBrowserRoute() {
    const { storage } = await import('@/sync/domains/state/storage');
    const current = storage.getState().machines[machineId]!;
    const { readMachineDaemonTransferState } = await import('../availability/machineDaemonTransferState');
    const declared = readMachineDaemonTransferState({ daemonState: current.daemonState });
    if (!declared) throw new Error('Expected the current finite transfer declaration');
    const daemonState = { ...current.daemonState, transfer: { ...declared, listenerClasses: {
        ...declared.listenerClasses, loopback_http: { enabled: true, configured: true, active: false },
    } } };
    const { MachineOperationProtocolCapabilitiesV1Schema } = await import('@happier-dev/protocol/machines/operationProtocolCapabilitiesV1');
    const operationProtocolCapabilities = MachineOperationProtocolCapabilitiesV1Schema.parse({
        irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] },
    });
    const row = { ...createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' }),
        daemonState: encodePlainMachineStoredContent(daemonState), operationProtocolCapabilities, operationProtocolCapabilitiesRevision: 1 };
    homes.answer(serverId, `/v1/machines/${machineId}`, { body: { machine: row } });
    homes.answer(serverId, '/v1/machines', { body: [row] });
    homes.answer(serverId, '/v1/machines?includeRevoked=true', { body: [row] });
    homes.answer(serverId, '/v1/features', { body: FeaturesResponseSchema.parse({ features: {
        machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: true } }, peerMediation: { enabled: true } },
    }, capabilities: {} }) });
    const { getReadyServerFeatures } = await import('@/sync/api/capabilities/getReadyServerFeatures');
    await getReadyServerFeatures({ serverId, force: true });
    storage.getState().applyMachines([{ ...current, daemonState, operationProtocolCapabilities, operationProtocolCapabilitiesRevision: 1 }]);
    const { resolveMachineCarrierRoute } = await import('./machineCarrierHttpLease');
    const route = await resolveMachineCarrierRoute(machineId, serverId);
    expect(route).toMatchObject({ kind: 'iroh_peer', carrierKind: 'browser_stream' });
    if (route.kind === 'unavailable') throw new Error(route.error);
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('Expected a restored Account lifetime');
    return { route, accountLifetime };
}

beforeEach(async () => {
    ownsBrowserEndpointBoundary = false;
    vi.stubGlobal('SharedWorker', class SharedWorker {});
    installHomeGovernanceBoundaries(homes);
    const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
    await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Prepared transfer Home', serverUrl: 'https://prepared-transfer.test', accountId: 'account-a' });
    homes.answer(serverId, '/v1/features', { body: FeaturesResponseSchema.parse({ features: {
        machines: { enabled: true, transfer: { enabled: true } },
    }, capabilities: {} }) });
    const daemonState = MachinePublishedDaemonStateV1Schema.parse({ status: 'running', transfer: { supported: { import: true, export: true }, listenerClasses: {
        loopback_http: { enabled: false, configured: false, active: false },
        tailscale_serve_https: { enabled: false, configured: false, active: false },
    }, lifecycle: { mode: 'lazy_idle_shutdown', version: 1 } } });
    const row = { ...createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' }),
        daemonState: encodePlainMachineStoredContent(daemonState) };
    homes.answer(serverId, `/v1/machines/${machineId}`, { body: { machine: row } });
    homes.answer(serverId, '/v1/machines', { body: [row] });
    homes.answer(serverId, '/v1/machines?includeRevoked=true', { body: [row] });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://prepared-transfer.test', accountId: 'account-a', request: homes.request });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.getState().applyMachines([createMachineFixture({ id: machineId, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        daemonState })]);
    const { getReadyServerFeatures } = await import('@/sync/api/capabilities/getReadyServerFeatures');
    const features = await getReadyServerFeatures({ serverId, force: true });
    expect(features?.features.machines.transfer.enabled).toBe(true);
    outgoing.length = 0;
    respond = async () => { throw new Error('Unexpected prepared transfer request'); };
});

afterEach(async () => {
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    // The replacement Account in the retirement case is also this fixture's
    // runtime; the original connection handle deliberately will not retire it.
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    await connection?.dispose();
    await homes.reset();
    const { resolvePackagedBrowserIrohEndpointClient, resetPackagedBrowserIrohEndpointClientForTests } = await import('@/sync/runtime/browserIroh/endpointClient');
    if (ownsBrowserEndpointBoundary) {
        const client = resolvePackagedBrowserIrohEndpointClient();
        await client.releaseAll();
        client.close();
    }
    resetPackagedBrowserIrohEndpointClientForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('prepared transfer Home RPC carrier', () => {
    it('uses Home when the preferred browser endpoint fails before any transfer request', async () => {
        const boundary = installUnavailableBrowserEndpointBoundary();
        const { route, accountLifetime } = await preferredBrowserRoute();
        respond = async request => { readPhase(request); return { ok: true, result: rpcResponse({ success: true }) }; };
        const carrier = await route.acquire({ operationId: 'readiness-import', accountLifetime });
        expect(carrier.kind).toBe('server_rpc');
        expect(boundary.commands.map(command => command.kind)).toEqual(['acquireLease']);
        if (carrier.kind === 'native_http') throw new Error('Expected the Home requester');
        expect(await (await carrier.request(`${importEndpoint('readiness-import')}/finalize`, { method: 'POST' })).json()).toEqual({ success: true });
        expect(outgoing).toHaveLength(1);
        await carrier.release();
    });

    it.each(['cancelled', 'Account retired'] as const)('refuses fallback when acquisition fails after the operation is %s', async retirement => {
        const hold = createDeferred<void>();
        const boundary = installUnavailableBrowserEndpointBoundary({ hold: hold.promise });
        const { route, accountLifetime } = await preferredBrowserRoute();
        const controller = new AbortController();
        const pending = route.acquire({ operationId: 'retired-readiness-import', accountLifetime, signal: controller.signal });
        const refused = expect(pending).rejects.toBeInstanceOf(Error);
        await boundary.attempted;
        if (retirement === 'cancelled') controller.abort();
        else {
            await homes.switchAccount(serverId, 'replacement-account');
            const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
            await switchConnectionToActiveServer();
            expect(accountLifetime.isCurrent()).toBe(false);
        }
        hold.resolve();
        await refused;
        expect(outgoing).toEqual([]);
        expect(boundary.commands.map(command => command.kind)).toEqual(['acquireLease']);
    });

    it('refuses Home fallback when a failed acquisition cannot release its shared endpoint custody', async () => {
        const boundary = installUnavailableBrowserEndpointBoundary({ refuseRelease: true });
        const { route, accountLifetime } = await preferredBrowserRoute();
        homes.answer(serverId, '/v1/machines/peer/mediation/route-grants', { status: 403, body: { ok: false, reasonCode: 'grant_missing' } });
        await expect(route.acquire({ operationId: 'unreleased-readiness-import', accountLifetime })).rejects.toBeInstanceOf(Error);
        expect(boundary.commands.map(command => command.kind)).toEqual(['acquireLease', 'releaseLease']);
        expect(outgoing).toEqual([]);
    });

    it.each(['preview', 'download'] as const)('reads a workspace %s through real Action admission and strict Home transfer framing', async surface => {
        const bytes = new Uint8Array([0, 255, 128, 10]);
        const transferId = 'export / unicode-λ';
        const manifestHash = `sha256:${Buffer.from(await crypto.subtle.digest('SHA-256', bytes.buffer)).toString('hex')}`;
        let closed = false;
        let recipientPublicKeyBase64 = '';
        const { createEncryptedTransferChunkEnvelope } = await import('./transferChunkEncryption');
        respond = async request => {
            if (request.method === `${machineId}:${RPC_METHODS.STAT_FILE}`) {
                return { ok: true, result: { success: true, exists: true, kind: 'file', sizeBytes: bytes.length } };
            }
            if (request.method === `${machineId}:daemon.filesystem.download`) {
                // Exact daemon ingress schema, including the version and target;
                // inspecting only .input previously hid the live framing defect.
                const envelope = TargetedActionRpcRequestV1Schema.parse(request.params);
                expect(envelope.target).toEqual({ kind: 'machine', machineId });
                const input = FilesystemDownloadInputSchema.parse(envelope.input);
                expect(input).toMatchObject({ rootPath: '/repo', path: '/repo/binary' });
                return { ok: true, result: { success: true, status: 'accepted', operationId: 'download-operation', destinationId: input.destination.destinationId,
                    prepared: { transferId, name: 'binary', sizeBytes: bytes.length, manifestHash, expiresAt: expiresAt(),
                        endpointCandidates: [{ kind: 'http', url: endpoint(transferId), authorizationToken: 'prepared-export-token', expiresAt: expiresAt() }] } } };
            }
            const phase = readPhase(request);
            expect(phase.authorizationToken).toBe('prepared-export-token');
            let body: unknown;
            if (phase.path.endsWith('/open')) {
                recipientPublicKeyBase64 = phase.recipientPublicKeyBase64!;
                body = { transferId, totalChunks: 1, sizeBytes: bytes.length, manifestHash };
            } else if (phase.path.endsWith('/chunks/0')) {
                body = { transferId, kind: 'chunk', sequence: 0, ...await createEncryptedTransferChunkEnvelope({
                    transferId, sequence: 0, payload: bytes, recipientPublicKeyBase64,
                }) };
            } else {
                if (surface === 'download') expect(closed).toBe(true);
                expect(phase.body).toMatchObject({ success: true, sizeBytes: bytes.length, manifestHash });
                body = { success: true };
            }
            return { ok: true, result: rpcResponse(body) };
        };
        const received: number[] = [];
        const target = { machineId, serverId, rootPath: '/repo' };
        const { resolveMachineCarrierRoute } = await import('./machineCarrierHttpLease');
        expect(await resolveMachineCarrierRoute(machineId, serverId)).toMatchObject({ kind: 'server_rpc' });
        if (surface === 'preview') {
            vi.stubEnv('EXPO_PUBLIC_HAPPIER_SESSION_FILE_INLINE_MAX_BYTES', '1');
            const { workspaceReadFile } = await import('@/sync/ops/workspaceFileSystem/fileReadWrite');
            // This file exceeds the configured inline ceiling, independently
            // of the caller's preview budget, and must use prepared delivery.
            expect(await workspaceReadFile(target, 'binary', { maxBytes: 1024 * 1024 }))
                .toEqual({ success: true, content: Buffer.from(bytes).toString('base64') });
        } else {
            const { downloadDaemonWorkspaceFileToDestination } = await import('../families/workspaceFileTransfers');
            expect(await downloadDaemonWorkspaceFileToDestination({ ...target,
                request: { path: 'binary', asZip: false },
                destination: { writeBytes: async chunk => { received.push(...chunk); }, close: async () => { closed = true; }, cleanup: async () => {} },
            })).toEqual({ ok: true, name: 'binary', sizeBytes: bytes.length });
            expect(received).toEqual([...bytes]);
        }
        // Preview selection and the bounded byte reader each admit the file
        // size; the accepted publication and byte phases must still run once.
        expect(outgoing.map(value => value.method)).toEqual([...(surface === 'preview' ? [RPC_METHODS.STAT_FILE, RPC_METHODS.STAT_FILE] : []),
            'daemon.filesystem.download', RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
            RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE].map(method => `${machineId}:${method}`));
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        expect(getSyncSingleton().encryption).toBeNull();
    });

    it('encrypts imports on a plain Account and returns the typed terminal file result', async () => {
        const uploadId = 'import / unicode-λ';
        const bytes = new Uint8Array([0, 255, 128, 10]);
        const { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } = await import('./transferChunkEncryption');
        const recipient = createTransferRecipientKeyPair();
        const received: number[] = [];
        respond = async request => {
            if (request.method === `${machineId}:daemon.filesystem.upload`) {
                const envelope = TargetedActionRpcRequestV1Schema.parse(request.params);
                expect(envelope.target).toEqual({ kind: 'machine', machineId });
                const input = FilesystemUploadInputSchema.parse(envelope.input);
                return { ok: true, result: { success: true, status: 'accepted', operationId: 'upload-operation', sourceId: input.source.sourceId,
                    prepared: { uploadId, destDisplayPath: '/repo/binary', expectedSizeBytes: bytes.length, chunkSizeBytes: bytes.length,
                        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64, expiresAt: expiresAt(),
                        endpointCandidates: [{ kind: 'http', url: importEndpoint(uploadId), expiresAt: expiresAt() }] } } };
            }
            const phase = readPhase(request);
            if (phase.path.endsWith('/chunks/0')) {
                const { z } = await import('zod/mini');
                const chunk = z.strictObject({ payloadBase64: z.string(), encryptedDataKeyEnvelopeBase64: z.string() }).parse(phase.body);
                received.push(...await decryptEncryptedTransferChunkEnvelope({ ...chunk, transferId: uploadId, sequence: 0,
                    recipientSecretKeySeed: recipient.recipientSecretKeySeed }));
                return { ok: true, result: rpcResponse({ success: true }) };
            }
            return { ok: true, result: rpcResponse({ success: true, finalized: { success: true, path: '/repo/binary', sizeBytes: bytes.length }, sha256: 'binary-digest' }) };
        };
        const request = await requester(uploadId);
        const { uploadBulkPayloadFromFileViaDirectImport } = await import('./directTransferImportUpload');
        const { callAdmittedFilesystemTransferActionRpc } = await import('./filesystemTransferActionClient');
        const result = await uploadBulkPayloadFromFileViaDirectImport({ machineId, serverId, accountId: 'account-a',
            callAdmittedAction: callAdmittedFilesystemTransferActionRpc,
            request: { t: 'session_file_upload_v1', workingDirectory: '/repo', path: 'binary', sizeBytes: bytes.length, overwrite: false },
            fileReader: { sizeBytes: bytes.length, readBytes: async (offset, length) => bytes.slice(offset, offset + length), close: async () => {} },
            acquirePreparedCarrier: async () => ({ kind: 'server_rpc', request, release: async () => {} }),
        });
        expect(result).toEqual({ success: true, path: '/repo/binary', sizeBytes: bytes.length, sha256: 'binary-digest' });
        expect(received).toEqual([...bytes]);
        expect(outgoing.filter(value => value.method.endsWith(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE))).toHaveLength(1);
    });

    it('refuses a misbound operation and malformed phase before dispatch', async () => {
        const request = await requester('held-operation');
        await expect(request(`${endpoint('other-operation')}/open`, { method: 'POST', headers: { authorization: 'Bearer held-token' } })).rejects.toThrow();
        await expect(request(`${endpoint('held-operation')}/open?grant=other`, { method: 'POST', headers: { authorization: 'Bearer held-token' } })).rejects.toThrow();
        await expect(request(`${endpoint('held-operation')}/open`, { method: 'POST' })).rejects.toThrow();
        await expect(request(`${importEndpoint('held-operation')}/chunks/0`, { method: 'PUT', body: 'not-json' })).rejects.toThrow();
        await expect(request(`${importEndpoint('held-operation')}/chunks/0`, { method: 'PATCH', body: '{}' })).rejects.toThrow();
        expect(outgoing).toEqual([]);
    });

    it('cancels an issued phase without another delivery and rejects a late acknowledgement', async () => {
        const controller = new AbortController();
        const issued = createDeferred<void>();
        const reply = createDeferred<unknown>();
        respond = async request => { readPhase(request); issued.resolve(); return await reply.promise; };
        const request = await requester('cancelled-import');
        const pending = request(`${importEndpoint('cancelled-import')}/finalize`, { method: 'POST', signal: controller.signal });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await issued.promise;
        controller.abort();
        await rejected;
        reply.resolve({ ok: true, result: rpcResponse({ success: true }) });
        expect(outgoing).toHaveLength(1);
    });

    it('does not replay a terminal phase after delivery with an unknown acknowledgement', async () => {
        respond = async request => { readPhase(request); throw new TypeError('Home acknowledgement lost after dispatch'); };
        const request = await requester('uncertain-import');
        await expect(request(`${importEndpoint('uncertain-import')}/finalize`, { method: 'POST' })).rejects.toThrow();
        expect(outgoing).toHaveLength(1);
    });

    it('refuses an RPC frame outside the strict prepared response schema', async () => {
        respond = async request => { readPhase(request); return { ok: true, result: {
            ...rpcResponse({ success: true }), unexpected: 'not-a-published-field',
        } }; };
        const request = await requester('strict-import');
        await expect(request(`${importEndpoint('strict-import')}/finalize`, { method: 'POST' })).rejects.toThrow();
        expect(outgoing).toHaveLength(1);
    });

    it('retains the terminal committed-but-unusable result when the finalize body violates its owner contract', async () => {
        respond = async request => { readPhase(request); return { ok: true, result: rpcResponse({ success: true,
            finalized: { success: true, path: '/repo/binary', sizeBytes: 4, unexpected: true }, sha256: 'digest' }) }; };
        const request = await requester('strict-finalize');
        const { finalizeDirectImportSession, DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE } = await import('./directTransferImportClient');
        await expect(finalizeDirectImportSession({ baseUrl: importEndpoint('strict-finalize'), request })).resolves.toMatchObject({
            success: false, errorCode: DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE,
        });
        expect(outgoing).toHaveLength(1);
    });

    it('refuses a held capability after its real Account lifetime retires', async () => {
        const request = await requester('retired-import');
        await homes.switchAccount(serverId, 'replacement-account');
        const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await switchConnectionToActiveServer();
        await expect(request(`${importEndpoint('retired-import')}/finalize`, { method: 'POST' })).rejects.toThrow('action_account_scope_changed');
        expect(outgoing).toEqual([]);
    });

});
