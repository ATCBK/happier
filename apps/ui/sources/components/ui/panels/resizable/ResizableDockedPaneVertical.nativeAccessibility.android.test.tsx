import * as React from 'react';
import { act } from 'react-test-renderer';
import type { PanResponderCallbacks } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { findFirstByType, renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The ordinary divider suite is a web drag harness. This isolated renderer
// makes the native platform target factual rather than mutating that harness.
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' }, {
        View: 'View',
        Pressable: 'Pressable',
        // The OS responder delivers callbacks; all size decisions stay in the real shared core.
        PanResponder: { create: (callbacks: PanResponderCallbacks) => ({ panHandlers: callbacks }) },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
afterEach(() => vi.unstubAllGlobals());

describe('ResizableDockedPaneVertical native accessibility (Android)', () => {
    it('releases against the latest native budget and clears overshoot after a reversal', async () => {
        const onCommitHeightPx = vi.fn();
        let frame: FrameRequestCallback | undefined;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1; });
        vi.stubGlobal('cancelAnimationFrame', () => { frame = undefined; });
        const { ResizableDockedPaneVertical } = await import('./ResizableDockedPaneVertical');
        function NativePane() {
            const [maxHeightPx, setMaxHeightPx] = React.useState(484);
            return <ResizableDockedPaneVertical heightPx={320} minHeightPx={200} maxHeightPx={maxHeightPx}
                onCommitHeightPx={onCommitHeightPx} onDragHeightPx={height => {
                    if (typeof height === 'number' && height >= 420) setMaxHeightPx(900);
                }}><ViewStub /></ResizableDockedPaneVertical>;
        }
        const tree = (await renderScreen(<NativePane />)).tree;
        const handle = findFirstByType(tree, 'Pressable');
        if (!handle) throw new Error('expected native responder handle');
        await act(async () => { handle.props.onPanResponderGrant(); });
        await act(async () => { handle.props.onPanResponderMove({}, { dx: 0, dy: -240 }); });
        expect(frame).toBeDefined();
        await act(async () => { frame?.(0); });
        expect(handle.props.accessibilityValue.max).toBe(900);
        await act(async () => { handle.props.onPanResponderRelease(); });
        expect(onCommitHeightPx).toHaveBeenLastCalledWith(560, expect.objectContaining({
            attemptedSizePx: 560, clampedSizePx: 560, exceededMaxPx: false, overshootPx: 0,
        }));

        await act(async () => { handle.props.onPanResponderGrant(); });
        await act(async () => { handle.props.onPanResponderMove({}, { dx: 0, dy: 270 }); });
        await act(async () => { handle.props.onPanResponderMove({}, { dx: 0, dy: -20 }); });
        await act(async () => { handle.props.onPanResponderRelease(); });
        expect(onCommitHeightPx).toHaveBeenLastCalledWith(340, expect.objectContaining({
            attemptedSizePx: 340, clampedSizePx: 340, exceededMinPx: false, collapseArmed: false, overshootPx: 0,
        }));
    });

    it('exposes one 48dp adjustable divider with the current value and actions', async () => {
        const { ResizableDockedPaneVertical } = await import('./ResizableDockedPaneVertical');
        const tree = (await renderScreen(
            <ResizableDockedPaneVertical
                heightPx={320}
                minHeightPx={200}
                maxHeightPx={480}
                onCommitHeightPx={() => {}}
            >
                <ViewStub />
            </ResizableDockedPaneVertical>,
        )).tree;
        const handle = findFirstByType(tree, 'Pressable');
        if (!handle) throw new Error('expected resizable docked pane handle');

        expect(handle.props).toMatchObject({
            accessibilityRole: 'adjustable',
            accessibilityValue: { min: 200, max: 480, now: 320 },
            accessibilityActions: [
                { name: 'increment' },
                { name: 'decrement' },
            ],
        });
        expect(handle.props.hitSlop).toEqual({ bottom: 30 });
    });

    it('keeps a bottom-edge target inside its owning pane', async () => {
        const { ResizableDockedPaneVertical } = await import('./ResizableDockedPaneVertical');
        const tree = (await renderScreen(
            <ResizableDockedPaneVertical
                heightPx={320}
                minHeightPx={200}
                maxHeightPx={480}
                onCommitHeightPx={() => {}}
                resizeEdge="bottom"
            >
                <ViewStub />
            </ResizableDockedPaneVertical>,
        )).tree;
        const handle = findFirstByType(tree, 'Pressable');
        if (!handle) throw new Error('expected bottom-edge resizable docked pane handle');

        expect(handle.props.hitSlop).toEqual({ top: 30 });
    });
});

function ViewStub() {
    return React.createElement('ViewStub');
}
