import { describe, expect, it } from 'vitest';
import { AtmosphereLookOverrideSchema } from './homeAtmosphere.js';

describe('authored Home atmosphere Strength', () => {
    it('preserves mix fractions and rejects out-of-domain or non-finite input', () => {
        for (const strength of [0, 0.5, 1]) {
            expect(AtmosphereLookOverrideSchema.parse({ strength })).toEqual({ strength });
        }
        for (const strength of [-0.5, 1.5, NaN, Infinity]) {
            expect(AtmosphereLookOverrideSchema.safeParse({ strength }).success).toBe(false);
        }
    });
});
