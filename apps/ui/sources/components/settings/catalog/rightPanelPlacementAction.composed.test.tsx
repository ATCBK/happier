import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { storage } from '@/sync/domains/state/storage';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const originalState = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(originalState, true); });

describe('right panel position Action (calm-shell R4-2)', () => {
    it('is a device layout preference an agent reads and sets without approval, canvas by default', async () => {
        expect(localSettingsDefaults.rightPanelPlacement).toBe('canvas');
        const account = await createSecretSettingsTestHarness({});
        try {
            const executor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => null });
            const context = { surface: 'agent', serverId: account.scope.serverId, authority: 'account_automation', actionCaller: { kind: 'host' } } as const;
            await act(async () => {
                expect(await executor.execute('settings.get', { anchor: 'appearance.rightPanelPlacement' }, context))
                    .toMatchObject({ ok: true, result: expect.objectContaining({ value: 'canvas' }) });
            });
            await act(async () => {
                const result = await executor.execute('settings.set', { anchor: 'appearance.rightPanelPlacement', value: 'sheet' }, context);
                expect(result).toMatchObject({ ok: true });
            });
            expect(storage.getState().localSettings.rightPanelPlacement).toBe('sheet');
            await act(async () => {
                expect(await executor.execute('settings.set', { anchor: 'appearance.rightPanelPlacement', value: 'floating' }, context)).toMatchObject({ ok: false });
            });
            expect(storage.getState().localSettings.rightPanelPlacement).toBe('sheet');
            await act(async () => {
                expect(await executor.execute('settings.set', { anchor: 'appearance.rightPanelPlacement', value: 'canvas' }, context)).toMatchObject({ ok: true });
            });
            expect(storage.getState().localSettings.rightPanelPlacement).toBe('canvas');
            // A personal layout choice: no approval request was raised, no Account setting written.
            expect(account.artifacts.list()).toEqual([]);
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
});
