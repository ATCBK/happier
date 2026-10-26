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
        'keeps the %s track frame at its drawn height and reaches the touch target with hitSlop',
        async (os, touchTarget) => {
            platform.os = os;
            const { Slider } = await import('./Slider');
            const { StyleSheet } = await import('react-native');
            const onValueChange = vi.fn();
            const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
            const withPlatform = (node: React.ReactElement) => (
                <HappierUiPlatformProvider platform={{ platform: os, colorScheme: 'light' }}>{node}</HappierUiPlatformProvider>
            );
            const screen = await renderScreen(withPlatform(<Slider testID="slider" value={3} min={0} max={6}
                step={1} trackWidth={200} onValueChange={onValueChange} />));
            const target = screen.findByTestId('slider-track')!;
            const targetStyle = StyleSheet.flatten(target.props.style);
            // A touch target is a hit area, not a drawn size: the row keeps the 40px track frame.
            const frameHeight = 40;
            expect(targetStyle.height).toBe(frameHeight);
            const track = target.children[0];
            const thumb = target.children[1];
            if (typeof track === 'string' || typeof thumb === 'string') throw new Error('Expected drawn slider parts');
            expect(StyleSheet.flatten(track.props.style).height).toBe(4);
            const thumbStyle = StyleSheet.flatten(thumb.props.style);
            expect(thumbStyle.height).toBe(18);
            expect(thumbStyle.top + thumbStyle.height / 2).toBe(frameHeight / 2);

            await act(async () => {
                invokeTestInstanceHandler(target, 'onLayout', { nativeEvent: { layout: { width: 200, height: frameHeight, x: 0, y: 0 } } });
                invokeTestInstanceHandler(target, 'onResponderGrant', { nativeEvent: { locationX: 50, locationY: 1, pageX: 250 } });
            });
            // Above and below only: the track scrubs along its own width.
            expect(screen.findByTestId('slider-track')!.props.hitSlop).toEqual({ top: (touchTarget - frameHeight) / 2, bottom: (touchTarget - frameHeight) / 2, left: 0, right: 0 });
            expect(onValueChange).not.toHaveBeenCalled();
            expect(screen.findByTestId('slider')?.props.accessibilityValue.now).toBe(2);
            await act(async () => {
                invokeTestInstanceHandler(target, 'onResponderMove', { nativeEvent: { locationX: 4, pageX: 400 } });
            });
            expect(onValueChange).not.toHaveBeenCalled();
            expect(screen.findByTestId('slider')?.props.accessibilityValue.now).toBe(6);
            await act(async () => invokeTestInstanceHandler(target, 'onResponderRelease'));
            expect(onValueChange).toHaveBeenCalledExactlyOnceWith(6);
            expect(screen.findByTestId('slider')?.props.accessibilityValue).toMatchObject({ min: 0, max: 6, now: 3 });

            await screen.update(withPlatform(<Slider testID="slider" value={3} min={0} max={6}
                step={1} trackWidth={200} onValueChange={onValueChange} disabled />));
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
