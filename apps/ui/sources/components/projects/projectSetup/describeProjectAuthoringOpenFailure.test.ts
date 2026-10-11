import { describe, expect, it } from 'vitest';

import { describeProjectAuthoringOpenFailure } from './describeProjectAuthoringOpenFailure';

describe('describeProjectAuthoringOpenFailure', () => {
    it.each([
        ['stale', 'projects.authoring.stale', 'reopen'],
        ['offline', 'projects.authoring.offline', 'choose_target'],
        ['refused', 'projects.authoring.refused', 'choose_target'],
        ['unavailable', 'projects.authoring.unavailable', 'open_client'],
        ['pending', 'projects.authoring.pending', 'await_approval'],
        ['invalid', 'projects.authoring.invalid', 'edit_request'],
        ['empty', 'projects.authoring.empty', 'choose_target'],
    ] as const)('describes %s without losing its recovery', (reason, titleKey, recovery) => {
        expect(describeProjectAuthoringOpenFailure(reason)).toEqual({ titleKey, recovery });
    });

    it.each(['project_authoring_failed', 'project_authoring_invalid_result', 'future_failure', null, undefined])('keeps an unknown failure generic (%s)', (reason) => {
        expect(describeProjectAuthoringOpenFailure(reason)).toEqual({
            titleKey: 'projects.authoring.error', recovery: 'reopen',
        });
    });

});
