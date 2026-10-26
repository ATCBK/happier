import { afterEach, describe, expect, it, vi } from 'vitest';

import { isHappierTouchPrimaryPointer, resetHappierPrimaryPointerForTesting, resolveHappierHitInsets } from './interactiveTarget.js';

describe('the shared hit-area policy', () => {
  it('reaches the target past a small drawn box without asking it to grow', () => {
    expect(resolveHappierHitInsets({ width: 32, height: 32, target: 44 }))
      .toEqual({ top: 6, bottom: 6, left: 6, right: 6 });
  });

  it('splits a tight gap between neighbours instead of overlapping them', () => {
    // Two 24 px controls 4 px apart: each reaches 2 px toward the other and the full deficit elsewhere.
    const leading = resolveHappierHitInsets({ width: 24, height: 24, target: 44, reach: { right: 2 } });
    const trailing = resolveHappierHitInsets({ width: 24, height: 24, target: 44, reach: { left: 2 } });
    expect(leading).toEqual({ top: 10, bottom: 10, left: 10, right: 2 });
    expect(trailing).toEqual({ top: 10, bottom: 10, left: 2, right: 10 });
    expect(leading!.right + trailing!.left).toBeLessThanOrEqual(4);
  });

  it('extends nothing under a precise pointer, for a box already at the target, or on an unknown axis', () => {
    expect(resolveHappierHitInsets({ width: 24, height: 24, target: undefined })).toBeUndefined();
    expect(resolveHappierHitInsets({ width: 48, height: 44, target: 44 })).toBeUndefined();
    expect(resolveHappierHitInsets({ height: 32, target: 44 })).toEqual({ top: 6, bottom: 6, left: 0, right: 0 });
  });
});

describe('the primary pointer fact', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetHappierPrimaryPointerForTesting();
  });

  it('is a finger on a native touch platform and in a browser that cannot hover, never on a hovering desktop', () => {
    const media = (matching: readonly string[]) => (query: string) => ({ matches: matching.includes(query) });
    vi.stubGlobal('matchMedia', media(['(pointer: fine)', '(hover: hover)']));
    expect(isHappierTouchPrimaryPointer('web')).toBe(false);
    expect(isHappierTouchPrimaryPointer('ios')).toBe(true);
    expect(isHappierTouchPrimaryPointer('android')).toBe(true);

    resetHappierPrimaryPointerForTesting();
    vi.stubGlobal('matchMedia', media(['(pointer: coarse)', '(hover: none)']));
    expect(isHappierTouchPrimaryPointer('web')).toBe(true);
    expect(isHappierTouchPrimaryPointer(undefined)).toBe(true);
  });
});
