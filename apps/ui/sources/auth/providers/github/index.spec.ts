import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetEndpointSupervisorPoolForTests } from '@/sync/runtime/connectivity/endpointSupervisorPool';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
        const provider = typeof params?.provider === 'string' ? params.provider : '';
        return provider ? `${key}:${provider}` : key;
    },
    });
});

import { githubAuthProvider } from './index';

const credentials: AuthCredentials = { token: 'token', secret: 'secret' };

function stubFetch(body: unknown) {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => {
        return Response.json(body);
    });
    setRuntimeFetch(fetchMock);
    vi.stubGlobal('fetch', fetchMock);
}

afterEach(async () => {
    await resetEndpointSupervisorPoolForTests();
    await resetServerReachabilitySupervisors();
    resetRuntimeFetch();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('githubAuthProvider', () => {
    it('exposes expected static provider metadata', () => {
        expect(githubAuthProvider.id).toBe('github');
        expect(githubAuthProvider.displayName).toBe('GitHub');
        // The badge is a glyph the app ships, so every surface that marks GitHub can draw it.
        expect(githubAuthProvider.badgeIconName).toBe('github-logo');
        expect(githubAuthProvider.supportsProfileBadge).toBe(true);
        expect(githubAuthProvider.connectButtonColor).toBe('#24292e');
    });

    it('provides a restore notice for provider_already_linked redirects', () => {
        expect(githubAuthProvider.getRestoreRedirectNotice?.({ reason: 'provider_already_linked' })).toEqual({
            title: 'connect.externalAuthVerifiedTitle:GitHub',
            body: 'connect.externalAuthVerifiedBody:GitHub',
        });
    });

    it.each([
        { label: 'string payload', body: { success: 'yes' } },
        { label: 'numeric payload', body: { success: 1 } },
        { label: 'missing success field', body: {} },
    ])('finalizeConnect throws when response success is not true ($label)', async ({ body }) => {
        stubFetch(body);

        await expect(
            githubAuthProvider.finalizeConnect(credentials, { pending: 'pending-1', username: 'octocat' }),
        ).rejects.toThrow('Failed to finalize GitHub connection');
    });

    it('finalizeConnect resolves when response success is true', async () => {
        stubFetch({ success: true, token: 'replacement-token' });

        await expect(
            githubAuthProvider.finalizeConnect(credentials, { pending: 'pending-1', username: 'octocat' }),
        ).resolves.toEqual({ token: 'replacement-token' });
    });

    it('keeps predecessor connect success usable when no replacement token is returned', async () => {
        stubFetch({ success: true });

        await expect(
            githubAuthProvider.finalizeConnect(credentials, { pending: 'pending-1', username: 'octocat' }),
        ).resolves.toEqual({});
    });

    it.each([
        { label: 'string payload', body: { success: 'yes' } },
        { label: 'numeric payload', body: { success: 1 } },
        { label: 'missing success field', body: {} },
    ])('disconnect throws when response success is not true ($label)', async ({ body }) => {
        stubFetch(body);

        await expect(githubAuthProvider.disconnect(credentials)).rejects.toThrow(
            'Failed to disconnect GitHub account',
        );
    });

    it('disconnect resolves when response success is true', async () => {
        stubFetch({ success: true });

        await expect(githubAuthProvider.disconnect(credentials)).resolves.toBeUndefined();
    });
});
