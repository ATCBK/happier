import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from './settingsViewTestHelpers';

const tauriDesktopState = vi.hoisted(() => ({ value: true }));

installSettingsViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    storage: 'real',
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: vi.fn(),
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
});

vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    isDesktopHost: () => tauriDesktopState.value,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ discoverable: false, blockedBy: null }),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: vi.fn(async () => {}),
        presentPaywall: vi.fn(async () => ({ success: true })),
        refreshProfile: vi.fn(async () => {}),
    },
}));

vi.mock('@/track', () => ({
    trackPaywallButtonClicked: vi.fn(),
    trackWhatsNewClicked: vi.fn(),
}));

vi.mock('@/hooks/ui/useMultiClick', () => ({
    useMultiClick: (cb: () => void) => cb,
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));

vi.mock('@/utils/system/requestReview', () => ({
    canRequestReview: vi.fn(async () => false),
    requestReview: vi.fn(async () => {}),
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: vi.fn(), connectWithUrl: vi.fn(), isLoading: false }),
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return { ...createReactNavigationNativeMock(), useFocusEffect: () => {} };
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' } },
}));







vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: (props: Record<string, unknown>) => React.createElement('MachineCliGlyphs', props),
}));


vi.mock('@/components/settings/supportUsBehavior', () => ({
    resolveSupportUsAction: () => 'github',
}));

vi.mock('@/utils/system/bugReportActionTrail', () => ({
    recordBugReportUserAction: vi.fn(),
}));

vi.mock('react-native-svg', async () => ({
    ...await import('@/dev/testkit/mocks/reactNativeSvg'),
    __esModule: true,
    default: undefined,
    Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Path: (props: Record<string, unknown>) => React.createElement('Path', props),
    Circle: (props: Record<string, unknown>) => React.createElement('Circle', props),
    Rect: (props: Record<string, unknown>) => React.createElement('Rect', props),
    G: (props: Record<string, unknown> & { children?: React.ReactNode }) => React.createElement('G', props, props.children),
    SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props),
}));

const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
await import('./SettingsView');

const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
beforeEach(() => {
    storage.setState({ settings: { ...settingsDefaults, useProfiles: false },
        profile: { ...profileDefaults, id: 'prof_1' }, machines: {},
        machineListByServerId: {}, machineListStatusByServerId: {} });
});

describe('SettingsView (Dependabot icon fallback)', () => {
    beforeEach(() => {
        tauriDesktopState.value = true;
    });

    it('renders the real settings shell when react-native-svg omits the default export', async () => {
        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>);

        await vi.waitFor(() => expect(screen.findRowByTitle('subAgentGuidance.settings.groupTitle')).toBeTruthy());
        // The System section arrives in a deferred stage after the first paint.
        await vi.waitFor(() => expect(screen.findRow('settings-desktop-entry')).toBeTruthy());
    });
});
