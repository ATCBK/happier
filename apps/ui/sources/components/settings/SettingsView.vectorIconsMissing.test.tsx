import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from './settingsViewTestHelpers';

const tauriDesktopState = vi.hoisted(() => ({ value: false }));
const routerPushSpy = vi.fn();

installSettingsViewCommonModuleMocks({
    icons: async () => {
        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        const mock = createExpoVectorIconsMock();
        return {
            ...mock,
            Ionicons: undefined,
        };
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    storage: 'real',
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: routerPushSpy,
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

describe('SettingsView (vector icons missing)', () => {
    beforeEach(() => {
        tauriDesktopState.value = true;
        routerPushSpy.mockReset();
    });

    it('does not crash when @expo/vector-icons exports Ionicons as undefined', async () => {
        const { SettingsView } = await import('./SettingsView');

        const renderPromise = renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>);
        await expect(renderPromise).resolves.toBeTruthy();
        const screen = await renderPromise;

        // The System section arrives in a deferred stage after the first paint.
        await vi.waitFor(() => expect(screen.findRow('settings-desktop-entry')).toBeTruthy());
    });
});
