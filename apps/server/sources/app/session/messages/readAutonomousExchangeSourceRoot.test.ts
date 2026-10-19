import { describe, expect, it } from 'vitest';

import { readAutonomousExchangeSourceRoot } from './readAutonomousExchangeSourceRoot';

describe('autonomous exchange source root', () => {
    it('never treats an Execution Run input as a Session Turn cause when their turn IDs collide', () => {
        expect(readAutonomousExchangeSourceRoot({
            sourceSessionId: 'source', actorAccountId: 'actor', expectedTurnId: 'shared-turn-id',
            sourceInputs: [{ localId: 'run-input', acceptedTurnId: 'shared-turn-id',
                targetExecutionRunId: 'run-id', inputAdmissionReceipt: { v: 1,
                    issuer: 'authenticatedAccount', actorAccountId: 'actor', sessionRelationship: 'owner' },
                autonomousExchangeRootSessionId: null, autonomousExchangeRootLocalId: null }],
        })).toEqual({ status: 'unavailable' });
    });
});
