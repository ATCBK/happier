import { describe, expect, it } from 'vitest';

import type { NewSessionDraftProjection } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { projectMaterializedTemporaryComputerRecoveryCandidates } from './useMaterializedTemporaryComputerSessionRecovery';

const mutationId = '00000000-0000-4000-8000-000000000010';

function draftWithActivation(value: unknown, launchUserAttemptId?: string, draftId = 'draft-a'): NewSessionDraftProjection {
    return {
        draftId,
        document: {
            v: 2,
            composer: null,
            target: {
                kind: 'newSession',
                authoring: {
                    temporaryComputerActivationRef: { mutationId, value },
                },
            },
            extensions: {},
        },
        readView: null,
        status: 'clean',
        conflict: null,
        createdAt: 1,
        updatedAt: 2,
        localSupplement: launchUserAttemptId ? { launchUserAttemptId } : {},
    };
}

describe('projectMaterializedTemporaryComputerRecoveryCandidates', () => {
    it('projects only valid synchronized activation references and preserves the crash-stable launch identity', () => {
        const valid = draftWithActivation({
            v: 1,
            activationId: '00000000-0000-4000-8000-000000000001',
            createdOnDeviceLabel: 'MacBook',
            retainedFutureMetadata: true,
        }, 'attempt-a');
        const malformed = draftWithActivation({ v: 1, activationId: 'not-an-activation' }, undefined, 'draft-b');
        expect(projectMaterializedTemporaryComputerRecoveryCandidates([valid, malformed])).toEqual([{
            draftId: 'draft-a',
            activationId: '00000000-0000-4000-8000-000000000001',
            launchUserAttemptId: 'attempt-a',
        }]);
    });
});
