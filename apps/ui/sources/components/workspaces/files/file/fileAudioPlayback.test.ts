import { describe, expect, it } from 'vitest';

import { clampFileAudioSeek } from './fileAudioPlayback';

describe('file audio seek', () => {
    it('clamps seconds to the loaded duration and refuses non-finite positions', () => {
        expect(clampFileAudioSeek(80, 30)).toBe(30);
        expect(clampFileAudioSeek(-5, 30)).toBe(0);
        expect(clampFileAudioSeek(12.5, 30)).toBe(12.5);
        expect(clampFileAudioSeek(NaN, 30)).toBe(0);
        expect(clampFileAudioSeek(12, Infinity)).toBe(0);
    });
});
