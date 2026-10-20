import { describe, expect, it } from 'vitest';

import { indexFollowDeliveryByLocalId, projectWorkerCardDelivery } from './followWorkerCardDelivery';

describe('worker card Follow delivery', () => {
    it('uses only the exact accepted original or wake-batch message and retains all four observed states', () => {
        const byLocalId = indexFollowDeliveryByLocalId({
            queued: { localId: 'input-queued', followDeliveryProjection: { status: 'queued', reason: 'held' } },
            next: { localId: 'input-next', followDeliveryProjection: { status: 'next_turn', reason: null } },
            woke: { localId: 'session-follow-wake:batch', followDeliveryProjection: { status: 'woke', reason: null } },
            answered: { localId: 'input-answered', followDeliveryProjection: { status: 'answered', reason: null } },
        });
        expect(projectWorkerCardDelivery({ followInputLocalId: 'input-queued' }, byLocalId)).toEqual({ status: 'queued', reason: 'held' });
        expect(projectWorkerCardDelivery({ followInputLocalId: 'input-next' }, byLocalId)).toEqual({ status: 'next_turn', reason: null });
        expect(projectWorkerCardDelivery({ followWakeEventLocalId: 'session-follow-wake:batch' }, byLocalId)).toEqual({ status: 'woke', reason: null });
        expect(projectWorkerCardDelivery({ followInputLocalId: 'input-answered' }, byLocalId)).toEqual({ status: 'answered', reason: null });
        // A card for an original in the same wake batch retains that original's outcome.
        expect(projectWorkerCardDelivery({ followInputLocalId: 'input-next', followWakeEventLocalId: 'session-follow-wake:batch' }, byLocalId))
            .toEqual({ status: 'next_turn', reason: null });
    });

    it('does not convert an absent or conflicting receipt into delivered', () => {
        const byLocalId = indexFollowDeliveryByLocalId({
            first: { localId: 'input', followDeliveryProjection: { status: 'woke', reason: null } },
            conflicting: { localId: 'input', followDeliveryProjection: { status: 'next_turn', reason: null } },
            unrelated: { localId: 'other', followDeliveryProjection: { status: 'answered', reason: null } },
        });
        expect(projectWorkerCardDelivery({ followInputLocalId: 'input' }, byLocalId)).toEqual({ status: null, reason: null });
        expect(projectWorkerCardDelivery({ followInputLocalId: 'missing' }, byLocalId)).toEqual({ status: null, reason: null });
        expect(projectWorkerCardDelivery({}, byLocalId)).toEqual({ status: null, reason: null });
    });
});
