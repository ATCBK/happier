/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { installModalComponentCommonModuleMocks } from '@/modal/components/modalComponentTestHelpers';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installModalComponentCommonModuleMocks({
    reactNative: async () => {
        const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
        const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
        return await vi.importActual(createRequire(import.meta.url).resolve('react-native-web'));
    },
    text: async () => await vi.importActual('@/text'),
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ segments: [] }).module;
});
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return await createRadixCjsRealModule();
});
installDisconnectedServerSocketBoundary();

// The complete palette, command dispatcher, modal manager/host, controller and
// presentation stay real; only the navigator, native UI and network leave this process.
const { ModalProvider } = await import('@/modal/ModalProvider');
const { CommandPaletteProvider } = await import('./CommandPaletteProvider');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');

it('reopens Search through the app-shell shortcut after its route-modal host retires', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const before = storage.getState().settings;
    storage.setState({ settings: { ...settingsDefaults, commandPaletteEnabled: true, keyboardShortcutsV2Enabled: true } });
    const render = (routeFocused: boolean) => <InjectedAuthProvider credentials={null}>
        <ModalProvider><CommandPaletteProvider>
            <ModalProvider active={routeFocused}><button>Session</button></ModalProvider>
        </CommandPaletteProvider></ModalProvider>
    </InjectedAuthProvider>;
    const open = () => act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', altKey: true, bubbles: true, cancelable: true }));
    });
    const palette = () => document.querySelector('[data-testid="universal-search-host"]');
    try {
        await act(async () => root.render(render(false)));
        // A route becomes focused after the app-shell provider is registered.
        await act(async () => root.render(render(true)));
        await open();
        await vi.waitFor(() => expect(palette()).not.toBeNull());
        // This is the route scope's actual active=false transition, not a mocked
        // dismissal callback. The app-shell owner survives the route navigation.
        await act(async () => root.render(render(false)));
        expect(palette()).toBeNull();
        await open();
        await vi.waitFor(() => expect(palette()).not.toBeNull());
        expect(document.querySelectorAll('[data-testid="universal-search-host"]')).toHaveLength(1);
    } finally {
        await act(async () => root.unmount());
        storage.setState({ settings: before });
        container.remove();
    }
});
