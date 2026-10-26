import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installFormsCommonModuleMocks } from './formsTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installFormsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: <T,>(values: { web?: T; default?: T }) => values.web ?? values.default,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
});

async function renderSlider(props: Partial<React.ComponentProps<typeof import('./Slider')['Slider']>> = {}) {
    const onValueChange = vi.fn();
    const { Slider } = await import('./Slider');
    const screen = await renderScreen(
        <Slider
            testID="slider"
            value={3}
            min={0}
            max={6}
            step={1}
            accessibilityLabel="Text size"
            formatValueText={(value) => `Step ${value}`}
            onValueChange={onValueChange}
            {...props}
        />,
    );
    const slider = screen.findByTestId('slider');
    if (!slider) throw new Error('Expected the slider to render');
    return { screen, slider, onValueChange };
}

const key = (name: string) => ({ key: name, nativeEvent: { key: name }, preventDefault: vi.fn() });

describe('Slider', () => {
    it('is an adjustable control that announces its range and current value', async () => {
        const { slider } = await renderSlider();

        expect(slider.props.accessibilityRole).toBe('adjustable');
        expect(slider.props.accessibilityLabel).toBe('Text size');
        expect(slider.props.accessibilityValue).toEqual({ min: 0, max: 6, now: 3, text: 'Step 3' });
    });

    it('steps with assistive-technology increment and decrement actions, clamped to the range', async () => {
        const { slider, onValueChange } = await renderSlider({ value: 6 });

        act(() => {
            slider.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
        });
        expect(onValueChange).not.toHaveBeenCalled();

        act(() => {
            slider.props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } });
        });
        expect(onValueChange).toHaveBeenLastCalledWith(5);
    });

    it('moves by step with the arrow keys and to the ends with Home and End on the web', async () => {
        const { slider, onValueChange } = await renderSlider();

        const right = key('ArrowRight');
        act(() => slider.props.onKeyDown(right));
        expect(right.preventDefault).toHaveBeenCalled();
        expect(onValueChange).toHaveBeenLastCalledWith(4);

        act(() => slider.props.onKeyDown(key('ArrowDown')));
        expect(onValueChange).toHaveBeenLastCalledWith(2);

        act(() => slider.props.onKeyDown(key('End')));
        expect(onValueChange).toHaveBeenLastCalledWith(6);

        act(() => slider.props.onKeyDown(key('Home')));
        expect(onValueChange).toHaveBeenLastCalledWith(0);

        const tab = key('Tab');
        act(() => slider.props.onKeyDown(tab));
        expect(tab.preventDefault).not.toHaveBeenCalled();
        expect(onValueChange).toHaveBeenCalledTimes(4);
    });

    it('snaps a press or drag on the track to the nearest step', async () => {
        const { screen, onValueChange } = await renderSlider({ min: 0.75, max: 1.5, step: 0.05, value: 1 });
        const track = screen.findByTestId('slider-track');
        if (!track) throw new Error('Expected the slider track to render');

        await act(async () => {
            invokeTestInstanceHandler(track, 'onLayout', { nativeEvent: { layout: { width: 200, height: 40, x: 0, y: 0 } } });
        });
        await act(async () => {
            invokeTestInstanceHandler(track, 'onResponderGrant', { nativeEvent: { locationX: 101, pageX: 301 } });
        });
        expect(onValueChange).not.toHaveBeenCalled();
        expect(screen.findByTestId('slider')!.props.accessibilityValue.now).toBe(1.15);

        // The drag keeps measuring from the track even when the pointer leaves it.
        await act(async () => {
            invokeTestInstanceHandler(track, 'onResponderMove', { nativeEvent: { locationX: 4, pageX: 520 } });
        });
        expect(onValueChange).not.toHaveBeenCalled();
        expect(screen.findByTestId('slider')!.props.accessibilityValue.now).toBe(1.5);
        await act(async () => invokeTestInstanceHandler(track, 'onResponderRelease'));
        expect(onValueChange).toHaveBeenCalledExactlyOnceWith(1.5);
    });

    it('ignores input while disabled', async () => {
        const { slider, onValueChange } = await renderSlider({ disabled: true });

        act(() => slider.props.onKeyDown(key('ArrowRight')));
        act(() => {
            slider.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
        });

        expect(onValueChange).not.toHaveBeenCalled();
    });

    it('withdraws an interrupted drag without committing and ignores duplicate release events', async () => {
        const preview = vi.fn();
        const { screen, onValueChange } = await renderSlider({ onValuePreview: preview });
        const track = screen.findByTestId('slider-track')!;
        await act(async () => {
            track.props.onLayout({ nativeEvent: { layout: { width: 100 } } });
            track.props.onResponderGrant({ nativeEvent: { locationX: 100, pageX: 300 } });
        });
        expect(preview).toHaveBeenLastCalledWith(6);
        await act(async () => { track.props.onResponderTerminate(); track.props.onResponderRelease(); });
        expect(preview).toHaveBeenLastCalledWith(undefined);
        expect(onValueChange).not.toHaveBeenCalled();
        expect(screen.findByTestId('slider')!.props.accessibilityValue.now).toBe(3);
    });
});
