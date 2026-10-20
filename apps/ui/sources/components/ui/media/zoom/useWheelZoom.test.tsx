import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { useWheelZoom } from './useWheelZoom.web';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

class WheelTarget extends EventTarget {
    getBoundingClientRect() { return { left: 10, top: 20, width: 400, height: 200 }; }
}

function wheel(target: WheelTarget, props: Record<string, unknown>) {
    const event = Object.assign(new Event('wheel', { cancelable: true }), {
        deltaX: 0, deltaY: 0, deltaMode: 0, clientX: 210, clientY: 120, ctrlKey: false, metaKey: false,
    }, props);
    target.dispatchEvent(event);
    return event;
}

describe('web wheel zoom boundary', () => {
    it('anchors pinch-wheel to the pointer, pans plain wheel only when zoomed, and detaches on unmount', async () => {
        const target = new WheelTarget();
        const onZoom = vi.fn();
        const onPan = vi.fn();
        let zoomed = false;
        function Harness() {
            useWheelZoom({ current: target }, { onZoom, onPan, isZoomed: () => zoomed });
            return null;
        }
        const screen = await renderScreen(<Harness />);
        expect(wheel(target, { deltaY: 100 }).defaultPrevented).toBe(false);
        expect(onPan).not.toHaveBeenCalled();
        const pinch = wheel(target, { deltaY: -100, ctrlKey: true, clientX: 310 });
        expect(pinch.defaultPrevented).toBe(true);
        expect(onZoom).toHaveBeenCalledWith(Math.exp(100 / 150), { x: 100, y: 0 });
        zoomed = true;
        expect(wheel(target, { deltaX: 10, deltaY: 20 }).defaultPrevented).toBe(true);
        expect(onPan).toHaveBeenCalledWith({ x: -10, y: -20 });
        wheel(target, { deltaX: 1, deltaY: 1, deltaMode: 2 });
        expect(onPan).toHaveBeenLastCalledWith({ x: -400, y: -200 });
        await act(async () => screen.unmount());
        expect(wheel(target, { deltaY: 30, metaKey: true }).defaultPrevented).toBe(false);
        expect(onZoom).toHaveBeenCalledTimes(1);
    });
});
