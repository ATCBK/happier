import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
const account = createProviderSettingsAccountHarness();
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

// Load the real owner after boundaries during collection, outside behavior deadlines.
await import('./NewSessionWizardSettingsView');

describe('NewSessionWizardSettingsView', () => {
    beforeEach(async () => { await account.restore({ settings: { newSessionWizardSectionPresentationV1: { models: 'dropdown' }, newSessionWizardColumnsEnabled: false } }); });
    afterEach(async () => { standardCleanup(); await account.reset(); });
    it('renders every wizard selection section and updates one section without dropping the others', async () => {
        const { NewSessionWizardSettingsView } = await import('./NewSessionWizardSettingsView');
        const screen = await renderSettingsView(React.createElement(NewSessionWizardSettingsView));

        const steps = screen.findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('settings-new-session-wizard-')
            && Array.isArray(node.props.options));
        expect(steps.map((step) => [step.props.testID, step.props.title, step.props.value])).toEqual([
            ['settings-new-session-wizard-profiles', 'Profile', 'auto'],
            ['settings-new-session-wizard-backends', 'Agent', 'auto'],
            ['settings-new-session-wizard-models', 'Model', 'dropdown'],
            ['settings-new-session-wizard-machines', 'Machine', 'auto'],
            ['settings-new-session-wizard-paths', 'Folder', 'auto'],
            ['settings-new-session-wizard-permissions', 'Permissions', 'auto'],
        ]);
        expect(screen.findRowByTitle('Two-column layout')?.props.subtitle).toBe('Stack every wizard selector in one column.');

        await act(async () => {
            steps.find(step => step.props.testID === 'settings-new-session-wizard-machines')!.props.onChange('dropdown');
        });
        await vi.waitFor(() => expect(storage.getState().settings.newSessionWizardSectionPresentationV1).toEqual({
            models: 'dropdown',
            machines: 'dropdown',
        }));

        expect(screen.findRowByTitle('Two-column layout')).toBeTruthy();
        await act(async () => { screen.pressRowByTitle('Two-column layout'); });
        await vi.waitFor(() => expect(storage.getState().settings.newSessionWizardColumnsEnabled).toBe(true));
    });
});
