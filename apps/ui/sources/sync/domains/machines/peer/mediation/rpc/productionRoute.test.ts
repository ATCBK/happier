import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    FeaturesResponseSchema,
    PeerLoopbackEndpointCandidateV1Schema,
    PEER_MEDIATION_RECEIPTS,
    type FeaturesResponse,
    type PeerLoopbackEndpointCandidateV1,
    type PeerMachineRpcDirectRequestV2,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { clearMachineRequestReachabilityForTest } from '@/sync/domains/machines/reachability/machineReachability';

const getReadyServerFeaturesSpy = vi.hoisted(() => vi.fn());
const TOKEN_A = 'header.eyJzdWIiOiJhY2NvdW50LTEifQ.signature';
const DATA_KEY_TOKEN = 'header.eyJzdWIiOiJhY2NvdW50LTEifQ.data-key-signature';
const getCredentialsForServerUrlSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());
const captureAuthoritySpy = vi.hoisted(() => vi.fn());
const storageSnapshot = vi.hoisted(() => ({
    state: {
        machines: {},
        machineListByServerId: {},
    } as Record<string, unknown>,
}));
const storageGetStateSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (...args: unknown[]) => getReadyServerFeaturesSpy(...args),
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: async (path: string, init?: RequestInit) => {
        const active = getActiveServerSnapshotSpy() as { serverUrl: string };
        const credentials = await getCredentialsForServerUrlSpy() as { token: string };
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${credentials.token}`);
        return await fetch(`${active.serverUrl}${path}`, { ...init, headers });
    },
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsForServerUrlSpy(...args),
    },
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(
        credentials
        && typeof credentials === 'object'
        && typeof (credentials as { secret?: unknown }).secret === 'string',
    ),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerId: () => String((getActiveServerSnapshotSpy() as { serverId?: unknown })?.serverId ?? ''),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope', () => ({
    captureServerRequestAuthorityForServerAccountScope: (...args: unknown[]) => captureAuthoritySpy(...args),
    createServerRequestWithServerScope: ({ activeRequest }: { activeRequest: (path: string, init?: RequestInit) => Promise<Response> }) => activeRequest,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const store = createStorageStoreMock({});
    return createStorageModuleStub({
        storage: Object.assign(store, {
            getState: () => storageGetStateSpy(),
        }),
    });
});

function createFeaturePayload(): FeaturesResponse {
    return FeaturesResponseSchema.parse({
        features: {
            machines: {
                enabled: true,
                rpc: {
                    enabled: true,
                    directPeer: { enabled: true },
                },
            },
        },
        capabilities: {},
    });
}


function createDirectRequest(): PeerMachineRpcDirectRequestV2 {
    return {
        v: 2,
        requestId: 'request_1',
        method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        params: { includeWorkers: true },
        grant: {
            payload: {
                v: 2, grantId: 'grant_1', accountId: 'account-1', machineId: 'machine_1',
                flowKind: 'machine_rpc', routeKind: 'loopback_direct',
                scope: { kind: 'machine_rpc', rpcScopeId: 'scope_1', allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS], maxCalls: 1, maxIdleMs: 30_000 },
                iat: 1_000, exp: 301_000, aud: 'happier-daemon-route-grant', endpointFingerprint: 'endpoint_1',
                proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url'),
            },
            signature: { keyId: 'key_1', alg: 'Ed25519', valueBase64Url: Buffer.from(new Uint8Array(64).fill(2)).toString('base64url') },
        },
        proof: {
            v: 2,
            kind: 'ephemeral_ed25519',
            signedGrantDigestBase64Url: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url'),
            nonceBase64Url: 'nonce_1',
            signatureBase64Url: Buffer.from(new Uint8Array(64).fill(2)).toString('base64url'),
        },
        routeKind: 'loopback_direct',
        flowKind: 'machine_rpc',
        endpointFingerprint: 'endpoint_1',
    };
}

function responseJson(payload: unknown): Response {
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}

async function importProductionRoute() {
    return await import('./productionRoute').catch((error: unknown) => ({ importError: error }));
}

describe('production peer mediation machine RPC route adapter', () => {
    beforeEach(() => {
        clearMachineRequestReachabilityForTest();
        getReadyServerFeaturesSpy.mockReset();
        getCredentialsForServerUrlSpy.mockReset();
        storageGetStateSpy.mockReset();
        getActiveServerSnapshotSpy.mockReset();
        captureAuthoritySpy.mockReset();
        vi.unstubAllGlobals();
        storageSnapshot.state = { machines: {}, machineListByServerId: {} };
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            generation: 1,
        });
        getReadyServerFeaturesSpy.mockResolvedValue(createFeaturePayload());
        getCredentialsForServerUrlSpy.mockResolvedValue({
            token: TOKEN_A,
            secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
        });
        captureAuthoritySpy.mockImplementation(async ({ scope, activeRequest }) => {
            const current = await getCredentialsForServerUrlSpy();
            const payload = JSON.parse(Buffer.from(String(current.token).split('.')[1]!, 'base64url').toString('utf8')) as { sub?: string };
            if (payload.sub !== scope.accountId) throw new Error('Account scope changed');
            return { scope, request: activeRequest, release: async () => {} };
        });
        storageGetStateSpy.mockImplementation(() => ({
            settingsScope: { serverId: 'server-a', accountId: 'account-1' },
            settings: { peerMediationPreferencesV1: { v: 1, flows: {}, byMachineId: {} } },
            ...storageSnapshot.state,
        }));
    });

    it('fails closed before route selection when stored credentials belong to another Account', async () => {
        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;

        const result = await module.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a',
            accountId: 'account-other',
            machineId: 'machine-1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        });

        expect(result).toMatchObject({ kind: 'fallback', reasonCode: 'grant_missing' });
        expect(storageGetStateSpy).not.toHaveBeenCalled();
    });

    it.each([
        { flows: { machine_rpc: { direct: 'disabled' } }, byMachineId: {} },
        { flows: { machine_rpc: { direct: 'enabled' } }, byMachineId: { machine_1: { flows: { machine_rpc: { direct: 'disabled' } } } } },
    ])('honors the stored direct-route preference before minting a grant: %j', async (preferences) => {
        storageSnapshot.state = {
            settingsScope: { serverId: 'server-a', accountId: 'account-1' },
            settings: { peerMediationPreferencesV1: { v: 1, ...preferences } },
            machines: {},
            machineListByServerId: {},
        };
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;

        await expect(module.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a', machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        })).resolves.toMatchObject({ kind: 'fallback', reasonCode: 'disabled_by_account_preference' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });


    it.each(['secret', 'data-key'] as const)('uses the current ephemeral proof for %s credentials without component-version probes', async (credentialKind) => {
        const endpoint = PeerLoopbackEndpointCandidateV1Schema.parse({
            v: 1,
            routeKind: 'loopback_direct',
            url: 'http://127.0.0.1:46011',
            endpointFingerprint: 'endpoint_1',
            expiresAt: Date.now() + 60_000,
        });
        storageSnapshot.state = {
            machines: {
                machine_1: { id: 'machine_1', daemonState: { peerMediation: { loopback: { endpoint } } } },
            },
            machineListByServerId: {},
        };
        getReadyServerFeaturesSpy.mockResolvedValue(FeaturesResponseSchema.parse({
            features: { machines: { enabled: true, rpc: { enabled: true, directPeer: { enabled: true } } } },
        }));
        if (credentialKind === 'data-key') getCredentialsForServerUrlSpy.mockResolvedValue({
            token: DATA_KEY_TOKEN,
            encryption: {
                publicKey: Buffer.from(new Uint8Array(32).fill(8)).toString('base64'),
                machineKey: Buffer.from(new Uint8Array(32).fill(9)).toString('base64'),
            },
        });
        const fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
            const body = JSON.parse(String(init?.body)) as { ephemeralPublicKeyBase64Url: string };
            return responseJson({
                ok: true,
                receipt: PEER_MEDIATION_RECEIPTS.routeGrantMinted,
                grant: {
                    payload: {
                        v: 2,
                        grantId: 'grant_v2',
                        accountId: 'account_1',
                        machineId: 'machine_1',
                        flowKind: 'machine_rpc',
                        routeKind: 'loopback_direct',
                        scope: {
                            kind: 'machine_rpc', rpcScopeId: `machine_1:${RPC_METHODS.DAEMON_MEMORY_STATUS}`,
                            allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS], maxCalls: 2, maxIdleMs: 30_000,
                        },
                        iat: 1_000,
                        exp: 301_000,
                        aud: 'happier-daemon-route-grant',
                        endpointFingerprint: 'endpoint_1',
                        proofKind: 'ephemeral_ed25519',
                        ephemeralPublicKeyBase64Url: body.ephemeralPublicKeyBase64Url,
                    },
                    signature: {
                        keyId: 'grant_key_1', alg: 'Ed25519',
                        valueBase64Url: Buffer.from(new Uint8Array(64).fill(4)).toString('base64url'),
                    },
                },
            });
        });
        vi.stubGlobal('fetch', fetchSpy);

        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;
        const result = await module.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a', machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        });

        expect(result).toMatchObject({
            kind: 'selected',
            grant: { payload: { v: 2, proofKind: 'ephemeral_ed25519' } },
            proof: { v: 2, kind: 'ephemeral_ed25519' },
        });
        const mintBody = JSON.parse(String(fetchSpy.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body));
        expect(mintBody).toMatchObject({ v: 2, kind: 'ephemeral_ed25519' });
    });


    it('rejects an expired advertisement before minting a grant, even with fresh Machine presence', async () => {
        storageSnapshot.state = {
            machines: {
                machine_1: {
                    id: 'machine_1', active: true, activeAt: Date.now(),
                    daemonState: { peerMediation: { loopback: { endpoint: {
                        v: 1, routeKind: 'loopback_direct', url: 'http://127.0.0.1:46011',
                        endpointFingerprint: 'expired_endpoint', expiresAt: Date.now() - 1,
                    } } } },
                },
            },
            machineListByServerId: {},
        };
        // HTTP is the boundary; no route-grant request may be admitted for this topology.
        const fetchSpy = vi.fn(async () => { throw new Error('Unexpected grant request'); });
        vi.stubGlobal('fetch', fetchSpy);
        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;

        await expect(module.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a', machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        })).resolves.toMatchObject({ kind: 'fallback', reasonCode: 'topology_unavailable' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('reports absent current daemon topology without attempting authentication', async () => {
        storageSnapshot.state = { machines: {}, machineListByServerId: {} };
        getCredentialsForServerUrlSpy.mockResolvedValue({
            token: DATA_KEY_TOKEN,
            encryption: {
                publicKey: Buffer.from(new Uint8Array(32).fill(8)).toString('base64'),
                machineKey: Buffer.from(new Uint8Array(32).fill(9)).toString('base64'),
            },
        });
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;

        await expect(module.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a',
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        })).resolves.toMatchObject({
            kind: 'fallback',
            reasonCode: 'topology_unavailable',
        });
        expect(fetchSpy).not.toHaveBeenCalled();
    });


    it('fails closed to fallback when grant transport is unavailable', async () => {
        const endpoint: PeerLoopbackEndpointCandidateV1 = {
            v: 1,
            routeKind: 'loopback_direct',
            url: 'http://127.0.0.1:46012',
            endpointFingerprint: 'endpoint_2',
            expiresAt: Date.now() + 60_000,
        };
        storageSnapshot.state = {
            machines: {
                machine_1: {
                    id: 'machine_1',
                    daemonState: {
                        peerMediation: {
                            loopback: {
                                endpoint,
                            },
                        },
                    },
                },
            },
            machineListByServerId: {},
        };
        vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
            throw new Error('route grant network unavailable');
        }));

        const module = await importProductionRoute();
        expect(module).toHaveProperty('resolveProductionMachineRpcDirectRoute');
        if ('importError' in module) throw module.importError;

        const result = await module.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a',
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        });

        expect(result).toEqual({
            kind: 'fallback',
            receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
            reasonCode: 'grant_missing',
        });
    });

    it('does not mint a grant when the target credential account changes after endpoint selection', async () => {
        const endpoint: PeerLoopbackEndpointCandidateV1 = {
            v: 1,
            routeKind: 'loopback_direct',
            url: 'http://127.0.0.1:46012',
            endpointFingerprint: 'endpoint_2',
            expiresAt: Date.now() + 60_000,
        };
        storageSnapshot.state = {
            machines: {
                machine_1: {
                    id: 'machine_1',
                    daemonState: { peerMediation: { loopback: { endpoint } } },
                },
            },
            machineListByServerId: {},
        };
        const replacementToken = 'header.eyJzdWIiOiJhY2NvdW50LTIifQ.signature';
        getCredentialsForServerUrlSpy
            .mockResolvedValueOnce({ token: TOKEN_A, secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64') })
            .mockResolvedValue({ token: replacementToken, secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64') });
        // Reachability is checked before the authenticated grant boundary.
        const fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
            throw new Error('Unexpected grant request');
        });
        vi.stubGlobal('fetch', fetchSpy);

        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;
        const result = await module.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a',
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        });

        expect(result).toEqual({
            kind: 'fallback',
            receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
            reasonCode: 'grant_missing',
        });
        expect(fetchSpy.mock.calls.map(([, init]) => init?.method)).toEqual(['OPTIONS']);
    });


    it('forwards the caller abort signal to the direct loopback request', async () => {
        const controller = new AbortController();
        controller.abort();
        let capturedSignal: AbortSignal | undefined;
        const fetchSpy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
            capturedSignal = init?.signal ?? undefined;
            if (init?.signal?.aborted) {
                return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }
            return Promise.resolve(responseJson({ v: 1, ok: true }));
        });
        vi.stubGlobal('fetch', fetchSpy);

        const module = await importProductionRoute();
        expect(module).toHaveProperty('postProductionMachineRpcDirect');
        if ('importError' in module) throw module.importError;

        const result = await module.postProductionMachineRpcDirect({
            url: 'http://127.0.0.1:46021/peer-mediation/v1/machine-rpc',
            request: createDirectRequest(),
            signal: controller.signal,
        }).catch((error: unknown) => error);

        // The caller signal must reach the actual request transport.
        expect(capturedSignal?.aborted).toBe(true);
        expect(readRpcRequestDisposition(result)).toBe('outcomeUnknown');
    });

    it.each([
        { status: 200, contentType: 'text/html', body: '<html>upstream unavailable: private-body</html>',
            bodyWasJson: false, rpcErrorCode: 'MACHINE_RPC_INVALID_RESPONSE', schemaIssues: [] },
        { status: 200, contentType: 'application/json', body: 'null', bodyWasJson: true,
            rpcErrorCode: 'MACHINE_RPC_INVALID_RESPONSE', schemaIssues: [{ code: 'invalid_type', path: [] }] },
        { status: 200, contentType: 'application/json', body: JSON.stringify({
            v: 2, ok: true, receipt: PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded,
            requestId: 'request_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS, routeKind: 'loopback_direct',
            result: { secret: 'private-body' }, commandReceipt: {
                v: 1, issuer: 'daemon', issuedAtMs: 2000, requestHash: `sha256:${'a'.repeat(64)}`,
                replayKey: 'request_1', resultHash: 'private-body',
            },
        }), bodyWasJson: true, rpcErrorCode: 'MACHINE_RPC_INVALID_RESPONSE',
            schemaIssues: [{ code: 'invalid_format', path: ['commandReceipt', 'resultHash'] }] },
        { status: 502, contentType: 'text/html', body: '<html>Bad Gateway: private-body</html>',
            bodyWasJson: false, rpcErrorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN, schemaIssues: [] },
        { status: 504, contentType: 'application/json', body: '{"error":"private-body"}',
            bodyWasJson: true, rpcErrorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN, schemaIssues: [] },
    ])('retains safe direct-response diagnostics for HTTP $status / $contentType / JSON $bodyWasJson', async (vector) => {
        // HTTP is the boundary: exercise the real decoder and strict consumer.
        vi.stubGlobal('fetch', vi.fn(async () => new Response(vector.body, {
            status: vector.status, headers: { 'content-type': vector.contentType },
        })));
        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;
        const error: unknown = await module.postProductionMachineRpcDirect({
            url: 'http://127.0.0.1:46021/peer-mediation/v2/rpc', request: createDirectRequest(),
        }).catch((failure: unknown) => failure);

        expect(error).toBeInstanceOf(RpcError);
        expect(error).toMatchObject({
            rpcErrorCode: vector.rpcErrorCode, httpStatus: vector.status, contentType: vector.contentType,
            bodyWasJson: vector.bodyWasJson, schemaIssues: vector.schemaIssues,
        });
        expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
        // Neither arbitrary response data nor schema prose belongs in diagnostics.
        expect(JSON.stringify(error)).not.toContain('private-body');
        expect(String(error)).not.toContain('private-body');
    });

    it('accepts the canonical direct response even without a content-type header', async () => {
        const payload = {
            v: 2, ok: true, receipt: PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded,
            requestId: 'request_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS, routeKind: 'loopback_direct',
            result: { ready: true },
        };
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new TextEncoder().encode(JSON.stringify(payload)))));
        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;
        await expect(module.postProductionMachineRpcDirect({
            url: 'http://127.0.0.1:46021/peer-mediation/v2/rpc', request: createDirectRequest(),
        })).resolves.toEqual(payload);
    });

    it('preserves a direct body transport failure instead of treating it as malformed JSON', async () => {
        const failure = new TypeError('Connection terminated');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
            start(controller) { controller.error(failure); },
        }), { headers: { 'content-type': 'application/json' } })));
        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;
        const error: unknown = await module.postProductionMachineRpcDirect({
            url: 'http://127.0.0.1:46021/peer-mediation/v2/rpc', request: createDirectRequest(),
        }).catch((cause: unknown) => cause);

        expect(error).toBe(failure);
        expect(error).toMatchObject({ httpStatus: 200, contentType: 'application/json', bodyWasJson: false });
        expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
    });

    it('aborts the direct loopback request when its timeout elapses', async () => {
        vi.useFakeTimers();
        try {
            let capturedSignal: AbortSignal | undefined;
            vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) => (
                new Promise<Response>((_resolve, reject) => {
                    capturedSignal = init?.signal ?? undefined;
                    capturedSignal?.addEventListener('abort', () => {
                        reject(Object.assign(new Error('timed out'), { name: 'AbortError' }));
                    }, { once: true });
                })
            )));

            const module = await importProductionRoute();
            expect(module).toHaveProperty('postProductionMachineRpcDirect');
            if ('importError' in module) throw module.importError;

            const resultPromise = module.postProductionMachineRpcDirect({
                url: 'http://127.0.0.1:46021/peer-mediation/v1/machine-rpc',
                request: createDirectRequest(),
                timeoutMs: 5,
            }).catch((error: unknown) => error);
            await vi.advanceTimersByTimeAsync(5);

            expect(capturedSignal?.aborted).toBe(true);
            expect(readRpcRequestDisposition(await resultPromise)).toBe('outcomeUnknown');
        } finally {
            vi.useRealTimers();
        }
    });
});
