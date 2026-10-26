import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';

import { installModalComponentCommonModuleMocks } from '../modalComponentTestHelpers';

const runtime = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'ios' | 'android',
}));

installModalComponentCommonModuleMocks({
    reactNative: async () => await createReactNativeWebMock({
        Platform: {
            get OS() {
                return runtime.platform;
            },
            select: <T,>(choices: { web?: T; default?: T; native?: T; ios?: T; android?: T }) => (
                choices[runtime.platform] ?? choices.native ?? choices.default
            ),
        },
    }),
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') return flattenStyle(style({ pressed: false, focused: false }));
    if (Array.isArray(style)) return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    return style && typeof style === 'object' ? { ...style } as Record<string, unknown> : {};
}

function readPhysicalTarget(node: ReactTestInstance): Readonly<{ width: number; height: number }> {
    const style = flattenStyle(node.props.style);
    return {
        width: Math.max(Number(style.width ?? 0), Number(style.minWidth ?? 0)),
        height: Math.max(Number(style.height ?? 0), Number(style.minHeight ?? 0)),
    };
}

let restoreBrowserGlobals: (() => void) | undefined;
beforeEach(() => {
    // This suite asserts touch floors. A node host has no pointer hardware;
    // explicitly model the coarse primary pointer of the web touch case.
    restoreBrowserGlobals = withPopoverWebGlobals({ window: {
        matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' || query === '(hover: none)' }),
    } });
});
afterEach(async () => {
    await standardCleanup();
    restoreBrowserGlobals?.();
    vi.unstubAllGlobals();
    runtime.platform = 'web';
});

describe('ModalCloseButton', () => {
    it.each([
        ['touch web', 'web', 44],
        ['iOS', 'ios', 44],
        ['Android', 'android', 48],
    ] as const)('draws the %s close square at its design size and reaches the finger target with the hit area', async (_name, platform, minimum) => {
        runtime.platform = platform;
        // A browser's primary pointer is a boundary: a phone browser reports touch points and no hover.
        vi.stubGlobal('navigator', { maxTouchPoints: 5 });
        const { ModalCloseButton } = await import('./ModalCloseButton');
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const onPress = vi.fn();
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform, colorScheme: 'light' }}>
                <ModalCloseButton onPress={onPress} />
            </HappierUiPlatformProvider>,
        );

        const close = () => screen.findByTestId('modal-card-close')!;
        expect(close().props.accessibilityRole).toBe('button');
        expect(close().props.focusable).toBe(true);
        // A touch target is a hit area, not a drawn size (DESIGN.md): the 20px glyph sits in a 28px square.
        expect(readPhysicalTarget(close())).toEqual({ width: 28, height: 28 });
        const inset = (minimum - 28) / 2;
        if (platform === 'web') {
            const frame = screen.root.findAll((node) => node.props?.dataSet?.happierHitArea === 'true')[0];
            expect(frame?.props.style).toMatchObject({ top: -inset, bottom: -inset, left: -inset, right: -inset });
        } else {
            expect(close().props.hitSlop).toEqual({ top: inset, bottom: inset, left: inset, right: inset });
        }

        screen.pressByTestId('modal-card-close');
        expect(onPress).toHaveBeenCalledOnce();
    });
});
