import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeGovernanceProjectionV1Schema, NO_HOME_CAPABILITIES_V1 } from '@happier-dev/protocol/home/governance';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';

const runtimeFetchMock = vi.hoisted(() => vi.fn());
const releaseTransport = vi.hoisted(() => vi.fn(async () => undefined));
const resolveContext = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: runtimeFetchMock,
}));

/**
 * The one seam this file replaces is the scoped-transport resolver: it owns
 * credentials, carrier selection and the Iroh lease, which are the real network
 * and identity boundaries. Everything below it — request composition, body
 * buffering, lease custody and the Home family's own classification — runs for
 * real, which is what these tests are about.
 */
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext', () => ({
    resolveServerAccountRequestContext: resolveContext,
}));

import { requestHomeDomain } from './homeServerActionTransport';

function projection() {
    return {
        viewer: { accountId: 'account-a', homeRole: 'owner', status: 'active' },
        capabilities: { ...NO_HOME_CAPABILITIES_V1, viewAdministration: true },
        policy: { revision: 1, teamCreationPolicy: 'managed_only', authentication: { status: 'inherited' } },
        authenticationOptions: {
            methods: [],
            permittedAccountModes: ['e2ee'],
            recommendedProvisioningMode: 'e2ee',
            signInService: { deploymentMode: null, canDisable: false },
        },
        setupState: 'owned',
        activeOwnerCount: 1,
        teamsEnabled: true,
    };
}

function scopedContext(overrides: Record<string, unknown> = {}) {
    return {
        scope: 'scoped' as const,
        timeoutMs: 5_000,
        targetServerId: 'server-a',
        targetServerUrl: 'https://server-a.example',
        targetAccountId: 'account-a',
        token: 'token-a',
        encryption: null,
        release: releaseTransport,
        ...overrides,
    };
}

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;

function governanceRequest(signal?: AbortSignal) {
    return requestHomeDomain({
        scope,
        path: '/v1/home/governance/get',
        effect: 'read',
        input: {},
        schema: HomeGovernanceProjectionV1Schema,
        ...(signal ? { signal } : {}),
    });
}

beforeEach(() => {
    runtimeFetchMock.mockReset();
    releaseTransport.mockClear();
    resolveContext.mockReset();
});

describe('Home family transport composition', () => {
    it('travels the native Iroh runtime origin the scoped transport resolved', async () => {
        resolveContext.mockResolvedValue(scopedContext({
            runtimeOrigin: 'http://127.0.0.1:49152',
            carrier: 'iroh',
        }));
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify(projection()), { status: 200 }));

        await expect(governanceRequest()).resolves.toEqual({ ok: true, value: projection() });

        const call = runtimeFetchMock.mock.calls[0]?.[0];
        // Identity and audience stay the canonical Home URL; only the reachable
        // origin is the resolved Iroh one.
        expect(call?.serverUrl).toBe('https://server-a.example');
        expect(call?.url).toBe('http://127.0.0.1:49152/v1/home/governance/get');
    });

    it('travels a browser Iroh Home through the canonical HTTP owner carrying its carrier', async () => {
        const carrierFetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(projection()), { status: 200 }));
        const homeCarrier = {
            endpointId: 'home-endpoint', readObservedPath: () => 'relay',
            request: carrierFetch, createWebSocket: () => null,
        } satisfies HomeCarrier;
        resolveContext.mockResolvedValue(scopedContext({ homeCarrier }));

        await expect(governanceRequest()).resolves.toEqual({ ok: true, value: projection() });

        // A Home that owns its bytes has no origin a URL fetch can reach, so the
        // carrier — not the reachability fetch — must carry the request.
        expect(carrierFetch).toHaveBeenCalledWith('https://server-a.example/v1/home/governance/get',
            expect.objectContaining({ method: 'POST', body: '{}' }));
        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it('releases the scoped lease after the answer is read, on success and on refusal alike', async () => {
        resolveContext.mockResolvedValue(scopedContext({ carrier: 'iroh' }));
        runtimeFetchMock.mockResolvedValueOnce(new Response(JSON.stringify(projection()), { status: 200 }));
        await expect(governanceRequest()).resolves.toMatchObject({ ok: true });
        expect(releaseTransport).toHaveBeenCalledTimes(1);

        resolveContext.mockResolvedValue(scopedContext({ carrier: 'iroh' }));
        runtimeFetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ error: 'home_governance_forbidden' }), { status: 403 }),
        );
        await expect(governanceRequest()).resolves.toMatchObject({ ok: false });
        expect(releaseTransport).toHaveBeenCalledTimes(2);
    });

    it('lets a caller\'s cancellation surface as cancellation and still releases the lease', async () => {
        resolveContext.mockResolvedValue(scopedContext({ carrier: 'iroh' }));
        const controller = new AbortController();
        runtimeFetchMock.mockImplementation(async () => {
            controller.abort();
            const aborted = new Error('aborted');
            aborted.name = 'AbortError';
            throw aborted;
        });

        // Cancellation is the caller's own supersession, not a Home failure: it
        // must not be reported as an unreachable Home the caller would retry.
        await expect(governanceRequest(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(releaseTransport).toHaveBeenCalledTimes(1);
    });
});
