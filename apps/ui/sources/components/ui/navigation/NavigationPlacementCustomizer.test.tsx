// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup, type RenderScreenResult } from '@/dev/testkit';
import { NavigationPlacementCustomizer, NavigationPlacementCustomizerView } from './NavigationPlacementCustomizer';
import { resolveNavigationPlacements, type NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installDisconnectedServerSocketBoundary();
vi.mock('@/utils/web/reactDomCjs', () => ({
    // ReactTestRenderer cannot mount a DOM portal; the reorder owner remains real.
    requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }),
}));
afterEach(standardCleanup);

const items = [{ id: 'home', title: 'Home' }, { id: 'plugin:example:review', title: 'Review' }, { id: 'settings', title: 'Settings' }];
const scope = { serverId: 'home-a', accountId: 'account-a' };
async function mount() {
    // Controlled presentation boundary captures device-local saves; all controls and model are real.
    let preferences: NavigationPlacementPreferences = { orderedIds: [], placements: {} };
    function Fixture() {
        const [value, setValue] = React.useState(preferences);
        return <NavigationPlacementCustomizerView surfaceId="appRail" items={items} preferences={value} scope={scope}
            showHeader={false} onChange={next => { preferences = next; setValue(next); }} />;
    }
    const screen = await renderScreen(<Fixture />);
    await act(async () => {
        for (const [index, item] of items.entries()) {
            const row = screen.findAllByType('View').find(node => typeof node.props.onLayout === 'function'
                && node.props.testID !== 'navigation-placement-customizer.reorder'
                && node.findAll(child => child.props.testID === `navigation-placement-customizer.move:${item.id}`).length > 0);
            row?.props.onLayout({ nativeEvent: { layout: { x: 0, y: index * 64, width: 600, height: 64 } } });
        }
    });
    return { screen, get preferences() { return preferences; } };
}
async function key(screen: RenderScreenResult, key: string) {
    await act(async () => {
        const grip = screen.findHostByTestId('navigation-placement-customizer.move:home');
        if (!grip) throw new Error('Missing accessible reorder grip');
        grip.props.onKeyDown({ key, preventDefault() {}, stopPropagation() {} });
    });
}

describe('navigation placement customization', () => {
    it('persists a phone placement edit through the enabled settings Action', async () => {
        const locks = installWebLockManagerMock();
        let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
        try {
            account = await createSecretSettingsTestHarness();
            const screen = await renderScreen(<NavigationPlacementCustomizer surfaceId="phoneLauncher" items={items} onClose={() => {}} />);
            for (const placement of ['hidden', 'pinned'] as const) {
                await act(async () => { await screen.findHostByTestId(`navigation-placement-customizer.placement:home:${placement}`)!.props.onPress(); });
                await vi.waitFor(() => expect(storage.getState().localSettings.navigationSurfacePlacementsV1.phoneLauncher?.placements.home).toBe(placement));
            }
        } finally { standardCleanup(); await account?.dispose(); locks.restore(); }
    });
    it('refuses a phone placement edit when the canonical settings Action is disabled', async () => {
        const locks = installWebLockManagerMock();
        let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
        try {
            account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: normalizeActionsSettingsV1({
                v: 1, actions: { 'settings.set': { enabled: false } },
            }) }) });
            const before = storage.getState().localSettings.navigationSurfacePlacementsV1;
            const screen = await renderScreen(<NavigationPlacementCustomizer surfaceId="phoneLauncher" items={items} onClose={() => {}} />);
            await act(async () => { screen.findHostByTestId('navigation-placement-customizer.placement:home:hidden')!.props.onPress(); });
            expect(storage.getState().localSettings.navigationSurfacePlacementsV1).toEqual(before);
        } finally { standardCleanup(); await account?.dispose(); locks.restore(); }
    });
    it('lets a plugin-qualified item move between pinned, More and hidden without losing its identity', async () => {
        const fixture = await mount();
        for (const placement of ['overflow', 'hidden', 'pinned'] as const) {
            await act(async () => {
                fixture.screen.findHostByTestId(`navigation-placement-customizer.placement:plugin:example:review:${placement}`)!.props.onPress();
            });
            expect(resolveNavigationPlacements(items, fixture.preferences)[placement].map(item => item.id)).toContain('plugin:example:review');
        }
    });
    it('reorders through the shared accessible carry owner while preserving placement choices', async () => {
        const fixture = await mount();
        await act(async () => { fixture.screen.findHostByTestId('navigation-placement-customizer.placement:settings:hidden')!.props.onPress(); });
        await key(fixture.screen, ' ');
        await key(fixture.screen, 'ArrowDown');
        await key(fixture.screen, 'Enter');
        expect(resolveNavigationPlacements(items, fixture.preferences).ordered.map(item => item.id)).toEqual(['plugin:example:review', 'home', 'settings']);
        expect(fixture.preferences.placements.settings).toBe('hidden');
    });
});
