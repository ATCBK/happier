import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ATTENTION_DELIVERY_POLICY_V1 } from '@happier-dev/protocol';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getStorage } from '@/sync/domains/state/storage';
import { DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1 } from '@/sync/domains/settings/attentionDeviceOverridesV1';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { useRemoteAlertRegistrationStatus } from './useRemoteAlertRegistrationStatus';

const nativeCapabilitiesState = vi.hoisted(() => ({
    current: { v: 1, platform: 'ios', events: ['ready'] } as const as unknown,
}));
const readExpoPushTokenSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, token: 'ExponentPushToken[test]' })));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
let restoredAccount: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
async function restoreRemoteAlertHome(serverUrl: string, accountId: string, version: number) {
    restoredAccount = await restoreServerAccountForTest({ serverUrl, accountId,
        request: async (raw, init) => {
            const path = new URL(String(raw)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return accountSettingsResponse(init, version);
            return null;
        },
    });
    return restoredAccount.home;
}
function accountSettingsResponse(init: RequestInit | undefined, version: number) {
    if (init?.method === 'POST') {
        const input = JSON.parse(String(init.body)) as { expectedVersion: number };
        return Response.json({ success: true, version: input.expectedVersion + 1 });
    }
    return Response.json({ content: { t: 'plain', v: {} }, version });
}

vi.mock('../../../../modules/happier-activity-notifications', () => ({
    readActivityNotificationCapabilities: () => nativeCapabilitiesState.current,
}));

vi.mock('@/activity/notifications/permission/pushNotificationAccess', () => ({
    readExpoPushToken: () => readExpoPushTokenSpy(),
}));

afterEach(async () => {
    standardCleanup();
    await restoredAccount?.dispose();
    restoredAccount = undefined;
    nativeCapabilitiesState.current = { v: 1, platform: 'ios', events: ['ready'] };
    readExpoPushTokenSpy.mockClear();
    vi.restoreAllMocks();
    resetRuntimeFetch();
});

describe('remote alert registration status', () => {
    it('reads only the captured Home and rejects an old unmarked response', async () => {
        const home = await restoreRemoteAlertHome('https://remote-alert-status.example', 'account-a', 7);
        const scope = { serverId: home.id, accountId: 'account-a' };
        getStorage().getState().activateProfileScope(scope);
        getStorage().setState({ settingsScope: scope, settingsVersion: 7 });
        // Secure credential storage and HTTP are external boundaries. Scope, request and parsing stay real.
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: `e30.${Buffer.from(JSON.stringify({ sub: scope.accountId })).toString('base64url')}.signature`,
        });
        let marked = true;
        const hosts: string[] = [];
        setRuntimeFetch(async (url, init) => {
            const target = new URL(url instanceof Request ? url.url : String(url));
            hosts.push(target.host);
            if (target.pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
            if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (target.pathname === '/v2/account/settings') return accountSettingsResponse(init, 7);
            if (target.pathname !== '/v1/push-tokens') return new Response(null, { status: 404 });
            return new Response(JSON.stringify(marked ? {
                v: 2, accountRemoteAlerts: { settingsVersion: 7, status: 'stale' }, tokens: [],
            } : { tokens: [] }), { status: 200 });
        });
        const hook = await renderHook(() => useRemoteAlertRegistrationStatus({
            enabled: true,
            serverId: home.id,
            accountEnabled: true,
            policy: DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
            deviceEnabled: true,
            deviceOverrides: DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().registration.accountPolicy).toBe('stale'));
        expect(hook.getCurrent().registration.accountPolicy).toBe('stale');
        expect(hook.getCurrent().registration.supported).toBe(true);
        expect(hook.getCurrent().registration.deviceEnrollment).toBe('enrolling');
        expect(new Set(hosts)).toEqual(new Set(['remote-alert-status.example']));
        marked = false;
        await act(async () => { hook.getCurrent().refresh(); await new Promise((resolve) => setTimeout(resolve, 0)); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().registration).toMatchObject({
            accountPolicy: 'unavailable', supported: false, refreshing: false,
        }));
        expect(hook.getCurrent().registration.accountPolicy).toBe('unavailable');
        expect(hook.getCurrent().registration.supported).toBe(false);
        await hook.unmount();
    });

    it('does not probe enrollment while Session Follow is disabled', async () => {
        const runtimeFetch = vi.fn(async () => new Response('{}', { status: 200 }));
        setRuntimeFetch(runtimeFetch);
        const hook = await renderHook(() => useRemoteAlertRegistrationStatus({
            enabled: false,
            serverId: 'home-disabled',
            accountEnabled: true,
            policy: DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
            deviceEnabled: true,
            deviceOverrides: DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
        }));
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
        expect(hook.getCurrent().registration).toMatchObject({
            accountPolicy: 'unavailable', supported: false, deviceEnrollment: 'unavailable', refreshing: false,
        });
        expect(runtimeFetch).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('re-probes native capability on Refresh so a mounted screen can become enrollable', async () => {
        const home = await restoreRemoteAlertHome('https://remote-alert-refresh.example', 'account-refresh', 8);
        const scope = { serverId: home.id, accountId: 'account-refresh' };
        getStorage().getState().activateProfileScope(scope);
        getStorage().setState({ settingsScope: scope, settingsVersion: 8 });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: `e30.${Buffer.from(JSON.stringify({ sub: scope.accountId })).toString('base64url')}.signature`,
        });
        setRuntimeFetch(async (url, init) => {
            const target = new URL(url instanceof Request ? url.url : String(url));
            if (target.pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
            if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (target.pathname === '/v2/account/settings') return accountSettingsResponse(init, 8);
            if (target.pathname !== '/v1/push-tokens') return new Response(null, { status: 404 });
            return Response.json({
                v: 2,
                accountRemoteAlerts: { settingsVersion: 8, status: 'current' },
                tokens: [],
            });
        });
        nativeCapabilitiesState.current = null;
        const hook = await renderHook(() => useRemoteAlertRegistrationStatus({
            enabled: true,
            serverId: home.id,
            accountEnabled: true,
            policy: DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
            deviceEnabled: true,
            deviceOverrides: DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().registration).toMatchObject({
            accountPolicy: 'current', supported: true, refreshing: false,
        }));
        expect(hook.getCurrent().registration.nativeAvailable).toBe(false);
        expect(hook.getCurrent().registration.deviceEnrollment).toBe('unavailable');

        nativeCapabilitiesState.current = { v: 1, platform: 'ios', events: ['ready'] };
        await act(async () => {
            hook.getCurrent().refresh();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        await waitForHomeGovernance(() => expect(hook.getCurrent().registration).toMatchObject({
            nativeAvailable: true, deviceEnrollment: 'enrolling', refreshing: false,
        }));
        expect(hook.getCurrent().registration.nativeAvailable).toBe(true);
        expect(hook.getCurrent().registration.deviceEnrollment).toBe('enrolling');
        expect(readExpoPushTokenSpy).toHaveBeenCalled();
        await hook.unmount();
    });

    it('re-probes after the asynchronous Home projection resolves', async () => {
        const home = await restoreRemoteAlertHome('https://remote-alert-prepared.example', 'account-prepared', 9);
        const scope = { serverId: home.id, accountId: 'account-prepared' };
        getStorage().getState().activateProfileScope(scope);
        getStorage().setState({ settingsScope: scope, settingsVersion: 9 });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: `e30.${Buffer.from(JSON.stringify({ sub: scope.accountId })).toString('base64url')}.signature`,
        });
        let resolveProjection: ((response: Response) => void) | null = null;
        const projectionRequested = new Promise<void>((resolve) => {
            setRuntimeFetch(async (url, init) => {
                const target = new URL(url instanceof Request ? url.url : String(url));
                if (target.pathname === '/v1/auth/ping' || target.pathname === '/health') {
                    return Response.json({});
                }
                if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (target.pathname === '/v2/account/settings') return accountSettingsResponse(init, 9);
                if (target.pathname !== '/v1/push-tokens' || target.searchParams.get('projectionVersion') !== '2') {
                    return new Response(null, { status: 404 });
                }
                resolve();
                return await new Promise<Response>((resolveResponse) => { resolveProjection = resolveResponse; });
            });
        });
        nativeCapabilitiesState.current = null;
        const hook = await renderHook(() => useRemoteAlertRegistrationStatus({
            enabled: true,
            serverId: home.id,
            accountEnabled: true,
            policy: DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
            deviceEnabled: true,
            deviceOverrides: DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
        }));
        await projectionRequested;
        expect(hook.getCurrent().registration.nativeAvailable).toBe(false);

        nativeCapabilitiesState.current = { v: 1, platform: 'ios', events: ['ready'] };
        await act(async () => {
            resolveProjection?.(Response.json({
                v: 2,
                accountRemoteAlerts: { settingsVersion: 9, status: 'current' },
                tokens: [],
            }));
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        await waitForHomeGovernance(() => expect(hook.getCurrent().registration).toMatchObject({
            supported: true, nativeAvailable: true, deviceEnrollment: 'enrolling', refreshing: false,
        }));
        expect(hook.getCurrent().registration.nativeAvailable).toBe(true);
        expect(hook.getCurrent().registration.deviceEnrollment).toBe('enrolling');
        expect(readExpoPushTokenSpy).toHaveBeenCalled();
        await hook.unmount();
    });
});
