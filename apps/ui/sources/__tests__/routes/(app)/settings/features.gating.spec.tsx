import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createRootLayoutFeaturesResponse, renderSettingsView as renderBaseSettingsView, standardCleanup } from '@/dev/testkit';
import {
    installSessionSettingsEntryModuleMocks,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const useServerFeaturesMainSelectionSnapshotMock = vi.fn();
const useEffectiveServerSelectionMock = vi.fn();

vi.mock('@/sync/domains/features/featureDecisionRuntime', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        useServerFeaturesMainSelectionSnapshot: (...args: any[]) => useServerFeaturesMainSelectionSnapshotMock(...args),
    };
});

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useEffectiveServerSelection: () => useEffectiveServerSelectionMock(),
}));

let settingsFixture: Record<string, unknown>;
let localSettingsFixture: Record<string, unknown>;

async function renderSettingsView(element: React.ReactElement) {
    // Build-policy cases deliberately reload the route realm; seed that realm's real store.
    const [{ storage }, { settingsParse }, { localSettingsParse }] = await Promise.all([
        import('@/sync/domains/state/storageStore'), import('@/sync/domains/settings/settings'), import('@/sync/domains/settings/localSettings'),
    ]);
    storage.setState({ settings: settingsParse(settingsFixture), localSettings: localSettingsParse(localSettingsFixture) });
    return renderBaseSettingsView(element);
}
afterEach(() => standardCleanup());

function listTitles(screen: Awaited<ReturnType<typeof renderSettingsView>>) {
    return screen.findAll((node) => typeof node.props?.title === 'string').map((node) => node.props.title as string);
}

describe('FeaturesSettingsScreen gating', () => {
    beforeEach(() => {
        vi.resetModules();
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW;
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        delete process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV;

        installSessionSettingsEntryModuleMocks({
            reactNative: async () => {
                const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
                return createReactNativeWebMock({
                    View: 'View',
                    Text: 'Text',
                    Platform: {
                        OS: 'ios',
                        select: (spec: Record<string, unknown>) =>
                            spec && Object.prototype.hasOwnProperty.call(spec, 'ios') ? (spec as any).ios : (spec as any).default,
                    },
                });
            },
            textModule: async () => {
                const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
                return createTextModuleMock({ translate: (key) => key });
            },
            modalModule: async () => {
                const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
                return createModalModuleMock({
                    spies: {
                        confirm: vi.fn(async () => false),
                    },
                }).module;
            },
        });

        useEffectiveServerSelectionMock.mockReturnValue({ serverIds: [] });
        useServerFeaturesMainSelectionSnapshotMock.mockReturnValue({ status: 'ready', serverIds: [], snapshotsByServerId: {} });

        settingsFixture = { experiments: true, featureToggles: {}, useProfiles: false, agentInputEnterToSend: false,
            agentInputHistoryScope: 'perSession', hideInactiveSessions: false, groupInactiveSessionsByProject: false,
            useEnhancedSessionWizard: false, useMachinePickerSearch: false, usePathPickerSearch: false };
        localSettingsFixture = { commandPaletteEnabled: false, devModeEnabled: false };
    });

    it('hides build-policy denied feature toggles from the list', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'execution.runs,social.friends,scm.writeOperations';
        vi.resetModules();
        const { getFeatureBuildPolicyDecision } = await import('@/sync/domains/features/featureBuildPolicy');
        expect(getFeatureBuildPolicyDecision('execution.runs')).toBe('deny');

        const { default: FeaturesSettingsScreen } = await import('@/app/(app)/settings/features');

        const screen = await renderSettingsView(React.createElement(FeaturesSettingsScreen));
        const allTitles = listTitles(screen);
        const featureGroup = screen.findGroup('settingsFeatures.experiments');
        const titles = featureGroup ? featureGroup.findAllByType('Item' as any).map((i) => i.props.title) : [];

        expect(allTitles).not.toContain('settingsFeatures.hideInactiveSessions');
        expect(allTitles).not.toContain('settingsFeatures.sessionListActiveGrouping');
        expect(allTitles).not.toContain('settingsFeatures.sessionListInactiveGrouping');
        expect(titles).not.toContain('settingsFeatures.expExecutionRuns');
        expect(titles).not.toContain('settingsFeatures.expFriends');
        expect(titles).not.toContain('settingsFeatures.expScmOperations');
    });

    it('hides server-disabled toggles even when build policy allows them', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = 'social.friends';

        useEffectiveServerSelectionMock.mockReturnValue({ serverIds: ['server-1'] });
        useServerFeaturesMainSelectionSnapshotMock.mockReturnValue({
            status: 'ready',
            serverIds: ['server-1'],
            snapshotsByServerId: {
                'server-1': {
                    status: 'ready',
                    features: createRootLayoutFeaturesResponse({
                        features: {
                            social: { friends: { enabled: false } },
                        },
                    }),
                },
            },
        });

        const { default: FeaturesSettingsScreen } = await import('@/app/(app)/settings/features');

        const screen = await renderSettingsView(React.createElement(FeaturesSettingsScreen));
        const allTitles = listTitles(screen);
        const featureGroup = screen.findGroup('settingsFeatures.experiments');
        const titles = featureGroup ? featureGroup.findAllByType('Item' as any).map((i) => i.props.title) : [];

        expect(allTitles).not.toContain('settingsFeatures.hideInactiveSessions');
        expect(allTitles).not.toContain('settingsFeatures.sessionListActiveGrouping');
        expect(allTitles).not.toContain('settingsFeatures.sessionListInactiveGrouping');
        expect(titles).not.toContain('settingsFeatures.expFriends');
    });

    it('keeps client toggle entries visible when server snapshot lacks their enabled bit', async () => {
        useEffectiveServerSelectionMock.mockReturnValue({ serverIds: ['server-1'] });
        useServerFeaturesMainSelectionSnapshotMock.mockReturnValue({
            status: 'ready',
            serverIds: ['server-1'],
            snapshotsByServerId: {
                'server-1': {
                    status: 'ready',
                    features: createRootLayoutFeaturesResponse({
                        features: {
                            voice: { enabled: true, happierVoice: { enabled: false } },
                        },
                    }),
                },
            },
        });

        const { default: FeaturesSettingsScreen } = await import('@/app/(app)/settings/features');

        const screen = await renderSettingsView(React.createElement(FeaturesSettingsScreen));
        const voiceAgentItem = screen.findRowByTitle('settingsFeatures.expVoiceAgent');
        expect(voiceAgentItem).toBeTruthy();
    });

    it('exposes neither a master Connected Accounts toggle nor a switch for connected-account usage', async () => {
        vi.resetModules();
        settingsFixture.featureToggles = { 'connectedServices.quotas': true };

        const { default: FeaturesSettingsScreen } = await import('@/app/(app)/settings/features');

        const screen = await renderSettingsView(React.createElement(FeaturesSettingsScreen));
        expect(screen.findRowByTitle('settingsFeatures.expConnectedServices')).toBeNull();
        expect(screen.findRowByTitle('settingsFeatures.expConnectedServicesQuotas')).toBeNull();
    });

    it('shows stable terminal layout and renderer settings without enabling experiments', async () => {
        vi.resetModules();

        settingsFixture.experiments = false;
        localSettingsFixture.terminalRendererPreference = 'native';

        const { default: FeaturesSettingsScreen } = await import('@/app/(app)/settings/features');
        // The renderer row exists only on native hosts. The per-case React Native port is installed
        // after the testkit graph loaded the default web port, so present iOS on that loaded port.
        const { Platform } = await import('react-native');
        const os = Platform.OS;
        Object.assign(Platform, { OS: 'ios' });
        onTestFinished(() => { Object.assign(Platform, { OS: os }); });

        const screen = await renderSettingsView(React.createElement(FeaturesSettingsScreen));
        // The terminal lives in the bottom pane (terminal lab B1); there is no location to choose.
        expect(screen.findAll((node) => node.props?.title === 'terminalEmbedded.settings.locationTitle')).toHaveLength(0);
        const renderer = screen.findAll((node) => node.props?.title === 'terminalEmbedded.settings.rendererTitle' && Array.isArray(node.props?.options))[0];
        expect(renderer?.props.value).toBe('native');
    });
});
