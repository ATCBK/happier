import { describe, expect, it } from 'vitest';

import { keepCarriedPreviewClear } from '../../ui/carriedPreviewClearance';

describe('keepCarriedPreviewClear', () => {
    const size = { width: 304, height: 96 };
    const clear = { x: 460, y: 820, width: 580, height: 160 };

    it('leaves a card that does not touch the kept-clear region where the pointer put it', () => {
        const placement = { left: 300, top: 200, side: 'right' as const };
        expect(keepCarriedPreviewClear({ placement, size, clear, viewport: { width: 1440, height: 1000 } })).toBe(placement);
        expect(keepCarriedPreviewClear({ placement, size, clear: null, viewport: { width: 1440, height: 1000 } })).toBe(placement);
    });

    it('lifts a card that would cover the region to sit above it, keeping its side and column', () => {
        // The pointer is inside the composer near the window's foot: the card flipped above the pointer and
        // covered the composer's own status row.
        const placement = { left: 720, top: 775, side: 'right' as const };
        const kept = keepCarriedPreviewClear({ placement, size, clear, viewport: { width: 1440, height: 1000 } });
        expect(kept.left).toBe(720);
        expect(kept.side).toBe('right');
        expect(kept.top + size.height).toBeLessThanOrEqual(clear.y);
    });

    it('goes below the region when there is no room above it, never off the window', () => {
        const placement = { left: 100, top: 20, side: 'right' as const };
        const kept = keepCarriedPreviewClear({ placement, size, clear: { x: 0, y: 40, width: 600, height: 80 }, viewport: { width: 1440, height: 1000 } });
        expect(kept.top).toBeGreaterThanOrEqual(120);
        expect(kept.top + size.height).toBeLessThanOrEqual(1000);
    });
});
