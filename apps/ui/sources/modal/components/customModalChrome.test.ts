import { describe, expect, it } from 'vitest';
import { areChromeConfigsEqual, mergeChromeConfig, resolveCustomModalPresentation } from './customModalChrome';

describe('custom modal chrome ownership', () => {
    it.each(['phone', 'tablet'] as const)('lets a media stage own its fullscreen presentation on %s', device => {
        expect(resolveCustomModalPresentation({ kind: 'stage', title: 'Photo' }, device)).toMatchObject({
            card: null, placement: 'fullscreen', scrollHost: 'body', showBackdrop: false, motion: 'none',
        });
    });
    it('merges a stage update without losing its anchor and recognizes stable chrome', () => {
        const merged = mergeChromeConfig({ kind: 'stage', title: 'First', testID: 'gallery' }, { kind: 'stage', title: 'Second' });
        expect(merged).toEqual({ kind: 'stage', title: 'Second', testID: 'gallery' });
        expect(areChromeConfigsEqual(merged, { kind: 'stage', title: 'Second', testID: 'gallery' })).toBe(true);
        expect(areChromeConfigsEqual(merged, { kind: 'stage', title: 'Third', testID: 'gallery' })).toBe(false);
        expect(areChromeConfigsEqual(merged, { kind: 'card', title: 'Second', testID: 'gallery' })).toBe(false);
    });
});
