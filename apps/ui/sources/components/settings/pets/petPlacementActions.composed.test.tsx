/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { getCurrentAuth, setCurrentAuth } from '@/auth/context/currentAuth';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ segments: [] }).module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// The desktop shell and its native commands are OS boundaries; placement and Settings stay real.
const nativeInvoke = vi.fn<(command: string, args?: Readonly<Record<string, unknown>>) => Promise<unknown>>();
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
const { CommandPaletteProvider } = await import('@/components/appShell/commandPalette/CommandPaletteProvider');
const { executeCommandPaletteAction } = await import('@/components/appShell/commandPalette/commandPaletteActionRuntime');
const originalState = storage.getState();
const originalAuth = getCurrentAuth();
afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); setCurrentAuth(originalAuth); storage.setState(originalState, true); nativeInvoke.mockClear(); });

describe('pet desktop placement through real Settings Action composition', () => {
    it.each(['settings', 'palette'] as const)('admits the %s reset under Off, Ask and Allowed and keeps visibility', async surface => {
        nativeInvoke.mockImplementation(createDesktopSecureStorageBoundary().invoke);
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: nativeInvoke });
        const account = await createSecretSettingsTestHarness({
            features: createRootLayoutFeaturesResponse({ features: { pets: { companion: { enabled: true } } } }),
            settings: settingsParse({ experiments: true, featureToggles: { 'pets.companion': true },
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
            }),
        });
        const customPlacement = { desktopOverlayPlacementMode: 'custom' as const, desktopOverlayAnchor: 'bottom_left' as const,
            desktopOverlayOffsetX: 80, desktopOverlayOffsetY: 60, desktopOverlayEnabled: false };
        storage.getState().applyLocalSettings(customPlacement);
        try {
            const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}>
                {surface === 'settings' ? <PetsSettingsScreen /> : <CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>}
            </InjectedAuthProvider>);
            const reset = () => surface === 'settings'
                ? screen.tree.findAll(node => node.props.testID === 'settings-pets-desktop-overlay-reset-position'
                    && typeof node.props.onPress === 'function')[0]!.props.onPress()
                : executeCommandPaletteAction({ actionId: 'ui.command_palette.invoke', input: { commandId: 'pet-reset-position' }, context: { surface: 'ui' } });
            await act(async () => { await reset(); });
            expect(storage.getState().localSettings).toMatchObject(customPlacement);
            expect(nativeInvoke.mock.calls.filter(([command]) => command === 'desktop_activity_overlay_reset_position')).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
            })); });
            await act(async () => { void reset(); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(storage.getState().localSettings).toMatchObject(customPlacement);
            expect(nativeInvoke.mock.calls.filter(([command]) => command === 'desktop_activity_overlay_reset_position')).toEqual([]);
            expect(await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'approve')).toMatchObject({ ok: true });
            await vi.waitFor(() => {
                const artifact = account.artifacts.list()[0]!;
                const request = StoredApprovalRequestSchema.parse(JSON.parse(account.artifacts.readPlainBody(artifact.id)!));
                expect({ status: request.status, errorCode: request.execution?.errorCode })
                    .toEqual({ status: 'executed', errorCode: undefined });
            });
            await vi.waitFor(() => expect(storage.getState().localSettings).toMatchObject({
                desktopOverlayPlacementMode: 'anchored', desktopOverlayAnchor: 'top_center',
                desktopOverlayOffsetX: 0, desktopOverlayOffsetY: 0, desktopOverlayEnabled: false,
            }));
            expect(nativeInvoke.mock.calls.map(([command]) => command)).toContain('desktop_activity_overlay_reset_position');
            await act(async () => {
                storage.getState().applyLocalSettings(customPlacement);
                account.replaceSettings(settingsParse({ ...account.persistedSettings,
                    actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
                }));
            });
            nativeInvoke.mockClear();
            await act(async () => { await reset(); });
            await vi.waitFor(() => expect(storage.getState().localSettings).toMatchObject({
                desktopOverlayPlacementMode: 'anchored', desktopOverlayAnchor: 'top_center',
                desktopOverlayOffsetX: 0, desktopOverlayOffsetY: 0, desktopOverlayEnabled: false,
            }));
            expect(nativeInvoke.mock.calls.map(([command]) => command)).toContain('desktop_activity_overlay_reset_position');
            expect(account.artifacts.list()).toHaveLength(1);
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
});
