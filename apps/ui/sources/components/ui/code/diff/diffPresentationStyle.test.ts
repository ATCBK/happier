import { describe, expect, it } from 'vitest';

import { resolveEffectiveDiffPresentation, resolveProseDiffPresentation } from './diffPresentationStyle';

describe('diff presentation', () => {
    it('keeps prose two-sided where a code split would be unified, and stacks it below the prose minimum', () => {
        expect(resolveEffectiveDiffPresentation({ preference: 'split', availableWidthPx: 700 }).style).toBe('unified');
        expect(resolveProseDiffPresentation(700)).toBe('split');
        expect(resolveProseDiffPresentation(390)).toBe('unified');
        expect(resolveProseDiffPresentation(null)).toBe('split');
    });

    it('leaves the code split rule unchanged', () => {
        expect(resolveEffectiveDiffPresentation({ preference: 'split', availableWidthPx: 1200 }).style).toBe('split');
        expect(resolveEffectiveDiffPresentation({ preference: 'unified', availableWidthPx: 1200 }).style).toBe('unified');
    });
});
