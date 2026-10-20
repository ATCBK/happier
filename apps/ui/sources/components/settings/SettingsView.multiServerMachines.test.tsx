import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderSettingsView } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from './settingsViewTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
installSettingsViewCommonModuleMocks({
    icons: async () => {
        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: vi.fn(async () => false),
                prompt: vi.fn(async () => null),
            },
        }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            Text: 'Text',
            ActivityIndicator: 'ActivityIndicator',
            Platform: {
                OS: 'web',
                select: (options: any) => (options && 'default' in options ? options.default : undefined),
            },
            Linking: {
                canOpenURL: async () => false,
                openURL: async () => {},
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: routerPushSpy },
        });
        return routerMock.module;
    },
    storage: 'real',
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
});

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





vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: vi.fn(), connectWithUrl: vi.fn(), isLoading: false }),
}));


vi.mock('@/track', () => ({
    trackPaywallButtonClicked: vi.fn(),
    trackWhatsNewClicked: vi.fn(),
}));

vi.mock('@/hooks/ui/useMultiClick', () => ({
    useMultiClick: (cb: () => void) => cb,
}));


vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
    useLayoutMaxWidth: () => 1000,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 1000 }),
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));


vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: 'MachineCliGlyphs',
}));

vi.mock('@/components/settings/supportUsBehavior', () => ({
    resolveSupportUsAction: () => 'github',
}));

vi.mock('@/utils/system/bugReportActionTrail', () => ({
    recordBugReportUserAction: vi.fn(),
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: false }),
}));

vi.mock('@/utils/platform/navigateWithBlurOnWeb', () => ({
    navigateWithBlurOnWeb: (fn: () => void) => fn(),
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (fn: () => void) => fn(),
}));

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { storage } = await import('@/sync/domains/state/storage');

beforeEach(async () => {
    await home.reset();
    const serverA = await home.addHome({ name: 'Server A', serverUrl: 'https://settings-a.example', serverIdentityId: 'srv-a', accountId: 'owner' });
    await home.addHome({ name: 'Server B', serverUrl: 'https://settings-b.example', serverIdentityId: 'srv-b', accountId: 'owner', active: false });
    const machines = [
        createMachineFixture({ id: 'mach-a1', metadata: { ...createMachineFixture().metadata!, displayName: 'Machine A1', host: 'a.local' } }),
        createMachineFixture({ id: 'mach-b1', metadata: { ...createMachineFixture().metadata!, displayName: 'Machine B1', host: 'b.local' } }),
    ];
    storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { 'srv-a': [machines[0]!], 'srv-b': [machines[1]!] },
        machineListStatusByServerId: { 'srv-a': 'idle', 'srv-b': 'idle' } });
    home.answer(serverA, '/v1/machines/managed/actions/list', { body: { machines: [] } });
    home.answer(serverA, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [] } });
});

afterEach(() => {
    routerPushSpy.mockClear();
});

beforeEach(async () => {
    const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
    await loadSyncSingletonForTests();
});

describe('SettingsView (multi-server machines)', () => {
    it('replaces the inline machines list with a dedicated machines settings entry', async () => {
        const { SettingsView } = await import('./SettingsView');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>)).tree;

        const { Item } = await import('@/components/ui/lists/Item');
        const items = tree!.findAllByType(Item);
        const itemTitles = items.map((item: any) => String(item.props.title ?? ''));

        expect(itemTitles).not.toContain('Machine A1');
        expect(itemTitles).not.toContain('Machine B1');
        expect(itemTitles).toContain('settings.machines');

        const machinesEntry = items.find((item: any) => item.props.title === 'settings.machines');
        expect(machinesEntry).toBeTruthy();

        await act(async () => {
            await pressTestInstanceAsync(machinesEntry!);
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/settings/machines');
    });
});
