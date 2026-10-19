import { describe, expect, it } from 'vitest';
import { doesManagedNativeObservationSettleIntent } from './managedNativeObservation';

describe('retained native effect observation settlement', () => {
    it('requires fresh definite power, even when the old desired power did not happen', () => {
        const previous = { observedAt: 10, availability: 'present', power: 'stopped' } as const;
        expect(doesManagedNativeObservationSettleIntent('start', { ...previous, observedAt: 20 }, previous)).toBe(true);
        expect(doesManagedNativeObservationSettleIntent('start', previous, previous)).toBe(false);
        expect(doesManagedNativeObservationSettleIntent('start', { ...previous, observedAt: 9 }, previous)).toBe(false);
        expect(doesManagedNativeObservationSettleIntent('start', { ...previous, observedAt: 20, power: 'unknown' }, previous)).toBe(false);
        expect(doesManagedNativeObservationSettleIntent('start', { observedAt: 20, availability: 'unavailable' }, previous)).toBe(false);
        expect(doesManagedNativeObservationSettleIntent('start', { observedAt: 20, availability: 'absent' }, previous)).toBe(true);
    });
    it('requires absence for Delete and a bound replacement for Rebuild', () => {
        const present = { observedAt: 20, availability: 'present', power: 'stopped' } as const;
        expect(doesManagedNativeObservationSettleIntent('delete', present)).toBe(false);
        expect(doesManagedNativeObservationSettleIntent('delete', { observedAt: 20, availability: 'absent' })).toBe(true);
        expect(doesManagedNativeObservationSettleIntent('rebuild', present)).toBe(false);
        expect(doesManagedNativeObservationSettleIntent('rebuild', { observedAt: 20, availability: 'absent' })).toBe(false);
    });
});
