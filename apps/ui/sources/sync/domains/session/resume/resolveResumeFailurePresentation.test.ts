import { describe, expect, it } from 'vitest';
import { resolveResumeFailurePresentation } from './resolveResumeFailurePresentation';

describe('session resume failure presentation', () => {
    it('offers explicit private-folder recovery instead of a modal failure', () => {
        expect(resolveResumeFailurePresentation({
            errorCode: 'SESSION_DIRECTORY_MISSING', errorMessage: 'Machine-private diagnostic path',
        }, 'Resume failed')).toEqual({ kind: 'directory_missing' });
    });

    it('keeps validation diagnostics out of generic resume alerts', () => {
        expect(resolveResumeFailurePresentation({
            errorCode: 'SPAWN_VALIDATION_FAILED', errorMessage: 'Private validation details',
        }, 'Resume failed')).toEqual({ kind: 'alert', message: 'Resume failed', errorCode: 'SPAWN_VALIDATION_FAILED' });
    });

    it('retains the original Action refusal code for deliberate Technical details', () => {
        // This is the existing Action normalizer's result for the typed Home carrier refusal;
        // the recovery surface must not throw away the code while retaining only its prose.
        expect(resolveResumeFailurePresentation({
            errorCode: 'action_failed', errorMessage: 'No verified transport is available for the target Home',
        }, 'Resume failed')).toEqual({
            kind: 'alert', message: 'No verified transport is available for the target Home', errorCode: 'action_failed',
        });
    });
});
