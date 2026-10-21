import { describe, expect, it } from 'vitest';

import { resolveBrowseProjectionFailureCopy } from './browseProjectionFailureCopy';

describe('resolveBrowseProjectionFailureCopy', () => {
    const titleFor = (failureReason?: Parameters<typeof resolveBrowseProjectionFailureCopy>[0]['failureReason']) =>
        resolveBrowseProjectionFailureCopy({ phase: 'error', failureReason, machineName: 'Devin box' }).title;

    it('chooses a distinct next step for each class of typed failure', () => {
        const titles = new Set([
            titleFor('transport-error'),
            titleFor('update-required'),
            titleFor('access-denied'),
            titleFor('invalid-response'),
        ]);
        expect(titles.size).toBe(4);
        expect(titleFor('timeout')).toBe(titleFor('request-failed'));
        expect(titleFor('authentication-required')).toBe(titleFor('access-denied'));
        expect(titleFor(undefined)).toBe(titleFor('error'));
    });

    it('never claims the Machine has nothing, names it, and keeps the typed reason out of the sentence', () => {
        const copy = resolveBrowseProjectionFailureCopy({ phase: 'error', failureReason: 'access-denied', machineName: null });
        expect(copy.title).toContain('this machine');
        expect(`${copy.title} ${copy.reason}`).not.toContain('access-denied');
        expect(copy.diagnosticCode).toBe('access-denied');
        expect(`${copy.title} ${copy.reason}`.toLowerCase()).not.toContain('no integrations');
    });

    it('treats an unsupported daemon as needing an update', () => {
        const copy = resolveBrowseProjectionFailureCopy({ phase: 'unsupported', machineName: 'Devin box' });
        expect(copy.title).toBe(titleFor('update-required'));
    });
});
