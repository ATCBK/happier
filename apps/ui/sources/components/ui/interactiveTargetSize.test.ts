import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadWithPrimaryPointer(pointer: 'fine' | 'coarse') {
    vi.resetModules();
    vi.stubGlobal('window', {
        matchMedia: (query: string) => ({
            matches: pointer === 'fine'
                ? query === '(pointer: fine)' || query === '(hover: hover)'
                : query === '(pointer: coarse)' || query === '(hover: none)',
        }),
    });
    return await import('./interactiveTargetSize');
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('resolveMinimumInteractiveTargetSize', () => {
    it('keeps the platform touch floor on native, with the stricter Android target', async () => {
        const { resolveMinimumInteractiveTargetSize } = await loadWithPrimaryPointer('fine');
        expect(resolveMinimumInteractiveTargetSize('ios')).toBe(44);
        expect(resolveMinimumInteractiveTargetSize('android')).toBe(48);
    });

    it('takes the touch floor on a web host whose primary pointer is a finger', async () => {
        const { resolveMinimumInteractiveTargetSize } = await loadWithPrimaryPointer('coarse');
        expect(resolveMinimumInteractiveTargetSize('web')).toBe(44);
    });

    it('keeps a precise pointer at the WCAG 2.2 pointer floor, so controls stay their drawn size', async () => {
        const { resolveMinimumInteractiveTargetSize, resolveTouchTargetFloorPx } = await loadWithPrimaryPointer('fine');
        expect(resolveMinimumInteractiveTargetSize('web')).toBe(24);
        expect(resolveTouchTargetFloorPx('web')).toBeNull();
    });
});
