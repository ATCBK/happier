import { describe, expect, it } from 'vitest';

import { resolveImageWellFit } from './resolveImageWellFit';

describe('resolveImageWellFit', () => {
    it('contains a photo without upscaling it', () => {
        expect(resolveImageWellFit({ imageWidth: 1200, imageHeight: 800, wellWidth: 600, wellHeight: 600 }))
            .toEqual({ width: 600, height: 400, scale: 0.5, pixelated: false });
        expect(resolveImageWellFit({ imageWidth: 120, imageHeight: 80, wellWidth: 600, wellHeight: 600 }).scale).toBe(1);
    });

    it('uses a fitting integer scale for tiny images, with four times as its ceiling', () => {
        expect(resolveImageWellFit({ imageWidth: 32, imageHeight: 64, wellWidth: 120, wellHeight: 220 }))
            .toEqual({ width: 96, height: 192, scale: 3, pixelated: true });
        expect(resolveImageWellFit({ imageWidth: 16, imageHeight: 16, wellWidth: 600, wellHeight: 600 }).scale).toBe(4);
        expect(resolveImageWellFit({ imageWidth: 65, imageHeight: 32, wellWidth: 600, wellHeight: 600 }).scale).toBe(1);
    });

    it('still contains tiny images when their well is smaller than natural size', () => {
        expect(resolveImageWellFit({ imageWidth: 32, imageHeight: 64, wellWidth: 20, wellHeight: 20 }))
            .toEqual({ width: 10, height: 20, scale: 0.3125, pixelated: true });
    });

    it('keeps an unmeasured well empty rather than producing invalid dimensions', () => {
        expect(resolveImageWellFit({ imageWidth: 0, imageHeight: 64, wellWidth: 100, wellHeight: 100 }))
            .toEqual({ width: 0, height: 0, scale: 0, pixelated: false });
    });
});
