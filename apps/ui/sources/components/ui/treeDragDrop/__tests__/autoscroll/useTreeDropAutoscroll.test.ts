import { describe, expect, it } from 'vitest';

import { resolveTreeDropAutoscrollTarget } from '../../autoscroll/useTreeDropAutoscroll';

describe('useTreeDropAutoscroll', () => {
    it.each([
        { pointerY: 300, contentHeight: 0 },
        { pointerY: 300, contentHeight: 450 },
        { pointerY: 95, contentHeight: 1000 },
        { pointerY: 505, contentHeight: 1000 },
        { pointerY: 105, contentHeight: 0 },
        { pointerY: 495, contentHeight: Number.NaN },
        { pointerY: 495, viewportHeight: 0 },
        { pointerY: 495, viewportTopY: Number.NaN },
        { pointerY: 495, viewportHeight: Number.POSITIVE_INFINITY },
    ])('does not scroll away from the current position without a measured in-viewport edge: %j', (overrides) => {
        expect(resolveTreeDropAutoscrollTarget({
            viewportTopY: 100,
            viewportHeight: 400,
            scrollOffsetY: 250,
            contentHeight: 1000,
            ...overrides,
        })).toBe(250);
    });

    it('computes bounded upward and downward scroll targets from edge bands', async () => {
        expect(resolveTreeDropAutoscrollTarget).toEqual(expect.any(Function));

        expect(resolveTreeDropAutoscrollTarget({
            pointerY: 105,
            viewportTopY: 100,
            viewportHeight: 400,
            scrollOffsetY: 100,
            contentHeight: 1000,
            edgeBandPx: 60,
            maxScrollPerFrame: 14,
        })).toBeLessThan(100);

        expect(resolveTreeDropAutoscrollTarget({
            pointerY: 495,
            viewportTopY: 100,
            viewportHeight: 400,
            scrollOffsetY: 100,
            contentHeight: 1000,
            edgeBandPx: 60,
            maxScrollPerFrame: 14,
        })).toBeGreaterThan(100);

        expect(resolveTreeDropAutoscrollTarget({
            pointerY: 300,
            viewportTopY: 100,
            viewportHeight: 400,
            scrollOffsetY: 100,
            contentHeight: 1000,
            edgeBandPx: 60,
            maxScrollPerFrame: 14,
        })).toBe(100);

        expect(resolveTreeDropAutoscrollTarget({
            pointerY: 105, viewportTopY: 100, viewportHeight: 400,
            scrollOffsetY: 1, contentHeight: 1000,
        })).toBe(0);
        expect(resolveTreeDropAutoscrollTarget({
            pointerY: 495, viewportTopY: 100, viewportHeight: 400,
            scrollOffsetY: 599, contentHeight: 1000,
        })).toBe(600);
    });
});
