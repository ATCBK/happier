import { describe, expect, it } from 'vitest';

import { projectSetupReadinessLine } from './projectSetupReadinessLine';

describe('projectSetupReadinessLine', () => {
    it('says what the checkout’s setup producer reported, and nothing when setup is not needed or unreported', () => {
        const current = projectSetupReadinessLine({ kind: 'current', reviewedEffectDigest: 'd', completedAtMs: 1_700_000_000_000 });
        const unprepared = projectSetupReadinessLine({ kind: 'unprepared', reviewedEffectDigest: 'd' });
        const review = projectSetupReadinessLine({ kind: 'needsReview', code: 'setup_changed' });
        const unknown = projectSetupReadinessLine({ kind: 'unknown', code: 'machine_unreachable' });
        expect(current).toBeTruthy();
        // Each producer state reads differently: setup success is never inferred from anything else.
        expect(new Set([current, unprepared, review, unknown]).size).toBe(4);
        expect(projectSetupReadinessLine({ kind: 'notRequired', reviewedEffectDigest: 'd' })).toBeNull();
        expect(projectSetupReadinessLine(null)).toBeNull();
    });
});
