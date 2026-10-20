import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

import { useScrollEdgeFades, type UseScrollEdgeFadesParams } from './useScrollEdgeFades';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderFades(params: UseScrollEdgeFadesParams) {
    let current!: ReturnType<typeof useScrollEdgeFades>;
    function Harness() {
        current = useScrollEdgeFades(params);
        return null;
    }
    act(() => { renderer.create(React.createElement(Harness)); });
    return { getCurrent: () => current };
}

function scrollEvent(x: number, viewport: number, content: number) {
    return {
        nativeEvent: {
            contentOffset: { x, y: 0 },
            layoutMeasurement: { width: viewport, height: 40 },
            contentSize: { width: content, height: 40 },
        },
    } as unknown as NativeSyntheticEvent<NativeScrollEvent>;
}

describe('useScrollEdgeFades end inset', () => {
    it('keeps the leading fade for a rail scrolled less than its end gutter, and drops the trailing one at the last item', () => {
        const hook = renderFades({
            enabledEdges: { left: true, right: true },
            overflowThreshold: 8,
            edgeThreshold: 2,
            contentEndInset: 24,
        });
        act(() => {
            hook.getCurrent().onViewportLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 40 } } } as unknown as LayoutChangeEvent);
        });

        // Scrolled to the end of content that overflows by 30px (24 of it the empty end gutter) the first
        // item is cut by 30px: the scroll range is under the gutter plus the overflow threshold.
        act(() => { hook.getCurrent().onScroll(scrollEvent(30, 800, 830)); });
        expect(hook.getCurrent().visibility).toMatchObject({ left: true, right: false });

        // Content overflowing by 60px, back at the start.
        act(() => { hook.getCurrent().onScroll(scrollEvent(0, 800, 860)); });
        expect(hook.getCurrent().visibility).toMatchObject({ left: false, right: true });
    });

    it('shows no fade when only the end gutter overflows', () => {
        const hook = renderFades({
            enabledEdges: { left: true, right: true },
            overflowThreshold: 8,
            edgeThreshold: 2,
            contentEndInset: 24,
        });
        act(() => {
            hook.getCurrent().onViewportLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 40 } } } as unknown as LayoutChangeEvent);
            hook.getCurrent().onScroll(scrollEvent(0, 800, 820));
        });
        expect(hook.getCurrent().visibility).toMatchObject({ left: false, right: false });
        expect(hook.getCurrent().canScrollX).toBe(false);
    });
});

describe('useScrollEdgeFades identity', () => {
    it('hands consumers the same handle across renders that report nothing new, so effects keyed on it do not re-run', () => {
        let current!: ReturnType<typeof useScrollEdgeFades>;
        function Harness(props: Readonly<{ tick: number }>) {
            current = useScrollEdgeFades({ enabledEdges: { left: true, right: true } });
            return React.createElement('div', null, props.tick);
        }
        let tree!: renderer.ReactTestRenderer;
        act(() => { tree = renderer.create(React.createElement(Harness, { tick: 0 })); });
        const first = current;
        act(() => { tree.update(React.createElement(Harness, { tick: 1 })); });
        expect(current).toBe(first);
    });
});
