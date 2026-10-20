/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { installModalComponentCommonModuleMocks } from '@/modal/components/modalComponentTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installModalComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
        const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
        // Use the real RNW DOM/ref/focus boundary, matching the existing modal DOM harness.
        const nativeWebPath = createRequire(import.meta.url).resolve('react-native-web');
        const { View, Text, TextInput, Pressable } = await vi.importActual<Pick<
            typeof import('react-native'), 'View' | 'Text' | 'TextInput' | 'Pressable'
        >>(nativeWebPath);
        return createReactNativeWebMock({
            Platform: { OS: 'web', select: <T,>(values: { web?: T; default?: T }) => values.web ?? values.default },
            View, Text, TextInput, Pressable,
        });
    },
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useLocalSetting: createUseLocalSettingMock() });
});
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return await createRadixCjsRealModule();
});
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('div', props, props.children),
}));

const { ModalProvider } = await import('@/modal/ModalProvider');
const { Modal } = await import('@/modal/ModalManager');
const { NewSessionScreenPortalScope } = await import('./newSessionContainedModalScreen');

it.each(['embedded', 'screen'] as const)('respects the %s composer modal lifetime', async presentation => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const renderPage = (composerAvailable: boolean) => (
        <ModalProvider>
            {composerAvailable ? <NewSessionScreenPortalScope presentation={presentation}>
                <button>Composer</button>
            </NewSessionScreenPortalScope> : null}
        </ModalProvider>
    );
    try {
        // The page host is mounted before its lazy composer arrives.
        await act(async () => { root.render(renderPage(false)); });
        await act(async () => { root.render(renderPage(true)); });
        await act(async () => {
            Modal.show({ component: () => <button data-testid="page-dialog-content">Dialog</button> });
        });
        expect(document.querySelector('[data-testid="page-dialog-content"]')).not.toBeNull();
        await act(async () => { root.render(renderPage(false)); });
        expect(document.querySelector('[data-testid="page-dialog-content"]') !== null).toBe(presentation === 'embedded');
    } finally {
        await act(async () => { root.unmount(); });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        container.remove();
    }
});
