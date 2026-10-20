import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

const modalState = vi.hoisted(() => ({ open: false }));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
    });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ get isKeyboardLiftSuppressedByModal() { return modalState.open; } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useSetting: (key: string) => key.endsWith('Enabled') ? true : undefined });
});

describe('phone session gestures under a modal', () => {
    it('disables the real band while a stage owns the phone and restores it after closing', async () => {
        const { SessionSwitcherBand } = await import('./SessionSwitcherBand');
        const { SessionCockpitChromeRegistryProvider } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const render = () => <InjectedAuthProvider credentials={null}><SessionCockpitChromeRegistryProvider><SessionSwitcherBand sessionId="session" serverId="server"><React.Fragment /></SessionSwitcherBand></SessionCockpitChromeRegistryProvider></InjectedAuthProvider>;
        const screen = await renderScreen(render());
        const gestures = () => screen.findByType('GestureDetector').props.gesture.gestures as { __config: { enabled: boolean } }[];
        expect(gestures().every(gesture => gesture.__config.enabled)).toBe(true);
        modalState.open = true;
        await screen.update(render());
        expect(gestures().every(gesture => !gesture.__config.enabled)).toBe(true);
        modalState.open = false;
        await screen.update(render());
        expect(gestures().every(gesture => gesture.__config.enabled)).toBe(true);
    });
});
