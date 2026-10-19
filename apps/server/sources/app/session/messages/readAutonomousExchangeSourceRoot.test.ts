import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '@/storage/inTx';

import { readAutonomousExchangeSourceRoot, readReceiverAutonomousExchangeRootInTx } from './readAutonomousExchangeSourceRoot';

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

    it.each([true, false])('selects only the receiver person root for Run wake, not a later inherited agent root (person: %s)', async hasPerson => {
        // Database boundary: the latest user-role row is an agent continuation,
        // followed by the older protected person input (or no person input).
        const findFirst = vi.fn().mockResolvedValueOnce({ seq: 2, localId: 'agent-input',
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
            autonomousExchangeRootSessionId: 'another-session', autonomousExchangeRootLocalId: 'foreign-root' })
            .mockResolvedValueOnce(hasPerson ? { seq: 1, localId: 'person-input',
                inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'receiver-account', sessionRelationship: 'owner' },
                autonomousExchangeRootSessionId: null, autonomousExchangeRootLocalId: null } : null);
        const tx = { sessionMessage: { findFirst } } as unknown as Tx;
        expect(await readReceiverAutonomousExchangeRootInTx(tx, { accountId: 'receiver-account', sessionId: 'receiver-session',
            selection: 'latest_person' })).toEqual(hasPerson ? { sessionId: 'receiver-session', localId: 'person-input' } : null);
    });
});
