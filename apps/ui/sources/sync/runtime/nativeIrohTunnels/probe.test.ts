import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeIrohHomeTunnelOrigin } from './probe';
import type { IrohHomeTunnelRequest } from './types';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const HOME_IDENTITY = 'srv_home_probe_a';

function createRequest(overrides: Partial<IrohHomeTunnelRequest> = {}): IrohHomeTunnelRequest {
    return {
        remoteHostId: 'profile-a',
        purpose: 'home',
        homeServerIdentityId: HOME_IDENTITY,
        endpointId: 'endpoint-a',
        canonicalServerUrl: 'https://probe-home.example.test',
        policy: 'automatic',
        verification: { kind: 'authenticated', token: 'token-a' },
        ...overrides,
    };
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('Iroh Home tunnel origin probe', () => {
    afterEach(() => {
        resetRuntimeFetch();
        vi.restoreAllMocks();
    });

    it('verifies authenticated readiness, then features identity through the lease origin', async () => {
        const requests: Array<{ url: string; authorization: string | null }> = [];
        setRuntimeFetch(async (input, init) => {
            const url = String(input);
            const authorization = new Headers(init?.headers).get('Authorization');
            requests.push({ url, authorization });
            if (url === 'http://127.0.0.1:45701/health') return jsonResponse(200, { ok: true });
            if (url === 'http://127.0.0.1:45701/v1/auth/ping') return jsonResponse(200, { ok: true });
            // The features proof must be carried by the lease's exact runtime origin.
            if (url === 'http://127.0.0.1:45701/v1/features') {
                return jsonResponse(200, { features: {}, capabilities: { serverIdentity: { serverIdentityId: HOME_IDENTITY } } });
            }
            throw new Error(`unexpected probe request ${url}`);
        });

        await expect(probeIrohHomeTunnelOrigin('http://127.0.0.1:45701', createRequest())).resolves.toEqual({ ok: true });

        expect(requests.map((request) => request.url)).toEqual([
            'http://127.0.0.1:45701/v1/auth/ping',
            'http://127.0.0.1:45701/v1/features',
        ]);
        expect(requests[0]?.authorization).toBe('Bearer token-a');
        expect(requests[1]?.authorization).toBeNull();
    });

    it('verifies a pre-token enrollment origin with health and Home identity but no authenticated ping', async () => {
        const requests: string[] = [];
        setRuntimeFetch(async (input) => {
            const url = String(input);
            requests.push(url);
            if (url === 'http://127.0.0.1:45707/health') return jsonResponse(200, { ok: true });
            if (url === 'http://127.0.0.1:45707/v1/features') {
                return jsonResponse(200, { features: {}, capabilities: { serverIdentity: { serverIdentityId: HOME_IDENTITY } } });
            }
            throw new Error(`unexpected probe request ${url}`);
        });

        await expect(probeIrohHomeTunnelOrigin(
            'http://127.0.0.1:45707',
            createRequest({ verification: { kind: 'enrollment' } }),
        )).resolves.toEqual({ ok: true });

        expect(requests).toEqual([
            'http://127.0.0.1:45707/health',
            'http://127.0.0.1:45707/v1/features',
        ]);
    });

    it('fails closed without any request when an authenticated token or expected identity is missing', async () => {
        const runtimeFetch = vi.fn(async () => jsonResponse(200, {}));
        setRuntimeFetch(runtimeFetch);

        await expect(probeIrohHomeTunnelOrigin('http://127.0.0.1:45702', createRequest({
            verification: { kind: 'authenticated', token: '   ' },
        })))
            .resolves.toEqual({ ok: false, reason: 'auth-failed' });
        await expect(probeIrohHomeTunnelOrigin('http://127.0.0.1:45702', createRequest({ homeServerIdentityId: '  ' })))
            .resolves.toEqual({ ok: false, reason: 'auth-failed' });

        expect(runtimeFetch).not.toHaveBeenCalled();
    });

    it('maps a rejected authenticated ping to an auth failure and skips the features proof', async () => {
        const requests: string[] = [];
        setRuntimeFetch(async (input) => {
            const url = String(input);
            requests.push(url);
            if (url.endsWith('/health')) return jsonResponse(200, { ok: true });
            if (url.endsWith('/v1/auth/ping')) return jsonResponse(401, { error: 'expired' });
            throw new Error(`unexpected probe request ${url}`);
        });

        await expect(probeIrohHomeTunnelOrigin('http://127.0.0.1:45703', createRequest()))
            .resolves.toEqual({ ok: false, reason: 'auth-failed' });
        expect(requests).toEqual([
            'http://127.0.0.1:45703/v1/auth/ping',
        ]);
    });

    it('maps an unreachable or overloaded health endpoint to a health failure', async () => {
        setRuntimeFetch(async () => jsonResponse(503, { error: 'overloaded' }));

        await expect(probeIrohHomeTunnelOrigin('http://127.0.0.1:45704', createRequest()))
            .resolves.toEqual({ ok: false, reason: 'health-unavailable' });
    });

    it('fails on a Home identity mismatch reported at the features endpoint', async () => {
        setRuntimeFetch(async (input) => {
            const url = String(input);
            if (url.endsWith('/health')) return jsonResponse(200, { ok: true });
            if (url.endsWith('/v1/auth/ping')) return jsonResponse(200, { ok: true });
            if (url === 'http://127.0.0.1:45705/v1/features') {
                return jsonResponse(200, { features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_home_other' } } });
            }
            throw new Error(`unexpected probe request ${url}`);
        });

        await expect(probeIrohHomeTunnelOrigin('http://127.0.0.1:45705', createRequest()))
            .resolves.toEqual({ ok: false, reason: 'identity-mismatch' });
    });

    it('fails when the features endpoint cannot prove the Home at all', async () => {
        setRuntimeFetch(async (input) => {
            const url = String(input);
            if (url.endsWith('/health')) return jsonResponse(200, { ok: true });
            if (url.endsWith('/v1/auth/ping')) return jsonResponse(200, { ok: true });
            if (url === 'http://127.0.0.1:45706/v1/features') return jsonResponse(500, {});
            throw new Error(`unexpected probe request ${url}`);
        });

        await expect(probeIrohHomeTunnelOrigin('http://127.0.0.1:45706', createRequest()))
            .resolves.toEqual({ ok: false, reason: 'features-unavailable' });
    });
});
