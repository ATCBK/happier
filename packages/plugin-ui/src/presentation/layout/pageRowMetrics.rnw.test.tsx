import { describe, expect, it } from 'vitest';

import { resolveHappierRowTitleMetaPlacement } from './pageRowMetrics.js';

describe('resolveHappierRowTitleMetaPlacement', () => {
    it('keeps the meta on the title line while the title keeps its minimum beside it', () => {
        expect(resolveHappierRowTitleMetaPlacement({ rowContentWidthPx: 400, titleNaturalWidthPx: 300, metaNaturalWidthPx: 90, titleMinWidthPx: 120 })).toBe('inline');
        // The title gives way (truncates) before the meta moves: 400 − 90 leaves the title more than its minimum.
        expect(resolveHappierRowTitleMetaPlacement({ rowContentWidthPx: 400, titleNaturalWidthPx: 380, metaNaturalWidthPx: 90, titleMinWidthPx: 120 })).toBe('inline');
    });

    it('moves the meta beneath when it would squeeze the title under its minimum, and never truncates it', () => {
        expect(resolveHappierRowTitleMetaPlacement({ rowContentWidthPx: 240, titleNaturalWidthPx: 200, metaNaturalWidthPx: 150, titleMinWidthPx: 120 })).toBe('beneath');
        // A short title takes only its own width; the meta still fits whole beside it.
        expect(resolveHappierRowTitleMetaPlacement({ rowContentWidthPx: 240, titleNaturalWidthPx: 60, metaNaturalWidthPx: 150, titleMinWidthPx: 120 })).toBe('inline');
        // Unmeasured rows never claim a width they have not seen.
        expect(resolveHappierRowTitleMetaPlacement({ rowContentWidthPx: 0, titleNaturalWidthPx: 0, metaNaturalWidthPx: 0, titleMinWidthPx: 120 })).toBe('inline');
    });
});
