import { describe, expect, it } from 'vitest';

import { parseCheckInTurns, withNeverPause } from './coordinationCheckIn';

describe('coordination check-in value', () => {
    it('reads a typed count as a positive whole number and refuses anything else', () => {
        expect(parseCheckInTurns('7')).toBe(7);
        expect(parseCheckInTurns('7.9')).toBe(7);
        expect(parseCheckInTurns('0')).toBeNull();
        expect(parseCheckInTurns('-2')).toBeNull();
        expect(parseCheckInTurns('')).toBe(null);
    });

    it('maps Never pause to a null count and back to the remembered one', () => {
        expect(withNeverPause(true, 8)).toEqual({ afterTurns: null });
        expect(withNeverPause(false, 8)).toEqual({ afterTurns: 8 });
    });
});
