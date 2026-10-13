import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
installDisconnectedServerSocketBoundary();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

await loadSyncSingletonForTests();
const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { storage } = await import('@/sync/domains/state/storage');
const { Switch } = await import('@/components/ui/forms/Switch');
const { AccountMemoryDefaultsSection } = await import('./AccountMemoryDefaultsSection');

const originalState = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(originalState, true); });

describe('Account memory creation defaults admission', () => {
    it('persists the admitted creation default without replacing neighboring Account preferences', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        try {
            const screen = await renderScreen(<AccountMemoryDefaultsSection />);
            const sessions = screen.findAllByType(Switch).find(node => node.props.testID === 'context.memoryDefaults.sessions.switch');
            if (!sessions) throw new Error('Sessions default missing');
            act(() => account.replaceSettings(settingsParse({ ...storage.getState().settings, memoryUseInNewBots: false })));
            await act(async () => sessions.props.onValueChange(true));
            await vi.waitFor(() => expect(account.persistedSettings).toMatchObject({ memoryUseInNewSessions: true, memoryUseInNewBots: false }));
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('keeps all creation defaults unchanged when their declared settings Action is disabled', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: {
            v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } },
        } }) });
        try {
            const screen = await renderScreen(<AccountMemoryDefaultsSection />);
            for (const control of screen.findAllByType(Switch)) {
                await act(async () => control.props.onValueChange(!control.props.value));
            }
            expect(storage.getState().settings).toMatchObject({ memoryUseInNewSessions: false, memoryUseInNewBots: true, memoryUpkeepInNewBots: true });
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
});
