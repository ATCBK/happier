import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { registerNativeThemePreferenceTransitionController } from '@/components/settings/appearance/themePreferenceTransition';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { Modal } from '@/modal';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const boundary = vi.hoisted(() => ({ setTheme: vi.fn(), setStatusBarStyle: vi.fn() }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default },
        Appearance: { getColorScheme: () => 'light' } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ runtime: { setTheme: boundary.setTheme } });
});
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: boundary.setStatusBarStyle }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { usePersonalizeFlow } = await import('./usePersonalizeFlow');
let ACCOUNT_A = { serverId: '', accountId: 'alice' };
let ACCOUNT_B = { serverId: '', accountId: 'bob' };
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

beforeEach(async () => {
    await homes.reset();
    await homes.addHome({ name: 'Personalize Home', serverUrl: 'https://personalize-flow.test',
        accountId: ACCOUNT_A.accountId, currentAccount: true });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://personalize-flow.test',
        accountId: ACCOUNT_A.accountId,
        credentials: { token: createAccountTokenForTests(ACCOUNT_A.accountId, { currentAccount: true }) }, request: homes.request });
    ACCOUNT_A = { serverId: connection.serverId, accountId: 'alice' };
    ACCOUNT_B = { serverId: connection.serverId, accountId: 'bob' };
    storage.setState({ settings: settingsDefaults, settingsScope: ACCOUNT_A, profileScope: ACCOUNT_A,
        localSettings: { ...localSettingsDefaults, themePreference: 'light' } });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    boundary.setTheme.mockClear();
    boundary.setStatusBarStyle.mockClear();
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    vi.restoreAllMocks();
});

describe('Personalize mounted visit', () => {
    it('keeps the live visit usable after Strict Mode replays mount effects', async () => {
        const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }), {
            wrapper: React.StrictMode,
        });
        await act(async () => { hook.getCurrent().selectTheme('dark'); });
        expect(hook.getCurrent().draft.theme).toBe('dark');
        expect(storage.getState().localSettings.themePreference).toBe('light');
        await act(async () => { expect(await hook.getCurrent().next()).toBe(true); });
        expect(hook.getCurrent().page).toBe('style');
    });

    it.each(['conversation', 'summary'] as const)('retires %s on Account switch before any Next or completion write', async initialPage => {
        const onExit = vi.fn();
        const hook = await renderHook(() => usePersonalizeFlow({ initialPage, onExit }));
        await act(async () => { hook.getCurrent().update({ thinking: 'hidden' }); });
        const held = hook.getCurrent();
        await act(async () => { storage.setState({ settingsScope: ACCOUNT_B, settings: { ...settingsDefaults, sessionListDensity: 'cozy' } }); });
        expect(onExit).toHaveBeenCalledTimes(1);
        const accountB = storage.getState().settings;
        const localB = storage.getState().localSettings;
        await act(async () => { expect(await held.next()).toBe(false); expect(await hook.getCurrent().next()).toBe(false); });
        expect(storage.getState().settings).toBe(accountB);
        expect(storage.getState().localSettings).toBe(localB);
    });

    it('previews a tile without persistence, and Skip restores the saved theme', async () => {
        const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }));
        await act(async () => { hook.getCurrent().selectTheme('dark'); });
        expect(boundary.setTheme).toHaveBeenLastCalledWith('dark');
        expect(storage.getState().localSettings.themePreference).toBe('light');
        await act(async () => { hook.getCurrent().skip(); });
        expect(hook.getCurrent().draft.theme).toBe('light');
        expect(storage.getState().localSettings.themePreference).toBe('light');
        expect(boundary.setTheme).toHaveBeenLastCalledWith('light');
        expect(hook.getCurrent().page).toBe('style');
    });

    it('leaving an unconfirmed Look restores the saved runtime theme', async () => {
        const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }));
        await act(async () => { hook.getCurrent().selectTheme('dark'); });
        await hook.unmount();
        expect(storage.getState().localSettings.themePreference).toBe('light');
        expect(boundary.setTheme).toHaveBeenLastCalledWith('light');
    });

    it('awaits the theme commit before advancing or recording progress', async () => {
        let commit!: () => void;
        const unregister = registerNativeThemePreferenceTransitionController({ run: mutation => new Promise<void>(resolve => {
            commit = () => { mutation(); resolve(); };
        }) });
        try {
            const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }));
            await act(async () => { hook.getCurrent().selectTheme('dark'); });
            let pending: Promise<boolean> | boolean;
            await act(async () => { pending = hook.getCurrent().next(); });
            expect(hook.getCurrent().page).toBe('look');
            expect(storage.getState().localSettings.personalizeProgressV1.savedSteps).toEqual([]);
            await act(async () => { commit(); expect(await pending).toBe(true); });
            expect(hook.getCurrent().page).toBe('style');
            expect(storage.getState().localSettings.themePreference).toBe('dark');
            expect(storage.getState().localSettings.personalizeProgressV1.savedSteps).toEqual(['look']);
        } finally { unregister(); }
    });

    it('keeps the draft and step on a storage rejection, then retries through the theme owner', async () => {
        const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }));
        await act(async () => { hook.getCurrent().selectTheme('dark'); });
        vi.mocked(Modal.alert).mockClear();
        // The native device persistence adapter is a genuine system boundary; all store/flow/theme logic stays real.
        const deviceStorage = getPersistenceStorage();
        const write = deviceStorage.set.bind(deviceStorage);
        let refusedThemeWrite = false;
        const persist = vi.spyOn(deviceStorage, 'set').mockImplementation((key, value) => {
            if (!refusedThemeWrite && key === 'local-settings' && typeof value === 'string') {
                const next: unknown = JSON.parse(value);
                if (next && typeof next === 'object' && 'themePreference' in next && next.themePreference === 'dark') {
                    refusedThemeWrite = true;
                    throw new Error('device storage refused');
                }
            }
            write(key, value);
        });
        await act(async () => { expect(await hook.getCurrent().next()).toBe(false); });
        expect(refusedThemeWrite).toBe(true);
        expect(Modal.alert).toHaveBeenCalledOnce();
        expect(hook.getCurrent()).toMatchObject({ page: 'look', draft: { theme: 'dark' } });
        expect(storage.getState().localSettings.themePreference).toBe('light');
        expect(storage.getState().localSettings.personalizeProgressV1.savedSteps).toEqual([]);
        persist.mockRestore();
        await act(async () => { expect(await hook.getCurrent().next()).toBe(true); });
        expect(hook.getCurrent().page).toBe('style');
        expect(storage.getState().localSettings.themePreference).toBe('dark');
        expect(storage.getState().localSettings.personalizeProgressV1.savedSteps).toEqual(['look']);
    });

    it('rejects a theme mutation delayed until after its launching Account retires', async () => {
        let commit!: () => void;
        const unregister = registerNativeThemePreferenceTransitionController({ run: mutation => new Promise<void>((resolve, reject) => {
            commit = () => { try { mutation(); resolve(); } catch (error) { reject(error); } };
        }) });
        try {
            const onExit = vi.fn();
            const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit }));
            await act(async () => { hook.getCurrent().selectTheme('dark'); });
            let pending: Promise<boolean> | boolean;
            await act(async () => { pending = hook.getCurrent().next(); });
            await act(async () => { storage.setState({ settingsScope: ACCOUNT_B }); });
            const localB = storage.getState().localSettings;
            await act(async () => { commit(); expect(await pending).toBe(false); });
            expect(onExit).toHaveBeenCalledTimes(1);
            expect(storage.getState().localSettings).toBe(localB);
        } finally { unregister(); }
    });
});
