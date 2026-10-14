import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';

// Only the native measurement/animation boundary is replaced; frame, pan and portal stay real.
const measurements = vi.hoisted(() => ({ pageX: 40, pageY: 50, width: 200, height: 165 }));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return { ...createReanimatedModuleMock(), measure: () => measurements };
});

import { FloatingFrame, type FrameRect } from '@happier-dev/plugin-ui/presentation';
import {
    createRetainedPresentationSlotsStore,
    RetainedPresentationSlotBinder,
    RetainedPresentationSlotsProvider,
    RetainedPresentationNativeMotionContext,
    type RetainedPresentationNativeMotion,
} from '@/components/ui/presentation/retainedPresentationSlots';
import { NativeFloatingFrame } from './NativeFloatingFrame';

beforeEach(() => { measurements.pageX = 40; measurements.pageY = 50; });

describe('native FloatingFrame binding', () => {
    it('abandons an active resize on control takeover and restores the controlled size', async () => {
        const onRectChange = vi.fn();
        const motion: { current: RetainedPresentationNativeMotion | null } = { current: null };
        function Picture() {
            motion.current = React.useContext(RetainedPresentationNativeMotionContext);
            return <View />;
        }
        const frame = (moveInput: 'surface' | 'chrome') => <FloatingFrame
            mode="floating" rect={{ x: 40, y: 50, width: 200, height: 165 }}
            availableRect={{ x: 0, y: 0, width: 800, height: 600 }} aspectRatio={1.6}
            moveInput={moveInput} nativeBinding={NativeFloatingFrame} controls={<View />}
            accessibilityLabel="Viewer" onRectChange={onRectChange} onModeChange={vi.fn()}><Picture /></FloatingFrame>;
        const screen = await renderScreen(frame('surface'));
        const gesture = screen.findAllByType('GestureDetector')[1].props.gesture as TestGestureChain;
        await act(async () => {
            gesture.__handlers.onBegin({ absoluteX: 50, absoluteY: 205 });
            gesture.__handlers.onUpdate({ translationX: -30, translationY: 0 });
        });
        await screen.update(frame('chrome'));
        await act(async () => {
            gesture.__handlers.onEnd({ translationX: -30, translationY: 0 }, false);
            gesture.__handlers.onFinalize({}, false);
        });
        expect(onRectChange).not.toHaveBeenCalled();
        expect([motion.current!.width!.value, motion.current!.height!.value]).toEqual([200, 165]);
        await screen.unmount();
    });
    it('resizes a controlled retained body from its portal grip without remounting or publishing each frame', async () => {
        const store = createRetainedPresentationSlotsStore();
        const onRectChange = vi.fn();
        let mounts = 0;
        let renders = 0;
        function Picture() {
            React.useEffect(() => { mounts += 1; }, []);
            return <View testID="resize-picture" />;
        }
        function Harness() {
            renders += 1;
            const [rect, setRect] = React.useState<FrameRect>({ x: 40, y: 50, width: 200, height: 165 });
            return <RetainedPresentationSlotsProvider store={store}>
                <FloatingFrame mode="floating" rect={rect} availableRect={{ x: 0, y: 0, width: 800, height: 600 }}
                    aspectRatio={1.6} minWidth={180} moveInput="chrome" nativeBinding={NativeFloatingFrame}
                    reducedMotion controls={<View />} accessibilityLabel="Viewer" testID="resize-frame"
                    onModeChange={vi.fn()} onRectChange={(next, change) => { onRectChange(next, change); setRect(next); }}>
                    <RetainedPresentationSlotBinder slotId="resize-frame" enabled inputPassthrough={false}
                        windowGeometry={{ x: rect.x, y: rect.y + 40, width: rect.width, height: rect.height - 40 }}>
                        <Picture />
                    </RetainedPresentationSlotBinder>
                </FloatingFrame>
            </RetainedPresentationSlotsProvider>;
        }
        const screen = await renderScreen(<Harness />);
        const portal = screen.findByTestId('browser-presentation-portal-slot-resize-frame');
        const grip = portal.findByProps({ testID: 'resize-frame-grip' });
        expect(grip).toBeDefined();
        const gesture = portal.findByType('GestureDetector').props.gesture as TestGestureChain;
        const motion = store.getPortalSnapshot()[0].nativeMotion!;
        const initialRenders = renders;
        await act(async () => {
            gesture.__handlers.onTouchesDown({ allTouches: [{ absoluteX: 50, absoluteY: 205 }] }, { fail: vi.fn() });
            gesture.__handlers.onBegin({ absoluteX: 50, absoluteY: 205 });
            gesture.__handlers.onUpdate({ translationX: -30, translationY: 90 });
        });
        expect([motion.x.value, motion.width!.value]).toEqual([10, 230]);
        expect(motion.height!.value).toBe(183.75);
        expect(renders).toBe(initialRenders);
        expect(onRectChange).not.toHaveBeenCalled();
        await act(async () => {
            gesture.__handlers.onEnd({ translationX: -30, translationY: 90, velocityX: 900 }, true);
            gesture.__handlers.onFinalize({}, true);
        });
        expect(onRectChange).toHaveBeenLastCalledWith({ x: 10, y: 50, width: 230, height: 183.75 }, { kind: 'settle' });
        expect(mounts).toBe(1);
        await screen.unmount();
    });
    it('moves the retained picture on shared values and publishes only the obstacle-aware settle', async () => {
        const store = createRetainedPresentationSlotsStore();
        const onSettle = vi.fn();
        let mounts = 0;
        let renders = 0;
        function Picture() {
            React.useEffect(() => { mounts += 1; }, []);
            return <View testID="native-picture" />;
        }
        function Harness() {
            renders += 1;
            const [rect, setRect] = React.useState<FrameRect>({ x: 40, y: 50, width: 200, height: 165 });
            return <RetainedPresentationSlotsProvider store={store}>
                <FloatingFrame mode="floating" rect={rect} availableRect={{ x: 10, y: 20, width: 800, height: 600 }}
                    avoidRects={[{ x: 610, y: 455, width: 200, height: 165 }]}
                    aspectRatio={1.6} minWidth={180} moveInput="surface" nativeBinding={NativeFloatingFrame}
                    reducedMotion controls={<View />} accessibilityLabel="Viewer"
                    onModeChange={vi.fn()} onRectChange={(next, change) => { onSettle(next, change); setRect(next); }}>
                    <RetainedPresentationSlotBinder slotId="native-frame" enabled inputPassthrough
                        windowGeometry={{ x: rect.x, y: rect.y + 40, width: 200, height: 125 }}>
                        <Picture />
                    </RetainedPresentationSlotBinder>
                </FloatingFrame>
            </RetainedPresentationSlotsProvider>;
        }
        const screen = await renderScreen(<Harness />);
        const gesture = screen.findAllByType('GestureDetector')[0].props.gesture as TestGestureChain;
        const motion = store.getPortalSnapshot()[0].nativeMotion!;
        const initialRenders = renders;
        await act(async () => {
            gesture.__handlers.onTouchesDown({ allTouches: [{ absoluteX: 140, absoluteY: 130 }] }, { fail: vi.fn() });
            gesture.__handlers.onBegin({ absoluteX: 140, absoluteY: 130 });
            gesture.__handlers.onUpdate({ translationX: 100, translationY: 80 });
        });
        expect([motion.x.value, motion.y.value]).toEqual([140, 130]);
        expect(store.getPortalSnapshot()[0].geometry).toMatchObject({ x: 40, y: 90 });
        expect(renders).toBe(initialRenders);
        expect(onSettle).not.toHaveBeenCalled();
        await act(async () => {
            gesture.__handlers.onEnd({ translationX: 610, translationY: 450, velocityX: 0, velocityY: 0 }, true);
            gesture.__handlers.onFinalize({}, true);
        });
        expect(onSettle).toHaveBeenCalledWith({ x: 610, y: 290, width: 200, height: 165 }, { kind: 'settle' });
        expect(store.getPortalSnapshot()[0].nativeMotion?.x).toBe(motion.x);
        expect(store.getPortalSnapshot()[0].geometry).toMatchObject({ x: 610, y: 330 });
        expect(mounts).toBe(1);
        await screen.unmount();
    });

    it('admits chrome in control mode while leaving remote body input alone', async () => {
        const onRectChange = vi.fn();
        const renderFrame = (moveInput: 'surface' | 'chrome', footer = false) => <FloatingFrame
            mode="floating" rect={{ x: 40, y: 50, width: 200, height: footer ? 217 : 165 }}
            availableRect={{ x: 0, y: 0, width: 800, height: 600 }} aspectRatio={1.6}
            moveInput={moveInput} nativeBinding={NativeFloatingFrame} controls={<View />} footer={footer ? <View /> : undefined}
            accessibilityLabel="Viewer" onRectChange={onRectChange} onModeChange={vi.fn()}><View /></FloatingFrame>;
        const screen = await renderScreen(renderFrame('surface'));
        const gesture = screen.findAllByType('GestureDetector')[0].props.gesture as TestGestureChain;
        const fail = vi.fn();
        await act(async () => {
            gesture.__handlers.onTouchesDown({ allTouches: [{ absoluteX: 100, absoluteY: 60 }] }, { fail });
        });
        expect(fail).not.toHaveBeenCalled();
        await screen.update(renderFrame('surface', true));
        await act(async () => {
            const footerGesture = screen.findAllByType('GestureDetector')[0].props.gesture as TestGestureChain;
            // The grip belongs to the body's bottom, not the frame's bottom below its footer.
            footerGesture.__handlers.onTouchesDown({ allTouches: [{ absoluteX: 50, absoluteY: 205 }] }, { fail });
        });
        expect(fail).toHaveBeenCalledOnce(); // Grip belongs to the separate resize binding.
        await screen.update(renderFrame('chrome'));
        const controlPan = screen.findAllByType('GestureDetector')[0].props.gesture as TestGestureChain;
        expect(controlPan.__config.enabled).toBe(true);
        await act(async () => {
            controlPan.__handlers.onTouchesDown({ allTouches: [{ absoluteX: 100, absoluteY: 130 }] }, { fail });
        });
        expect(fail).toHaveBeenCalledTimes(2);
        expect(onRectChange).not.toHaveBeenCalled();
        await screen.unmount();
    });
});
