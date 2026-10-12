import { describe, expect, it } from 'vitest';
import { isAtmosphereMomentOn } from './atmosphereMoments';

describe('isAtmosphereMomentOn', () => {
    it('reads a stored switch and treats a missing one as on', () => {
        expect(isAtmosphereMomentOn({ qr: false }, 'qr')).toBe(false);
        expect(isAtmosphereMomentOn({ qr: false }, 'pairing')).toBe(true);
        expect(isAtmosphereMomentOn({}, 'themeSwitch')).toBe(true);
    });
});
