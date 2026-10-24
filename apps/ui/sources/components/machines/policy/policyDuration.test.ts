import { describe, expect, it } from 'vitest';

import { parseCustomGuardGrace, parseCustomGuardMinutes } from '../guard/guardPresentation';
import { parseCustomStorageDays } from '../storage/storageTidyChoices';
import { parseCustomSustainMinutes } from '../vitals/machineAlertsPresentation';
import { parsePolicyDuration } from './policyDuration';

describe('machine Custom duration input', () => {
    it('requires an explicit unit on every duration field', () => {
        for (const parse of [parseCustomGuardGrace, parseCustomGuardMinutes, parseCustomStorageDays, parseCustomSustainMinutes]) {
            expect(parse('5')).toBeNull();
            expect(parse('')).toBeNull();
        }
    });

    it('uses one unit grammar while preserving each field’s numeric unit and precision', () => {
        expect(parseCustomGuardMinutes('1.5 HOURS')).toBe(5_400_000);
        expect(parseCustomSustainMinutes('1,5 hours')).toBe(90);
        expect(parseCustomGuardGrace('0.5 min')).toBe(30_000);
        expect(parseCustomStorageDays('48 hours')).toBe(2);
        expect(parseCustomGuardGrace('0 s')).toBe(0);
        expect(parseCustomGuardMinutes('59 s')).toBeNull();
        expect(parseCustomGuardMinutes('1.001 min')).toBeNull();
        expect(parseCustomGuardGrace('1.001 s')).toBeNull();
        expect(parseCustomGuardGrace('0.9999999 s')).toBeNull();
    });

    it('keeps exact millisecond values without rounding decimal input or unsafe integers', () => {
        const parse = (raw: string) => parsePolicyDuration(raw, { unit: 'ms', minimum: 1000 });
        expect(parse('1.001 s')).toBe(1001);
        expect(parse('1001 milliseconds')).toBe(1001);
        expect(parse('1,001 seconds')).toBe(1001);
        expect(parse('0.016683333333333333 min')).toBeNull();
        expect(parse('999 ms')).toBeNull();
        expect(parse('9007199254740991 ms')).toBe(Number.MAX_SAFE_INTEGER);
        expect(parse('9007199254740992 ms')).toBeNull();
        expect(parse('1.00000000000000001 s')).toBeNull();
        expect(parse('5')).toBeNull();
    });

    it('retains the existing unit aliases', () => {
        for (const suffix of ['s', 'sec', 'secs', 'second', 'seconds', 'm', 'min', 'mins', 'minute', 'minutes', 'h', 'hour', 'hours', 'd', 'day', 'days']) {
            expect(parsePolicyDuration(`1 ${suffix}`, { unit: 'ms', minimum: 0 })).not.toBeNull();
        }
    });
});
