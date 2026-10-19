import { describe, expect, it } from 'vitest';
import { buildMessageUpdatedUpdate } from './eventPayloadBuilders';

describe('Follow batch message update projection', () => {
    it('publishes only derived accepted-start status and leaves private source facts out', () => {
        const now = new Date('2020-01-01T00:00:00.000Z');
        const row = {
            id: 'event-row', seq: 7, localId: 'session-follow-wake:batch-1',
            content: { t: 'encrypted', c: 'cipher' }, createdAt: now, updatedAt: now,
            acceptedTurnKind: 'followUp', acceptedTurnId: 'native-turn',
            turnStartWitnessId: 'native-turn',
            followWakeObservations: [{ sourceSessionId: 'private-source' }],
            autonomousExchangeRootSessionId: 'private-root-source',
            autonomousExchangeRootLocalId: 'private-root-local',
        };
        const payload = buildMessageUpdatedUpdate(row, 'destination', 9, 'update-1');
        expect(payload.body).toMatchObject({
            message: { followDeliveryProjection: { status: 'woke', reason: null } },
        });
        expect(JSON.stringify(payload)).not.toContain('private-source');
        expect(JSON.stringify(payload)).not.toContain('private-root-source');

        const noWitness = buildMessageUpdatedUpdate({ ...row, turnStartWitnessId: null }, 'destination', 10, 'update-2');
        expect(noWitness.body).toMatchObject({
            message: { followDeliveryProjection: { status: null, reason: null } },
        });
    });
});
