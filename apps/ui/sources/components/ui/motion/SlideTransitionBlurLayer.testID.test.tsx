import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installExpoBlurRequireStub } from '@/dev/testkit/mocks/expoBlur';

const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));
const restoreExpoBlur = installExpoBlurRequireStub();
afterAll(restoreExpoBlur);
afterEach(() => { platform.OS = 'ios'; });

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return platform.OS; } } });
});

vi.mock('react-native-reanimated', async () => {
    const ReactModule = await import('react');
    type SharedValue<T> = { value: T };
    const useSharedValue = <T,>(initial: T): SharedValue<T> => {
        const ref = ReactModule.useRef<SharedValue<T> | null>(null);
        if (!ref.current) ref.current = { value: initial };
        return ref.current;
    };
    const useAnimatedStyle = <T,>(factory: () => T): T => factory();
    const useAnimatedProps = <T,>(factory: () => T): T => factory();
    const Animated = {
        View: 'Animated.View',
        ScrollView: 'Animated.ScrollView',
        Text: 'Animated.Text',
        createAnimatedComponent: (component: unknown) => component,
    };
    return {
        __esModule: true,
        default: Animated,
        ...Animated,
        useAnimatedProps,
        useAnimatedStyle,
        useSharedValue,
    };
});

describe('SlideTransitionBlurLayer testID forwarding', () => {
    it('forwards testID to the native AnimatedBlurView so visual QA harnesses can target the rendered blur element', async () => {
        const Reanimated = await import('react-native-reanimated');
        const { SlideTransitionBlurLayer } = await import('./SlideTransitionBlurLayer');

        function Harness(): React.ReactElement {
            const progress = Reanimated.useSharedValue(0);
            return (
                <SlideTransitionBlurLayer
                    role="current"
                    progress={progress}
                    distance={32}
                    maxBlurPx={12}
                    nativeBlurIntensityScale={3}
                    testID="my-blur"
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        // A later render must retain testID forwarding on the cached animated component.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await screen.update(<Harness />);

        // The native blur path renders an `AnimatedBlurView` (a host component named
        // 'BlurView' under the test mock). The testID prop must be forwarded onto it
        // so visual QA harnesses and tests can target the rendered blur element.
        const blurNode = screen.findByType('BlurView');
        expect(blurNode.props.testID).toBe('my-blur');
    });
    it('does not mount a targetless blur overlay on Android', async () => {
        platform.OS = 'android';
        const Reanimated = await import('react-native-reanimated');
        const { SlideTransitionBlurLayer } = await import('./SlideTransitionBlurLayer');
        function Harness() {
            const progress = Reanimated.useSharedValue(0.5);
            return <SlideTransitionBlurLayer role="current" progress={progress} distance={32}
                maxBlurPx={12} nativeBlurIntensityScale={3} testID="android-blur" />;
        }
        const screen = await renderScreen(<Harness />);
        await act(async () => { await vi.dynamicImportSettled(); });
        await screen.update(<Harness />);
        expect(screen.findAllByType('BlurView')).toHaveLength(0);
    });

});
