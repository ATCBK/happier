import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@/text';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import {
    clearPendingExternalConnectMock,
    flushOAuthEffects,
    localSearchParamsMock,
    loginWithCredentialsSpy,
    modal,
    replaceSpy,
    resetOAuthHarness,
    runWithOAuthScreen,
    setAuthState,
    setPendingExternalConnectState,
    setStoredCredentialsState,
} from './test/oauthReturnHarness';

type FetchResult = {
    ok: boolean;
    status?: number;
    body: unknown;
};

const OAUTH_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

function setAuthenticated() {
    setAuthState({
        isAuthenticated: true,
        credentials: { token: 't', secret: OAUTH_SECRET },
    });
}

function stubFetch(
    handler: (url: string, init?: RequestInit) => Promise<FetchResult>,
): ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>> {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/health')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ ok: true }),
            } as Response;
        }
        if (url.endsWith('/v1/auth/ping')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ ok: true }),
            } as Response;
        }
        const result = await handler(url, init);
        return {
            ok: result.ok,
            status: result.status ?? (result.ok ? 200 : 500),
            json: async () => result.body,
        } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    setRuntimeFetch(fetchMock as unknown as typeof fetch);
    return fetchMock;
}

vi.mock('@/utils/timing/time', async () => {
    const actual = await vi.importActual<typeof import('@/utils/timing/time')>('@/utils/timing/time');
    return {
        ...actual,
        backoff: async (callback: () => Promise<unknown>) => await callback(),
    };
});

vi.mock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
    return {
        ...actual,
        waitForServerReachable: async () => {},
    };
});

afterEach(() => {
    resetOAuthHarness();
    resetRuntimeFetch();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('/oauth/[provider] (connect flow)', () => {
    it('clears failed connect custody and returns to its saved destination', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        clearPendingExternalConnectMock.mockClear();
        setPendingExternalConnectState({ provider: 'github', returnTo: '/friends' });

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            error: 'oauth_not_configured',
        });

        const alertSpy = vi.spyOn(modal, 'alert').mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(clearPendingExternalConnectMock).toHaveBeenCalledTimes(1);
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
        });

        alertSpy.mockRestore();
    });

    it('shows a friendly message for oauth_not_configured', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        setPendingExternalConnectState(null);

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            error: 'oauth_not_configured',
        });

        const alertSpy = vi.spyOn(modal, 'alert').mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(alertSpy).toHaveBeenCalledWith(
                t('common.error'),
                t('friends.providerGate.notConfigured', { provider: 'GitHub' }),
            );
            expect(replaceSpy).toHaveBeenCalledWith('/settings/account');
        });

        alertSpy.mockRestore();
    });

    it('never presents an untrusted provider callback error verbatim', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            error: '<script>provider detail</script>',
        });
        const alertSpy = vi.spyOn(modal, 'alert').mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(alertSpy).toHaveBeenCalledWith(t('common.error'), t('errors.operationFailed'));
            expect(JSON.stringify(alertSpy.mock.calls)).not.toContain('provider detail');
        });

        alertSpy.mockRestore();
    });

    it('cancels pending connect when user closes the username prompt', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        setPendingExternalConnectState(null);

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'username_required',
            login: 'octocat',
            pending: 'p1',
        });

        const fetchMock = stubFetch(async (url, init) => {
            if (url.includes('/v1/connect/external/github/pending/')) {
                expect(init?.method).toBe('DELETE');
                return { ok: true, body: { success: true } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const promptSpy = vi.spyOn(modal, 'prompt').mockResolvedValue(null);
        const alertSpy = vi.spyOn(modal, 'alert').mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(promptSpy).toHaveBeenCalled();
            expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v1/connect/external/github/pending/'), expect.anything());
            expect(replaceSpy).toHaveBeenCalledWith('/settings/account');
        });

        promptSpy.mockRestore();
        alertSpy.mockRestore();
    });

    it('navigates away even if cancel pending throws', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        setPendingExternalConnectState(null);

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'username_required',
            login: 'octocat',
            pending: 'p1',
        });

        stubFetch(async () => {
            throw new Error('network');
        });

        const promptSpy = vi.spyOn(modal, 'prompt').mockResolvedValue(null);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(promptSpy).toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/settings/account');
        });

        promptSpy.mockRestore();
    });

    it('finalizes normal connect and adopts the replacement credential', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        loginWithCredentialsSpy.mockClear();
        setPendingExternalConnectState({ provider: 'github', returnTo: '/friends' });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'connected',
            pending: 'p-normal',
            username: 'account-owner',
        });
        const fetchMock = stubFetch(async (url, init) => {
            if (url.endsWith('/v1/connect/external/github/finalize')) {
                expect(JSON.parse(String(init?.body))).toEqual({
                    pending: 'p-normal',
                    username: 'account-owner',
                });
                return { ok: true, body: { success: true, token: 'replacement-token' } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock).toHaveBeenCalled();
            expect(loginWithCredentialsSpy).toHaveBeenCalledWith({
                token: 'replacement-token',
                secret: OAUTH_SECRET,
            });
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
        });
    });

    it('preserves predecessor callback completion without a pending finalizer handle', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        loginWithCredentialsSpy.mockClear();
        setPendingExternalConnectState({ provider: 'github', returnTo: '/friends' });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'connected',
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
        });
    });

    it('clears normal connect continuation after a typed finalization error', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        setPendingExternalConnectState({ provider: 'github', returnTo: '/friends' });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'connected',
            pending: 'p-normal',
            username: 'account-owner',
        });
        stubFetch(async () => ({
            ok: false,
            status: 400,
            body: { error: 'invalid-pending' },
        }));
        const alertSpy = vi.spyOn(modal, 'alert').mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(alertSpy).toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
        });
    });

    it('finalizes connect when the user picks an available username', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        setPendingExternalConnectState({ provider: 'github', returnTo: '/friends' });

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'username_required',
            login: 'octocat',
            pending: 'p1',
        });

        const fetchMock = stubFetch(async (url, init) => {
            if (url.endsWith('/v1/connect/external/github/finalize')) {
                expect(init?.method).toBe('POST');
                const body = JSON.parse(String(init?.body ?? '{}'));
                expect(body).toEqual({ pending: 'p1', username: 'octocat_2' });
                return { ok: true, body: { success: true, token: 'replacement-token' } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const promptSpy = vi.spyOn(modal, 'prompt').mockResolvedValue('octocat_2');
        const alertSpy = vi.spyOn(modal, 'alert').mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(promptSpy).toHaveBeenCalled();
            expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v1/connect/external/github/finalize'), expect.anything());
            expect(loginWithCredentialsSpy).toHaveBeenCalledWith({ token: 'replacement-token', secret: OAUTH_SECRET });
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
        });

        promptSpy.mockRestore();
        alertSpy.mockRestore();
    });

    it('keeps predecessor connect completion usable when no replacement credential is returned', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        loginWithCredentialsSpy.mockClear();
        setPendingExternalConnectState({ provider: 'github', returnTo: '/friends' });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'username_required',
            login: 'octocat',
            pending: 'p1',
        });
        stubFetch(async (url) => {
            if (url.endsWith('/v1/connect/external/github/finalize')) {
                return { ok: true, body: { success: true } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        const promptSpy = vi.spyOn(modal, 'prompt').mockResolvedValue('octocat_2');

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
        });

        promptSpy.mockRestore();
    });

    it('re-prompts when the chosen username is taken', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        setPendingExternalConnectState({ provider: 'github', returnTo: '/friends' });

        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'username_required',
            login: 'octocat',
            pending: 'p1',
        });

        const fetchMock = stubFetch(async (url) => {
            if (url.endsWith('/v1/connect/external/github/finalize')) {
                const callCount = fetchMock.mock.calls.filter((call) =>
                    String(call[0]).endsWith('/v1/connect/external/github/finalize'),
                ).length;
                if (callCount === 1) {
                    return {
                        ok: false,
                        status: 409,
                        body: { error: 'username-taken' },
                    };
                }
                return { ok: true, body: { success: true, token: 'replacement-token' } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const promptSpy = vi
            .spyOn(modal, 'prompt')
            .mockResolvedValueOnce('octocat')
            .mockResolvedValueOnce('octocat_2');
        const alertSpy = vi.spyOn(modal, 'alert').mockImplementation(async () => {});

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects(10);
            expect(promptSpy).toHaveBeenCalledTimes(2);
            expect(replaceSpy).toHaveBeenCalledWith('/friends');
            expect(alertSpy).not.toHaveBeenCalled();
        });

        promptSpy.mockRestore();
        alertSpy.mockRestore();
    });
    it('finalizes a Team connect on the exact Home that started it while another Home stays focused', async () => {
        // Home A is focused (its credential is the in-memory auth state); the Team
        // connect was started with the saved credential of Home B (TA-R14/TA-R16).
        setAuthenticated();
        replaceSpy.mockReset();
        loginWithCredentialsSpy.mockClear();
        setStoredCredentialsState({ token: 'home-b-token' });
        setPendingExternalConnectState({
            provider: 'github',
            returnTo: '/teams/team-1/sign-in?target=home-b',
            serverId: 'server-b',
            serverUrl: 'https://home-b.example.test',
        });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'connected',
            pending: 'p-team',
            username: 'member',
        });
        const fetchMock = stubFetch(async (url, init) => {
            if (url === 'https://home-b.example.test/v1/connect/external/github/finalize') {
                expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer home-b-token');
                return { ok: true, body: { success: true, token: 'home-b-replacement' } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(fetchMock).toHaveBeenCalledWith(
                'https://home-b.example.test/v1/connect/external/github/finalize',
                expect.anything(),
            );
            // The replacement is persisted for Home B without focusing it or touching A.
            expect(loginWithCredentialsSpy).toHaveBeenCalledWith(
                { token: 'home-b-replacement' },
                { target: { serverUrl: 'https://home-b.example.test', serverId: 'server-b' } },
            );
            expect(replaceSpy).toHaveBeenCalledWith('/teams/team-1/sign-in?target=home-b');
        });
    });

    it('presents a typed Team refusal from the exact Home instead of a generic failure', async () => {
        setAuthenticated();
        replaceSpy.mockReset();
        loginWithCredentialsSpy.mockClear();
        setStoredCredentialsState({ token: 'home-b-token' });
        setPendingExternalConnectState({
            provider: 'github',
            returnTo: '/teams/team-1/sign-in?target=home-b',
            serverId: 'server-b',
            serverUrl: 'https://home-b.example.test',
        });
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'connect',
            status: 'connected',
            pending: 'p-team',
            username: 'member',
        });
        stubFetch(async (url) => {
            if (url === 'https://home-b.example.test/v1/connect/external/github/finalize') {
                return { ok: false, status: 403, body: { error: 'team_authentication_required' } };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        const alertSpy = vi.spyOn(modal, 'alert').mockImplementation(async () => {});

        await runWithOAuthScreen(async (screen) => {
            await flushOAuthEffects();
            expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
            expect(alertSpy).not.toHaveBeenCalled();
            expect(JSON.stringify(screen.toJSON())).toContain(t('teams.entry.notProvisionedTitle'));
        });
        alertSpy.mockRestore();
    });
});
