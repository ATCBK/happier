import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const account = createProviderSettingsAccountHarness();
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');








// Load the real owner after boundaries during collection, outside behavior deadlines.
await import('./SessionHandoffSettingsView');

describe('SessionHandoffSettingsView', () => {
    beforeEach(async () => {
        await account.restore({ settings: { sessionHandoffDefaultsV1: {
            v: 1,
            workspaceSyncMode: 'keep_synced',
            includeIgnoredMode: 'include_selected',
            ignoredIncludeGlobs: [],
            directTargetMode: 'keep_direct',
        } } });
    });
    afterEach(async () => { standardCleanup(); await account.reset(); });

    it('keeps common modes concise and reveals advanced modes and content policy through one disclosure', async () => {
        const mod = await import('./SessionHandoffSettingsView');
        const SessionHandoffSettingsView = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionHandoffSettingsView));

        const choice = (prefix: string) => screen.findAll((node) => node.props?.testIDPrefix === prefix)[0] ?? null;
        const commonMode = choice('session-handoff-workspace-sync-mode');
        const advanced = screen.findAll((node) => node.props?.testID === 'session-handoff-settings-advanced')[0] ?? null;
        const directMode = choice('session-handoff-direct-target-mode');

        expect(commonMode?.props.options.map((item: any) => item.id)).toEqual(['keep_synced', 'copy_once', 'none']);
        expect(directMode).toBeTruthy();

        await act(async () => {
            advanced?.props.onExpandedChange(true);
        });

        const advancedMode = choice('session-handoff-settings-advanced-mode');
        expect(advancedMode?.props.options.map((item: any) => item.id)).toEqual(['mirror_exactly', 'keep_both_in_sync']);

        await act(async () => {
            advancedMode?.props.onChange('mirror_exactly');
        });
        await act(async () => {
            choice('session-handoff-ignored-mode')?.props.onChange('include_selected');
        });
        await act(async () => {
            choice('session-handoff-direct-target-mode')?.props.onChange('convert_to_persisted');
        });

        const globInput = screen.findAll((node) => String(node.type) === 'TextInput'
            && node.props?.accessibilityLabel === 'settingsSession.handoff.includeIgnoredMode.globsTitle')[0] ?? null;
        expect(globInput).toBeTruthy();
        await act(async () => {
            globInput?.props.onChangeText('dist/**, .env.local');
        });
        const editedGlobInput = screen.findAll((node) => String(node.type) === 'TextInput'
            && node.props?.accessibilityLabel === 'settingsSession.handoff.includeIgnoredMode.globsTitle')[0] ?? null;
        await act(async () => editedGlobInput?.props.onBlur());

        expect(storage.getState().settings.sessionHandoffDefaultsV1).toEqual({
            v: 1,
            workspaceSyncMode: 'mirror_exactly',
            includeIgnoredMode: 'include_selected',
            ignoredIncludeGlobs: ['dist/**', '.env.local'],
            directTargetMode: 'convert_to_persisted',
        });
    });

    it('keeps an unfinished comma while editing patterns and commits both entries on blur', async () => {
        const mod = await import('./SessionHandoffSettingsView');
        const screen = await renderSettingsView(React.createElement(mod.default));
        const advanced = screen.findAll((node) => node.props?.testID === 'session-handoff-settings-advanced')[0];
        await act(async () => advanced?.props.onExpandedChange(true));

        for (const draft of ['dist/**', 'dist/**,', 'dist/**, ', 'dist/**, .env.local']) {
            const input = screen.findAll((node) => String(node.type) === 'TextInput'
                && node.props?.accessibilityLabel === 'settingsSession.handoff.includeIgnoredMode.globsTitle')[0];
            await act(async () => input?.props.onChangeText(draft));
            expect(screen.findAll((node) => String(node.type) === 'TextInput'
                && node.props?.accessibilityLabel === 'settingsSession.handoff.includeIgnoredMode.globsTitle')[0]?.props.value).toBe(draft);
        }

        const input = screen.findAll((node) => String(node.type) === 'TextInput'
            && node.props?.accessibilityLabel === 'settingsSession.handoff.includeIgnoredMode.globsTitle')[0];
        await act(async () => input?.props.onBlur());
        expect(storage.getState().settings.sessionHandoffDefaultsV1.ignoredIncludeGlobs).toEqual(['dist/**', '.env.local']);
    });

    it('opens Advanced on arrival when "Include selected" needs its patterns, so the required field is never hidden', async () => {
        const mod = await import('./SessionHandoffSettingsView');
        const screen = await renderSettingsView(React.createElement(mod.default));

        const advanced = screen.findAll((node) => node.props?.testID === 'session-handoff-settings-advanced')[0];
        expect(advanced?.props.expanded).toBe(true);
        expect(screen.findAll((node) => String(node.type) === 'TextInput'
            && node.props?.accessibilityLabel === 'settingsSession.handoff.includeIgnoredMode.globsTitle')).toHaveLength(1);
    });

    it('shows the stored patterns again when they change elsewhere while the page is open', async () => {
        const mod = await import('./SessionHandoffSettingsView');
        const screen = await renderSettingsView(React.createElement(mod.default));
        const field = () => screen.findAll((node) => String(node.type) === 'TextInput'
            && node.props?.accessibilityLabel === 'settingsSession.handoff.includeIgnoredMode.globsTitle')[0];
        expect(field()?.props.value).toBe('');

        // A settings sync (another device, or the legacy-state reset on this page) writes new patterns.
        await act(async () => {
            const state = storage.getState();
            if (!state.settingsScope) throw new Error('Expected mounted Account settings');
            state.applySettingsForScope(state.settingsScope, {
                ...state.settings,
                sessionHandoffDefaultsV1: { ...state.settings.sessionHandoffDefaultsV1, ignoredIncludeGlobs: ['build/**'] },
            }, (state.settingsVersion ?? 0) + 1);
        });

        expect(field()?.props.value).toBe('build/**');
    });
});
