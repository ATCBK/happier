import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const webHookState = vi.hoisted(() => ({
    windowHeight: 800,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({
            width: 1024,
            height: webHookState.windowHeight,
            scale: 1,
            fontScale: 1,
        }),
    });
});

vi.mock('react-native-reanimated', async () => {
    const React = await import('react');
    return {
        useSharedValue: <T,>(value: T) => React.useRef({ value }).current,
    };
});

describe('useComposerKeyboardLayout web', () => {
    beforeEach(() => {
        standardCleanup();
        webHookState.windowHeight = 800;
    });

    it('does not reserve the measured composer height inside the transcript inset', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.web');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(127);
        });

        expect(hook.getCurrent().composerHeight.value).toBe(127);
        expect(hook.getCurrent().listBottomInset.value).toBe(0);
    });

    it('lifts the composer only by the keyboard that rises above the bottom chrome it already clears', async () => {
        // A phone browser: the keyboard covers the 64 px tab-bar reservation the composer already sits
        // above, so the composer lands on the keyboard rather than 64 px over it (R9) — the same rule as
        // the native layout's `resolveKeyboardHeightWithinScaffold`.
        const noop = () => {};
        vi.stubGlobal('window', {
            innerHeight: 844,
            visualViewport: { height: 508, width: 390, offsetTop: 0, addEventListener: noop, removeEventListener: noop },
            addEventListener: noop,
            removeEventListener: noop,
        });
        vi.stubGlobal('document', { activeElement: { tagName: 'TEXTAREA', getAttribute: () => null } });
        try {
            const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.web');
            const hook = await renderHook(() => useComposerKeyboardLayout({
                layoutBottomInset: 64,
                safeAreaBottom: 0,
            }));

            expect(hook.getCurrent().bottomInset.value).toBe(336 - 64);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('caps available panel height to the measured scaffold container', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.web');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            availablePanelMaxHeight: 420,
            headerHeight: 100,
            safeAreaBottom: 0,
        }));

        expect(hook.getCurrent().availablePanelHeight.value).toBe(420);
    });
});
