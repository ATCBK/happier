import { describe, expect, it } from 'vitest';

import { resolveHorizontalScrollEdgeMaskStyle, resolveVerticalScrollEdgeMaskStyle } from './resolveScrollEdgeMaskStyle';

describe('resolveVerticalScrollEdgeMaskStyle', () => {
    it('does not apply a mask when no vertical edge is visible', () => {
        expect(resolveVerticalScrollEdgeMaskStyle({
            top: false,
            bottom: false,
            left: false,
            right: false,
        })).toBeNull();
    });

    it('fades only the bottom edge when more content is below', () => {
        const style = resolveVerticalScrollEdgeMaskStyle({
            top: false,
            bottom: true,
            left: false,
            right: false,
        }, { fadeSize: 14 });

        expect(style?.maskImage).toContain('black 0px');
        expect(style?.maskImage).toContain('black calc(100% - 14px)');
        expect(style?.maskImage).toContain('transparent 100%');
        expect(style?.WebkitMaskImage).toBe(style?.maskImage);
    });

    it('fades only the top edge when content exists above', () => {
        const style = resolveVerticalScrollEdgeMaskStyle({
            top: true,
            bottom: false,
            left: false,
            right: false,
        }, { fadeSize: 14 });

        expect(style?.maskImage).toContain('transparent 0px');
        expect(style?.maskImage).toContain('black 14px');
        expect(style?.maskImage).toContain('black 100%');
    });

    it('fades both vertical edges when content exists above and below', () => {
        const style = resolveVerticalScrollEdgeMaskStyle({
            top: true,
            bottom: true,
            left: false,
            right: false,
        }, { fadeSize: 14 });

        expect(style?.maskImage).toBe(
            'linear-gradient(to bottom, transparent 0px, black 14px, black calc(100% - 14px), transparent 100%)',
        );
    });
});

describe('resolveHorizontalScrollEdgeMaskStyle', () => {
    it('fades the trailing edge of a rail with more chips to the right, and nothing when it fits', () => {
        expect(resolveHorizontalScrollEdgeMaskStyle({ top: false, bottom: false, left: false, right: false })).toBeNull();
        const style = resolveHorizontalScrollEdgeMaskStyle({ top: false, bottom: false, left: false, right: true }, { fadeSize: 24 });
        expect(style?.maskImage).toContain('to right');
        expect(style?.maskImage).toContain('black calc(100% - 24px)');
        expect(style?.maskImage).toContain('transparent 100%');
        expect(style?.maskImage).toContain('black 0px');
    });

    it('clips a rail between chips: solid up to the last whole chip, clear from the next, on either edge', () => {
        const end = resolveHorizontalScrollEdgeMaskStyle(
            { top: false, bottom: false, left: false, right: true },
            { fadeSize: 24, endClip: { solidUntilPx: 250, clearFromPx: 256 } },
        );
        expect(end?.maskImage).toBe('linear-gradient(to right, black 0px, black 0px, black 250px, transparent 256px)');

        const both = resolveHorizontalScrollEdgeMaskStyle(
            { top: false, bottom: false, left: true, right: true },
            { fadeSize: 24, startClip: { clearUntilPx: 20, solidFromPx: 26 }, endClip: { solidUntilPx: 250, clearFromPx: 256 } },
        );
        expect(both?.maskImage).toBe('linear-gradient(to right, transparent 20px, black 26px, black 250px, transparent 256px)');
    });

    it('ignores a clip for an edge that is not scrollable', () => {
        const style = resolveHorizontalScrollEdgeMaskStyle(
            { top: false, bottom: false, left: false, right: true },
            { fadeSize: 24, startClip: { clearUntilPx: 20, solidFromPx: 26 } },
        );
        expect(style?.maskImage).toContain('black 0px');
        expect(style?.maskImage).toContain('black calc(100% - 24px)');
    });
});
