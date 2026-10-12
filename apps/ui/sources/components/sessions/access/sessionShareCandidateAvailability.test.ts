import { describe, expect, it } from 'vitest';

import { resolveHasSessionShareCandidates } from './sessionShareCandidateAvailability';

describe('resolveHasSessionShareCandidates', () => {
    it('hides sharing when neither the Teams nor people owner has a candidate', () => {
        expect(resolveHasSessionShareCandidates({ teamCount: 0, personCount: 0 })).toBe(false);
    });

    it('exposes sharing when either existing candidate owner has someone to share with', () => {
        expect(resolveHasSessionShareCandidates({ teamCount: 1, personCount: 0 })).toBe(true);
        expect(resolveHasSessionShareCandidates({ teamCount: 0, personCount: 1 })).toBe(true);
    });
});
