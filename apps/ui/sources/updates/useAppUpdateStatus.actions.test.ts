import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { AppUpdateActionOutputSchemas, AppUpdateStatusResultSchema } from '@happier-dev/protocol/actions/appUpdateActionFamily';
import { createRootLayoutFeaturesResponse, renderHook } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { useAppUpdateStatus } from './useAppUpdateStatus';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { installLocalStorageMock, type LocalStorageMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';

vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness'))
    .createSocketIoClientBoundary(importOriginal));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// This journey accepts the app update confirmation through the human-input boundary.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal'))
    .createModalModuleMock({ confirmResult: true }).module);
// Tauri IPC/events and Expo's native SDK are genuine platform boundaries. No updater is mocked.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('expo-updates', () => ({
    useUpdates: () => ({ currentlyRunning: { isEmbeddedLaunch: true }, isChecking: false,
        isDownloading: false, isRestarting: false, isUpdateAvailable: false, isUpdatePending: false }),
    checkForUpdateAsync: () => { throw new Error('Unexpected native OTA check in desktop renderer'); },
    fetchUpdateAsync: () => { throw new Error('Unexpected native OTA fetch in desktop renderer'); },
    reloadAsync: () => { throw new Error('Unexpected native OTA restart in desktop renderer'); },
}));
// Session-envelope HTTP/process work is unrelated to this app-update journey.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Unexpected Session-envelope API call'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let browserStorage: LocalStorageMockHandle | undefined;
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'app-account', encryptionMode: 'plain' });
afterEach(async () => { await connection?.dispose(); connection = undefined; artifacts.clear(); browserStorage?.restore(); browserStorage = undefined; vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('executes desktop skip, check, update, retry and restart through the mounted canonical app owner', async () => {
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_DESKTOP_UPDATES_ENABLED', '1');
    vi.stubGlobal('__DEV__', false);
    let offeredVersion = '1.2.0';
    let downloads = 0;
    const secureStorage = createDesktopSecureStorageBoundary();
    const invoke = vi.fn(async (command: string, args?: Readonly<Record<string, unknown>>) => {
        if (command.startsWith('desktop_secure_storage_')) return await secureStorage.invoke(command, args);
        if (command === 'desktop_fetch_update') return { version: offeredVersion, currentVersion: '1.0.0', downloaded: false };
        if (command === 'desktop_download_update') {
            downloads += 1;
            if (downloads === 1) throw new Error('test-only download failure');
            return true;
        }
        if (command === 'desktop_install_update') return true;
        throw new Error(`Unexpected platform command: ${command}`);
    });
    const internals = { invoke };
    vi.stubGlobal('__TAURI_INTERNALS__', internals);
    vi.stubGlobal('window', { __TAURI_INTERNALS__: internals, addEventListener: () => {}, removeEventListener: () => {} });
    browserStorage = installLocalStorageMock();
    const saved = browserStorage.store;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(createRootLayoutFeaturesResponse({
        features: { updates: { ota: { enabled: false } } },
    }))));
    connection = await restoreServerAccountForTest({ serverUrl: 'https://app-updates-actions.test',
        serverIdentityId: 'srv_app_updates_actions', accountId: 'app-account', request: async (input, init) => {
            const url = new URL(String(input));
            const fromArtifacts = artifacts.handle(`${url.pathname}${url.search}`, init);
            if (fromArtifacts) return await fromArtifacts;
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
            return null;
        } });
    const execute = createFrontDoorActionExecute();
    const executor = { execute };
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
        serverId: connection.home.id, expectedAccountId: 'app-account' };
    const executeUpdate = async (actionId: 'app.updates.update' | 'app.updates.retry' | 'app.updates.restart') => {
        expect(await execute(actionId, {}, context)).toEqual({ ok: true, result: { status: 'requested' } });
    };
    const hook = await renderHook(() => useAppUpdateStatus());
    await act(async () => { await vi.waitFor(() => expect(hook.getCurrent().model.item.state).toBe('available')); });
    const current = await executor.execute('app.updates.get', {}, context);
    if (!current.ok) throw new Error(current.errorCode);
    expect(AppUpdateStatusResultSchema.parse(current.result)).toMatchObject({
        channel: 'desktop', latestVersion: '1.2.0', canSkip: true,
    });
    expect(await executor.execute('app.updates.skip', { version: 'different' }, context)).toMatchObject({ ok: false, errorCode: 'app_update_unavailable' });
    expect(saved.size).toBe(0);
    await act(async () => { expect(await executor.execute('app.updates.skip', { version: '1.2.0' }, context))
        .toEqual({ ok: true, result: { status: 'requested' } }); });
    expect(hook.getCurrent().model.item.skipped).toBe(true);
    expect(saved.get('desktop_update_dismissed_version')).toBe('1.2.0');
    offeredVersion = '1.3.0';
    await act(async () => {
        const checked = await executor.execute('app.updates.check', {}, context);
        if (!checked.ok) throw new Error(checked.errorCode);
        expect(AppUpdateActionOutputSchemas['app.updates.check'].parse(checked.result)).toEqual({ status: 'requested' });
    });
    expect(hook.getCurrent().model.item).toMatchObject({ latestVersion: '1.3.0', skipped: false });
    await act(async () => {
        await executeUpdate('app.updates.update');
    });
    expect(await executor.execute('app.updates.get', {}, context)).toMatchObject({ ok: true, result: { state: 'failed', action: 'retry' } });
    await act(async () => { await executeUpdate('app.updates.retry'); });
    expect(downloads).toBe(2);
    expect(hook.getCurrent().model.item.state).toBe('ready');
    expect(invoke.mock.calls.some(([command]) => command === 'desktop_install_update')).toBe(false);
    await act(async () => { await executeUpdate('app.updates.restart'); });
    expect(hook.getCurrent().model.item.state).toBe('running');
    expect(invoke.mock.calls.filter(([command]) => command === 'desktop_install_update')).toHaveLength(1);
    await hook.unmount();
    expect(await executor.execute('app.updates.get', {}, context)).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
});
