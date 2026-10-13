import { describe, expect, it } from 'vitest';
import { EntityDropOutcomeV1Schema } from '@happier-dev/protocol/plugins/ui';
import { projectSessionReportsToSourceKeyPreparationV1 } from '@happier-dev/protocol/sessions/relations/sessionReportsToV1';
import { projectActionOutcome } from './sessionListActionOutcome';

describe('Session list Action outcomes', () => {
    it('preserves a committed reports-to edge as applied while source-key readiness waits', () => {
        const committed = { ok: true, sessionId: 'child', leadSessionId: 'lead', attachedAt: 1 } as const;
        const waiting = projectSessionReportsToSourceKeyPreparationV1(committed,
            { kind: 'waiting', reason: 'source_key_unavailable' });
        const outcome = projectActionOutcome('session.reports_to.set', { ok: true, result: waiting });
        expect(outcome).toEqual({ status: 'applied' });
        expect(EntityDropOutcomeV1Schema.parse(outcome)).toEqual(outcome);
        expect(projectActionOutcome('session.reports_to.set', {
            ok: false, errorCode: 'request_failed', error: 'request_failed',
        }).status).toBe('unknown');
    });
});
