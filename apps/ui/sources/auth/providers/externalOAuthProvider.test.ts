import { afterEach, describe, expect, it, vi } from 'vitest';

import { HappyError } from '@/utils/errors/errors';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetEndpointSupervisorPoolForTests } from '@/sync/runtime/connectivity/endpointSupervisorPool';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { createExternalOAuthProvider } from './externalOAuthProvider';
import type { ExternalOAuthEndpointRequest } from './types';

function jsonResponse(params: { ok: boolean; status: number; body: unknown }): Response {
    return Response.json(params.body, { status: params.status });
}

function stubFetch(
    handler: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; body: unknown }>,
) {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
            return jsonResponse({ ok: true, status: 200, body: { ok: true } });
        }
        const result = await handler(url, init);
        return jsonResponse(result);
    });
    setRuntimeFetch(fetchMock);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function createProvider() {
    return createExternalOAuthProvider({
        id: 'github',
        displayName: 'GitHub',
    });
}

afterEach(async () => {
    await resetEndpointSupervisorPoolForTests();
    await resetServerReachabilitySupervisors();
    resetRuntimeFetch();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('createExternalOAuthProvider', () => {
    it('targets an injected Account Directory endpoint and requests the restricted purpose', async () => {
        const requestAtEndpoint = vi.fn<ExternalOAuthEndpointRequest>(async () => jsonResponse({
            ok: true,
            status: 200,
            body: {
                url: 'https://oauth.example.test/directory',
                purpose: 'account_directory',
                credentialTarget: 'account_directory',
                endpointUrl: 'https://directory.example.test',
                endpointServerIdentityId: 'directory-1',
                canonicalServerUrl: 'https://directory.example.test',
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
        }) as Response);

        const provider = createProvider();
        await expect(provider.getExternalAuthUrl(
            { mode: 'keyless', proofHash: 'abc123' },
            {
                request: requestAtEndpoint,
                purpose: 'account_directory',
                endpointUrl: 'https://directory.example.test',
                endpointServerIdentityId: 'directory-1',
                canonicalServerUrl: 'https://directory.example.test',
            },
        )).resolves.toEqual(expect.objectContaining({
            url: 'https://oauth.example.test/directory',
            purpose: 'account_directory',
        }));
        expect(requestAtEndpoint).toHaveBeenCalledWith(
            expect.stringContaining('/v1/auth/external/github/params?'),
            undefined,
            { includeAuth: false, retry: 'none' },
        );
        expect(requestAtEndpoint.mock.calls[0]?.[0]).toContain('purpose=account_directory');
        expect(requestAtEndpoint.mock.calls[0]?.[0]).toContain(
            'endpointUrl=https%3A%2F%2Fdirectory.example.test',
        );
        expect(requestAtEndpoint.mock.calls[0]?.[0]).toContain(
            'endpointServerIdentityId=directory-1',
        );
        expect(requestAtEndpoint.mock.calls[0]?.[0]).toContain(
            'canonicalServerUrl=https%3A%2F%2Fdirectory.example.test',
        );
    });

    it('emits the canonical keyed query only for explicit Account Directory context', async () => {
        const requestAtEndpoint = vi.fn<ExternalOAuthEndpointRequest>(async () => jsonResponse({
            ok: true,
            status: 200,
            body: {
                url: 'https://oauth.example.test/directory',
                purpose: 'account_directory',
                credentialTarget: 'account_directory',
                endpointUrl: 'https://directory.example.test',
                endpointServerIdentityId: 'directory-1',
                canonicalServerUrl: 'https://directory.example.test',
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
        }) as Response);
        const provider = createProvider();

        await provider.getExternalAuthUrl(
            { mode: 'keyed', publicKey: 'pk1' },
            {
                request: requestAtEndpoint,
                purpose: 'account_directory',
                endpointUrl: 'https://directory.example.test',
                endpointServerIdentityId: 'directory-1',
                canonicalServerUrl: 'https://directory.example.test',
            },
        );

        expect(requestAtEndpoint.mock.calls[0]?.[0]).toContain('mode=keyed');
        expect(requestAtEndpoint.mock.calls[0]?.[0]).toContain('publicKey=pk1');
    });

    it('rejects Account Directory params that do not bind the requested endpoint identity', async () => {
        const requestAtEndpoint = vi.fn<ExternalOAuthEndpointRequest>(async () => jsonResponse({
            ok: true,
            status: 200,
            body: {
                url: 'https://oauth.example.test/directory',
                purpose: 'account_directory',
                credentialTarget: 'account_directory',
                endpointUrl: 'https://directory.example.test',
                endpointServerIdentityId: 'directory-tampered',
                canonicalServerUrl: 'https://directory.example.test',
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
        }) as Response);
        const provider = createProvider();

        await expect(provider.getExternalAuthUrl(
            { mode: 'keyless', proofHash: 'abc123' },
            {
                request: requestAtEndpoint,
                purpose: 'account_directory',
                endpointUrl: 'https://directory.example.test',
                endpointServerIdentityId: 'directory-1',
                canonicalServerUrl: 'https://directory.example.test',
            },
        )).rejects.toThrow('external-auth-unavailable');
    });

    it.each([
        { name: 'missing', canonicalServerUrl: undefined },
        { name: 'changed', canonicalServerUrl: 'https://other-directory.example.test' },
    ])('rejects Account Directory params with a $name canonical server URL binding', async ({ canonicalServerUrl }) => {
        const requestAtEndpoint = vi.fn<ExternalOAuthEndpointRequest>(async () => jsonResponse({
            ok: true,
            status: 200,
            body: {
                url: 'https://oauth.example.test/directory',
                purpose: 'account_directory',
                credentialTarget: 'account_directory',
                endpointUrl: 'https://directory.example.test',
                endpointServerIdentityId: 'directory-1',
                ...(canonicalServerUrl ? { canonicalServerUrl } : {}),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
        }) as Response);
        const provider = createProvider();

        await expect(provider.getExternalAuthUrl(
            { mode: 'keyless', proofHash: 'abc123' },
            {
                request: requestAtEndpoint,
                purpose: 'account_directory',
                endpointUrl: 'https://directory.example.test',
                endpointServerIdentityId: 'directory-1',
                canonicalServerUrl: 'https://directory.example.test',
            },
        )).rejects.toThrow('external-auth-unavailable');
    });

    it('returns the external auth URL when params endpoint is successful', async () => {
        stubFetch(async () => ({
            ok: true,
            status: 200,
            body: { url: 'https://oauth.example.test/signup' },
        }));

        const provider = createProvider();
        await expect(provider.getExternalAuthUrl({ mode: 'keyless', proofHash: 'abc123' })).resolves.toBe(
            'https://oauth.example.test/signup',
        );
    });

    it('includes the proofHash query param when building the params request', async () => {
        let capturedUrl: string | null = null;
        stubFetch(async (url) => {
            capturedUrl = url;
            return {
                ok: true,
                status: 200,
                body: { url: 'https://oauth.example.test/login' },
            };
        });

        const provider = createProvider();
        await expect(provider.getExternalAuthUrl({ mode: 'keyless', proofHash: 'abc123' })).resolves.toBe(
            'https://oauth.example.test/login',
        );
        expect(capturedUrl).toContain('/v1/auth/external/github/params');
        expect(capturedUrl).toContain('mode=keyless');
        expect(capturedUrl).toContain('proofHash=abc123');
    });

    it('keeps the invitation bearer out of the URL and accepts only the server-minted Team admission reference', async () => {
        let capturedUrl: string | null = null;
        let capturedInit: RequestInit | undefined;
        stubFetch(async (url, init) => {
            capturedUrl = url;
            capturedInit = init;
            return {
                ok: true,
                status: 200,
                body: {
                    url: 'https://oauth.example.test/team',
                    purpose: 'team_admission',
                    teamId: 'team-1',
                    admissionReference: 'oauth-attempt-1',
                },
            };
        });

        const provider = createProvider();
        const requestAtEndpoint = vi.fn<ExternalOAuthEndpointRequest>(async (path, init) =>
            await fetch(path, init),
        );
        await expect(provider.getExternalAuthUrl(
            { mode: 'keyless', proofHash: 'abc123' },
            {
                request: requestAtEndpoint,
                purpose: 'team_admission',
                teamId: 'team-1',
                origin: 'team',
                invitationToken: 'invitation-secret',
                target: { serverId: 'server-1', serverUrl: 'https://api.example.test' },
            },
        )).resolves.toEqual({
            url: 'https://oauth.example.test/team',
            purpose: 'team_admission',
            teamId: 'team-1',
            admissionReference: 'oauth-attempt-1',
        });
        expect(capturedUrl).toContain('purpose=team_admission');
        expect(capturedUrl).toContain('teamId=team-1');
        expect(capturedUrl).not.toContain('admission=');
        expect(capturedUrl).not.toContain('invitation-secret');
        expect(capturedInit?.headers).toEqual({
            'x-happier-team-invitation': 'invitation-secret',
        });
    });

    it('rejects a Team OAuth response whose exact Team binding changed', async () => {
        stubFetch(async () => ({
            ok: true,
            status: 200,
            body: {
                url: 'https://oauth.example.test/team',
                purpose: 'team_admission',
                teamId: 'team-other',
                admissionReference: 'oauth-attempt-1',
            },
        }));

        const provider = createProvider();
        const requestAtEndpoint = vi.fn<ExternalOAuthEndpointRequest>(async (path, init) =>
            await fetch(path, init),
        );
        await expect(provider.getExternalAuthUrl(
            { mode: 'keyless', proofHash: 'abc123' },
            {
                request: requestAtEndpoint,
                purpose: 'team_admission',
                teamId: 'team-1',
                origin: 'team',
                target: { serverId: 'server-1', serverUrl: 'https://api.example.test' },
            },
        )).rejects.toThrow('external-auth-unavailable');
    });

    it('includes the publicKey query param when building keyed params requests', async () => {
        let capturedUrl: string | null = null;
        stubFetch(async (url) => {
            capturedUrl = url;
            return {
                ok: true,
                status: 200,
                body: { url: 'https://oauth.example.test/login' },
            };
        });

        const provider = createProvider();
        await expect(provider.getExternalAuthUrl({ mode: 'keyed', publicKey: 'pk1' })).resolves.toBe(
            'https://oauth.example.test/login',
        );
        expect(capturedUrl).toContain('/v1/auth/external/github/params');
        expect(capturedUrl).toContain('publicKey=pk1');
        expect(capturedUrl).not.toContain('mode=keyed');
    });

    it('includes the proofHash query param when building keyed params requests with proofHash', async () => {
        let capturedUrl: string | null = null;
        stubFetch(async (url) => {
            capturedUrl = url;
            return {
                ok: true,
                status: 200,
                body: { url: 'https://oauth.example.test/login' },
            };
        });

        const provider = createProvider();
        await expect(provider.getExternalAuthUrl({ mode: 'keyed', proofHash: 'abc123', publicKey: 'pk1' })).resolves.toBe(
            'https://oauth.example.test/login',
        );
        expect(capturedUrl).toContain('/v1/auth/external/github/params');
        expect(capturedUrl).toContain('proofHash=abc123');
        expect(capturedUrl).toContain('publicKey=pk1');
        expect(capturedUrl).not.toContain('mode=keyed');
        expect(capturedUrl).not.toContain('mode=keyless');
    });

    it('throws config HappyError when external OAuth is not configured', async () => {
        stubFetch(async () => ({
            ok: false,
            status: 400,
            body: { error: 'oauth_not_configured' },
        }));

        const provider = createProvider();
        await expect(provider.getExternalAuthUrl({ mode: 'keyless', proofHash: 'abc123' })).rejects.toEqual(
            expect.objectContaining({
                name: 'HappyError',
                kind: 'config',
                status: 400,
                canTryAgain: false,
            } satisfies Partial<HappyError>),
        );
    });

    it('throws for successful auth response payloads missing a URL', async () => {
        stubFetch(async () => ({ ok: true, status: 200, body: { url: '' } }));

        const provider = createProvider();
        await expect(provider.getExternalAuthUrl({ mode: 'keyless', proofHash: 'abc123' })).rejects.toThrow(
            'external-auth-unavailable',
        );
    });

    it('requests authenticated credential adoption for connect callbacks', async () => {
        const fetchMock = stubFetch(async () => ({
            ok: true,
            status: 200,
            body: { url: 'https://oauth.example.test/connect' },
        }));

        await expect(createProvider().getConnectUrl({ token: 't', secret: 's' })).resolves.toBe(
            'https://oauth.example.test/connect',
        );
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('connectFinalization=credential_adoption_v1'),
            expect.anything(),
        );
    });

    it('maps connect params 400 failures into config HappyError payloads', async () => {
        stubFetch(async () => ({
            ok: false,
            status: 400,
            body: { error: 'provider_disabled' },
        }));

        const provider = createProvider();
        await expect(provider.getConnectUrl({ token: 't', secret: 's' })).rejects.toEqual(
            expect.objectContaining({
                name: 'HappyError',
                kind: 'config',
                status: 400,
                message: 'provider_disabled',
            } satisfies Partial<HappyError>),
        );
    });

    it('maps connect params 401 failures into auth HappyError payloads', async () => {
        stubFetch(async () => ({
            ok: false,
            status: 401,
            body: { error: 'unauthorized' },
        }));

        const provider = createProvider();
        await expect(provider.getConnectUrl({ token: 't', secret: 's' })).rejects.toEqual(
            expect.objectContaining({
                name: 'HappyError',
                kind: 'auth',
                status: 401,
                message: 'unauthorized',
            } satisfies Partial<HappyError>),
        );
    });

    it.each([
        { status: 409, error: 'username-taken', expectedMessage: 'username-taken' },
        { status: 409, error: 'provider-already-linked', expectedMessage: 'provider-already-linked' },
        { status: 400, error: 'invalid-username', expectedMessage: 'invalid-username' },
    ])(
        'maps finalize failures to HappyError for status=$status error=$error',
        async ({ status, error, expectedMessage }) => {
            stubFetch(async () => ({
                ok: false,
                status,
                body: { error },
            }));

            const provider = createProvider();
            await expect(
                provider.finalizeConnect({ token: 't', secret: 's' }, { pending: 'pending-1', username: 'octocat' }),
            ).rejects.toEqual(
                expect.objectContaining({
                    name: 'HappyError',
                    kind: 'auth',
                    status,
                    message: expectedMessage,
                } satisfies Partial<HappyError>),
            );
        },
    );

    it.each([
        { label: 'empty replacement token', body: { success: true, token: '' } },
        { label: 'blank replacement token', body: { success: true, token: '   ' } },
    ])('rejects successful finalize responses with incomplete credential material ($label)', async ({ body }) => {
        stubFetch(async () => ({ ok: true, status: 200, body }));

        const provider = createProvider();
        await expect(
            provider.finalizeConnect({ token: 't', secret: 's' }, { pending: 'pending-1', username: 'octocat' }),
        ).rejects.toThrow('Failed to finalize');
    });

    it.each([
        { status: 404, error: 'not-connected', kind: 'config' as const },
        { status: 403, error: 'forbidden', kind: 'auth' as const },
    ])('maps disconnect status=$status failures into HappyError kind=$kind', async ({ status, error, kind }) => {
        stubFetch(async () => ({
            ok: false,
            status,
            body: { error },
        }));

        const provider = createProvider();
        await expect(provider.disconnect({ token: 't', secret: 's' })).rejects.toEqual(
            expect.objectContaining({
                name: 'HappyError',
                kind,
                status,
                message: error,
            } satisfies Partial<HappyError>),
        );
    });
});
