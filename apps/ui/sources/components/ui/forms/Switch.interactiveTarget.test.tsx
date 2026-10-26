import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { renderScreen } from '@/dev/testkit';
import { HAPPIER_SWITCH_METRICS } from '@happier-dev/plugin-ui/presentation';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'android',
            select: <T,>(options: { android?: T; default?: T; native?: T; ios?: T; web?: T }) =>
                options.android ?? options.default ?? options.native ?? options.ios ?? options.web,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') {
        return flattenStyle(style({ pressed: false }));
    }
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('Switch interactive target', () => {
    it('lays the web switch out at its drawn track while its hit region keeps the full target', async () => {
        const { Switch } = await import('./Switch.web');
        const screen = await renderScreen(
            <Switch value={false} onValueChange={() => {}} testID="web-switch" />,
        );

        const interactionNode = screen.findByTestId('web-switch');
        expect(interactionNode?.props.accessibilityRole).toBe('switch');
        expect(typeof interactionNode?.props.onPress).toBe('function');
        const style = flattenStyle(interactionNode?.props.style);
        const { trackWidth, trackHeight } = HAPPIER_SWITCH_METRICS.default;
        // Hit region: the full touch target.
        expect(style.width).toBe(HAPPIER_SWITCH_METRICS.webTargetPx);
        expect(style.height).toBe(HAPPIER_SWITCH_METRICS.webTargetPx);
        // Layout footprint: exactly the drawn track, so a row never grows around the switch.
        expect((style.width as number) + 2 * (style.marginHorizontal as number)).toBe(trackWidth);
        expect((style.height as number) + 2 * (style.marginVertical as number)).toBe(trackHeight);
    });

    it('never inflates the native switch interaction nodes to the touch target (their wrapper pressable owns the reach)', async () => {
        const { Switch } = await import('./Switch');
        const screen = await renderScreen(
            <>
                <Switch
                    value={false}
                    onValueChange={() => {}}
                    testID="native-switch-default"
                    style={{ minWidth: 1, minHeight: 1 }}
                />
                <Switch
                    compact
                    value={false}
                    onValueChange={() => {}}
                    testID="native-switch-compact"
                    style={{ minWidth: 1, minHeight: 1 }}
                />
            </>,
        );
        const minimumTargetSize = resolveMinimumInteractiveTargetSize('android');

        const targetSizes = ['native-switch-default', 'native-switch-compact'].map((testID) => {
            const interactionNode = screen.findByTestId(testID);
            expect(typeof interactionNode?.props.onValueChange).toBe('function');
            const targetStyle = flattenStyle(interactionNode?.props.style);
            return {
                minWidth: targetStyle.minWidth,
                minHeight: targetStyle.minHeight,
            };
        });
        expect(minimumTargetSize).toBe(48);
        // The platform switch keeps the size its caller declared; a target is a hit area, not a drawn size.
        expect(targetSizes).toEqual([
            { minWidth: 1, minHeight: 1 },
            { minWidth: 1, minHeight: 1 },
        ]);
    });
});
