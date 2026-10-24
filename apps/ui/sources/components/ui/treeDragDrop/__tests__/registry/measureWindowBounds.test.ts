import { describe, expect, it } from 'vitest';

import { measureWindowBounds, measureTreeContentBounds, readWindowBounds, toTreeDropMeasurableRef } from '../../registry/measureWindowBounds';
import type { TreeDropMeasurableRef } from '../../registry/treeDropRegistryTypes';

describe('toTreeDropMeasurableRef', () => {
    it('measures the RN Web scroll node even when its native scroll ref returns itself', async () => {
        const node = {
            getNativeScrollRef: () => node,
            getBoundingClientRect() {
                return { x: 12, y: 34, width: 320, height: 56 };
            },
            measureInWindow: () => { throw new Error('DOM measurement must stay synchronous'); },
        };
        const ref = toTreeDropMeasurableRef({ getNativeScrollRef: () => node });
        expect(readWindowBounds(ref)).toEqual(node.getBoundingClientRect());
        await expect(measureWindowBounds(ref)).resolves.toEqual(node.getBoundingClientRect());
        // Session-tree registrations pass RN hosts directly to the measurement boundary.
        expect(readWindowBounds(node)).toEqual(node.getBoundingClientRect());
        await expect(measureWindowBounds(node)).resolves.toEqual(node.getBoundingClientRect());
    });

    it('retains real native measurement when a wrapper chain cycles', async () => {
        const first = { getNativeScrollRef: () => second };
        const second = {
            getNativeScrollRef: () => first,
            measureInWindow(callback: (x: number, y: number, width: number, height: number) => void) {
                callback(11, 22, 333, 44);
            },
        };
        await expect(measureWindowBounds(toTreeDropMeasurableRef(first))).resolves.toEqual({ x: 11, y: 22, width: 333, height: 44 });
    });

    it('terminates an unmeasurable cycle and allows a later valid ref to measure', () => {
        const first = { getNativeScrollRef: () => second };
        const second = { getNativeScrollRef: () => first };
        expect(toTreeDropMeasurableRef(first)).toBeNull();
        const node = { getBoundingClientRect: () => ({ x: 1, y: 2, width: 3, height: 4 }) };
        expect(readWindowBounds(toTreeDropMeasurableRef({ getNativeScrollRef: () => node }))).toEqual(node.getBoundingClientRect());
    });

    it('prefers the native scroll host over wrapper bounds and retains wrapper measurement while unmounted', async () => {
        const node = { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(1, 2, 3, 4) };
        const wrapper = {
            getNativeScrollRef: (): unknown => node,
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(5, 6, 7, 8),
        };
        await expect(measureWindowBounds(toTreeDropMeasurableRef(wrapper))).resolves.toEqual({ x: 1, y: 2, width: 3, height: 4 });
        wrapper.getNativeScrollRef = () => null;
        await expect(measureWindowBounds(toTreeDropMeasurableRef(wrapper))).resolves.toEqual({ x: 5, y: 6, width: 7, height: 8 });
    });

    it('preserves already normalized DOM refs and reads current bounds with the original receiver', () => {
        const node = {
            bounds: { x: 1, y: 2, width: 3, height: 4 },
            getBoundingClientRectFn() { return this.bounds; },
        };
        const ref = toTreeDropMeasurableRef(node);
        expect(readWindowBounds(ref)).toEqual(node.bounds);
        node.bounds = { x: 5, y: 6, width: 7, height: 8 };
        expect(readWindowBounds(ref)).toEqual(node.bounds);
    });
});

describe('measureWindowBounds', () => {
    it('publishes viewport metrics on the measurement clock before same-turn row conversion', async () => {
        let viewportTopY = 0;
        const viewport = measureWindowBounds({ measureInWindow: callback => callback(10, 100, 320, 600) } satisfies TreeDropMeasurableRef,
            bounds => { viewportTopY = bounds.y; });
        const row = measureTreeContentBounds({ measureInWindow: callback => callback(10, 300, 320, 40) } satisfies TreeDropMeasurableRef, () => ({
            viewportWindowX: 10, viewportWindowY: viewportTopY, viewportHeight: 600, scrollOffsetY: 200,
        }));
        await expect(viewport).resolves.toMatchObject({ y: 100 });
        await expect(row).resolves.toEqual({ x: 0, y: 400, width: 320, height: 40 });
    });

    it.each(['web', 'native'] as const)('pairs content conversion with the %s measurement clock, not Promise publication', async platform => {
        let offset = 200;
        let measurements = 0;
        let answer: ((x: number, y: number, width: number, height: number) => void) | undefined;
        const node = platform === 'web'
            ? { getBoundingClientRectFn: () => { measurements++; return { x: 10, y: 300, width: 320, height: 40 }; } }
            : { measureInWindow: (callback: NonNullable<typeof answer>) => { measurements++; answer = callback; } };
        const pending = measureTreeContentBounds(node, () => ({ viewportWindowX: 10, viewportWindowY: 100,
            viewportHeight: 600, scrollOffsetY: offset }));
        if (platform === 'native') {
            // Native layout arrives later: pair it with that callback's metrics, not request time.
            offset = 250;
            answer?.(10, 250, 320, 40);
        }
        offset = 0;
        await expect(pending).resolves.toEqual({ x: 0, y: 400, width: 320, height: 40 });
        expect(measurements).toBe(1);
    });

    it('reads window bounds synchronously from getBoundingClientRect when the ref exposes a DOM element', async () => {
        expect(measureWindowBounds).toEqual(expect.any(Function));

        // The web ref reads from the same DOM clock as scrollTop: no async lag.
        await expect(measureWindowBounds({
            getBoundingClientRectFn: () => ({ x: 12, y: 34, width: 320, height: 56 }),
        })).resolves.toEqual({ x: 12, y: 34, width: 320, height: 56 });
    });

    it('prefers the synchronous web path over the async measureInWindow fallback when both are present', async () => {
        let measureInWindowCalled = false;
        await expect(measureWindowBounds({
            getBoundingClientRectFn: () => ({ x: 1, y: 2, width: 3, height: 4 }),
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                measureInWindowCalled = true;
                callback(99, 99, 99, 99);
            },
        })).resolves.toEqual({ x: 1, y: 2, width: 3, height: 4 });
        expect(measureInWindowCalled).toBe(false);
    });

    it('falls back to the async native measureInWindow path when no DOM element is exposed', async () => {
        await expect(measureWindowBounds({
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                callback(11, 22, 333, 44);
            },
        })).resolves.toEqual({ x: 11, y: 22, width: 333, height: 44 });
    });

    it('rejects invalid bounds from the synchronous web path', async () => {
        await expect(measureWindowBounds({
            getBoundingClientRectFn: () => ({ x: Number.NaN, y: 34, width: 320, height: 56 }),
        })).resolves.toBeNull();
        await expect(measureWindowBounds({
            getBoundingClientRectFn: () => ({ x: 12, y: 34, width: -1, height: 56 }),
        })).resolves.toBeNull();
    });

    it('rejects invalid bounds from the async native path and never accepts layout-relative fallback bounds', async () => {
        await expect(measureWindowBounds({
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                callback(12, 34, Number.POSITIVE_INFINITY, 56);
            },
        })).resolves.toBeNull();

        const layoutOnlyRef: {
            measureInWindow?: undefined;
            measure: (callback: (x: number, y: number, width: number, height: number) => void) => void;
        } = {
            measure: (callback: (x: number, y: number, width: number, height: number) => void) => {
                callback(1, 2, 3, 4);
            },
        };
        await expect(measureWindowBounds(layoutOnlyRef)).resolves.toBeNull();
        await expect(measureWindowBounds(null)).resolves.toBeNull();
    });
});
