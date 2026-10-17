import { describe, expect, it } from 'vitest';

import { HappyError } from '@/utils/errors/errors';
import { assertApprovalExecutionSucceeded } from './useApprovalDecisionHandler';

describe('approval decision execution outcome', () => {
    it('surfaces a recorded execution failure instead of accepting the decision as success', () => {
        const execution = {
            executedAtMs: 1,
            ok: false as const,
            errorCode: 'target_unavailable',
            error: 'Filesystem target is unavailable',
        };
        expect(() => assertApprovalExecutionSucceeded(execution)).toThrowError(HappyError);
        try {
            assertApprovalExecutionSucceeded(execution);
        } catch (error) {
            expect(error).toMatchObject({ code: 'target_unavailable', message: 'Filesystem target is unavailable' });
        }
    });
});
