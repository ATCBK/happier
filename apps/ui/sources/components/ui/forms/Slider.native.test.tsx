import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installFormsCommonModuleMocks } from './formsTestHelpers';

const platform = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));

installFormsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            Platform: { get OS() { return platform.os; } },
        });
    },
});

describe('Slider native responder target', () => {
    it.each([['ios', 44], ['android', 48]] as const)(
        'reserves a centered %s touch target without enlarging the drawn track',
        async (os, minimumHeight) => {
            platform.os = os;
            const { Slider } = await import('./Slider');
            const { StyleSheet } = await import('react-native');
            const onValueChange = vi.fn();
            const screen = await renderScreen(<Slider testID="slider" value={3} min={0} max={6}
                step={1} trackWidth={200} onValueChange={onValueChange} />);
            const target = screen.findByTestId('slider-track')!;
            const targetStyle = StyleSheet.flatten(target.props.style);
            expect(targetStyle.height).toBe(minimumHeight);
            // Reserved layout space, rather than an overlapping HitRect outside the control.
            expect(target.props.hitSlop).toBeUndefined();
            const track = target.children[0];
            const thumb = target.children[1];
            if (typeof track === 'string' || typeof thumb === 'string') throw new Error('Expected drawn slider parts');
            expect(StyleSheet.flatten(track.props.style).height).toBe(4);
            const thumbStyle = StyleSheet.flatten(thumb.props.style);
            expect(thumbStyle.height).toBe(18);
            expect(thumbStyle.top + thumbStyle.height / 2).toBe(minimumHeight / 2);

            await act(async () => {
                invokeTestInstanceHandler(target, 'onLayout', { nativeEvent: { layout: { width: 200, height: minimumHeight, x: 0, y: 0 } } });
                invokeTestInstanceHandler(target, 'onResponderGrant', { nativeEvent: { locationX: 50, locationY: 1, pageX: 250 } });
            });
            expect(onValueChange).toHaveBeenLastCalledWith(2);
            await act(async () => {
                invokeTestInstanceHandler(target, 'onResponderMove', { nativeEvent: { locationX: 4, pageX: 400 } });
            });
            expect(onValueChange).toHaveBeenLastCalledWith(6);
            await act(async () => invokeTestInstanceHandler(target, 'onResponderRelease'));
            expect(screen.findByTestId('slider')?.props.accessibilityValue).toMatchObject({ min: 0, max: 6, now: 3 });

            await screen.update(<Slider testID="slider" value={3} min={0} max={6}
                step={1} trackWidth={200} onValueChange={onValueChange} disabled />);
            const disabledTarget = screen.findByTestId('slider-track')!;
            expect(disabledTarget.props.onStartShouldSetResponder()).toBe(false);
            onValueChange.mockClear();
            await act(async () => {
                invokeTestInstanceHandler(disabledTarget, 'onResponderGrant', { nativeEvent: { locationX: 0, pageX: 200 } });
                invokeTestInstanceHandler(disabledTarget, 'onResponderMove', { nativeEvent: { pageX: 400 } });
            });
            expect(onValueChange).not.toHaveBeenCalled();
        },
    );
});
