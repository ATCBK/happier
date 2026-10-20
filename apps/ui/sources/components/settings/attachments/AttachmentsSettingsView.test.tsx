import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { renderSettingsView } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const originalState = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(originalState, true); });

// Load the real screen after transport installation, outside the interaction deadline.
const { AttachmentsSettingsView } = await import('./AttachmentsSettingsView');
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('AttachmentsSettingsView inline fields', () => {
    it('keeps drafts valid and admits directory and existing size controls only when Allowed', async () => {
        const baseline = settingsParse({ experiments: true, featureToggles: { 'attachments.uploads': true },
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } });
        const account = await createSecretSettingsTestHarness({ settings: baseline });
        try {
            const screen = await renderSettingsView(<AttachmentsSettingsView />);
            const directory = 'settings-attachments-uploads-directory-input';
            const bytes = 'settings-attachments-max-size-input';
            await vi.waitFor(() => expect(screen.findByTestId(directory)).toBeTruthy());
            act(() => screen.changeTextByTestId(directory, '../outside'));
            act(() => screen.findByTestId(directory)!.props.onBlur());
            expect(screen.findByTestId(`${directory}.error`)).toBeTruthy();
            expect(account.settingsWrites).toEqual([]);
            act(() => screen.changeTextByTestId(directory, ' folder\\uploads '));
            await act(async () => { screen.findByTestId(directory)!.props.onSubmitEditing(); });
            act(() => screen.changeTextByTestId(bytes, '4096'));
            await act(async () => { screen.findByTestId(bytes)!.props.onSubmitEditing(); });
            expect(account.settingsWrites).toEqual([]);
            expect(account.persistedSettings.attachmentsUploadsWorkspaceRelativeDir).toBe(baseline.attachmentsUploadsWorkspaceRelativeDir);
            expect(account.persistedSettings.attachmentsUploadsMaxFileBytes).toBe(baseline.attachmentsUploadsMaxFileBytes);
            await act(async () => { account.replaceSettings(settingsParse({ ...baseline,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            act(() => screen.changeTextByTestId(directory, ' allowed\\uploads '));
            await act(async () => { screen.findByTestId(directory)!.props.onSubmitEditing(); });
            await vi.waitFor(() => expect(account.persistedSettings.attachmentsUploadsWorkspaceRelativeDir).toBe('allowed/uploads'));
            act(() => screen.changeTextByTestId(bytes, '1'));
            act(() => screen.findByTestId(bytes)!.props.onBlur());
            expect(screen.findByTestId(`${bytes}.error`)).toBeTruthy();
            expect(account.persistedSettings.attachmentsUploadsMaxFileBytes).toBe(baseline.attachmentsUploadsMaxFileBytes);
            act(() => screen.changeTextByTestId(bytes, ' 8192 '));
            await act(async () => { screen.findByTestId(bytes)!.props.onSubmitEditing(); });
            await vi.waitFor(() => expect(account.persistedSettings.attachmentsUploadsMaxFileBytes).toBe(8192));
            expect(account.persistedSettings.attachmentsUploadsWorkspaceRelativeDir).toBe('allowed/uploads');
        } finally { standardCleanup(); await account.dispose(); }
    });
});
