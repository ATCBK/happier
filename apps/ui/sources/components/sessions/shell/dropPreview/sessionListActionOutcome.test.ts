import { describe, expect, it } from 'vitest';
import { EntityDropOutcomeV1Schema } from '@happier-dev/protocol/plugins/ui';
import { projectSessionManagerSourceKeyPreparationV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { projectActionOutcome } from './sessionListActionOutcome';
import { t } from '@/text';

describe('Session list Action outcomes', () => {
    it('uses the generic denial for a non-relation Action scope refusal', () => {
        expect(projectActionOutcome('session.organization.move', {
            ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied',
        })).toEqual({ status: 'refused', reason: { code: 'credential_scope_denied', message: t('errors.permissionDenied') } });
    });
    it('keeps a credential scope refusal definite and uses the existing manager denial notice', () => {
        const scope = projectActionOutcome('session.manager.set', {
            ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied',
        });
        const forbidden = projectActionOutcome('session.manager.set', {
            ok: false, errorCode: 'manager_forbidden', error: 'manager_forbidden',
        });
        expect(scope.status).toBe('refused');
        if (scope.status !== 'refused' || forbidden.status !== 'refused') throw new Error('Expected definite refusals');
        expect(scope.reason?.message).toBe(forbidden.reason?.message);
    });
    it('preserves a committed manager edge as applied while source-key readiness waits', () => {
        const committed = { ok: true, sessionId: 'child', managerSessionId: 'lead', attachedAt: 1 } as const;
        const waiting = projectSessionManagerSourceKeyPreparationV1(committed,
            { kind: 'waiting', reason: 'source_key_unavailable' });
        const outcome = projectActionOutcome('session.manager.set', { ok: true, result: waiting });
        expect(outcome).toEqual({ status: 'applied' });
        expect(EntityDropOutcomeV1Schema.parse(outcome)).toEqual(outcome);
        expect(projectActionOutcome('session.manager.set', {
            ok: false, errorCode: 'request_failed', error: 'request_failed',
        }).status).toBe('unknown');
    });
});
