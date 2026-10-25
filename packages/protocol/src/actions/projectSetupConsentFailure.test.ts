import { describe, expect, it } from 'vitest';
import { ProjectPrepareInputV1Schema, readProjectSetupConsentFailureV1, readProjectSetupConsentHoldV1 } from './projectActionFamily.js';

describe('Project setup requested human consent scope', () => {
    const workspace = { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/project' };

    it('binds retained consent or Skip to its operation and reviewed digest', () => {
        const request = { workspace, phase: 'setup', heldOperationId: 'original', expectedEffectDigest: 'reviewed' };
        expect(ProjectPrepareInputV1Schema.safeParse({ ...request, consentScope: 'thisTime' }).success).toBe(true);
        expect(ProjectPrepareInputV1Schema.safeParse({ ...request, skipForInvocation: true }).success).toBe(true);
        expect(ProjectPrepareInputV1Schema.safeParse(request).success).toBe(false);
        expect(ProjectPrepareInputV1Schema.safeParse({ ...request, expectedEffectDigest: undefined, consentScope: 'thisTime' }).success).toBe(false);
        expect(ProjectPrepareInputV1Schema.safeParse({ ...request, consentScope: 'untilChanged' }).success).toBe(true);
        expect(ProjectPrepareInputV1Schema.safeParse({ ...request, consentScope: 'untilChanged', skipForInvocation: true }).success).toBe(false);
    });

    it('requires the existing reviewed effect digest when requesting either consent scope, without accepting authority input', () => {
        for (const consentScope of ['thisTime', 'untilChanged']) {
            const request = { workspace, phase: 'setup', expectedEffectDigest: 'reviewed', consentScope,
                ...(consentScope === 'untilChanged' ? { heldOperationId: 'retained' } : {}) };
            expect(ProjectPrepareInputV1Schema.safeParse(request).success).toBe(true);
            expect(ProjectPrepareInputV1Schema.safeParse({ workspace, phase: 'setup', consentScope }).success).toBe(false);
            expect(ProjectPrepareInputV1Schema.safeParse({ ...request, authority: 'present_user' }).success).toBe(false);
        }
        expect(ProjectPrepareInputV1Schema.safeParse({ workspace, phase: 'setup', expectedEffectDigest: 'reviewed', consentScope: 'untilChanged' }).success).toBe(false);
        expect(ProjectPrepareInputV1Schema.safeParse({ workspace, phase: 'setup' }).success).toBe(true);
        expect(ProjectPrepareInputV1Schema.safeParse({ workspace, phase: 'setup', expectedEffectDigest: 'reviewed', consentScope: 'forever' }).success).toBe(false);
    });

    it('retains requested scope only on strict no-effect D18 review and its minimal human hold projection', () => {
        for (const consentScope of ['thisTime', 'untilChanged']) {
            const details = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed',
                reviewedEffect: { commands: ['echo reviewed'] }, consentScope };
            const failure = { ok: false, errorCode: details.code, error: details.code, details };
            expect(readProjectSetupConsentFailureV1(failure)).toMatchObject({ details });
            expect(readProjectSetupConsentHoldV1('projects.prepare', failure)).toEqual({ kind: 'pendingApproval',
                code: details.code, reviewedEffectDigest: details.reviewedEffectDigest, consentScope });
            expect(readProjectSetupConsentFailureV1({ ...failure, details: { ...details, authority: 'present_user' } })).toBeNull();
            expect(readProjectSetupConsentHoldV1('projects.compute.exec', { ...failure, errorCode: 'project_script_effect_changed' })).toBeNull();
        }
    });

    it.each(['session.spawn_new', 'execution.run.start', 'execution.run.ensure_or_start'])
    ('reads %s setup consent only from its exact original setup operation', actionId => {
        const review = { kind: 'pendingApproval', code: 'project_setup_consent_required',
            reviewedEffectDigest: 'reviewed', reviewedEffect: { commands: ['echo setup'] } };
        const operation = { version: 1, operationId: 'original', revision: 2, actionId,
            scope: { accountId: 'requester', machineId: 'machine' }, title: 'Launch', state: 'running',
            cancellation: 'supported', createdAt: 1, startedAt: 1, setupReview: review,
            domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: 'home', machineId: 'machine',
                workspaceRefId: 'workspace', cwd: '/project' } };
        expect(readProjectSetupConsentHoldV1(actionId, { operation })).toEqual({ kind: review.kind,
            code: review.code, reviewedEffectDigest: review.reviewedEffectDigest });
        expect(readProjectSetupConsentHoldV1(actionId, review)).toBeNull();
        expect(readProjectSetupConsentHoldV1(actionId, { operation: { ...operation, actionId: 'projects.prepare' } })).toBeNull();
        expect(readProjectSetupConsentHoldV1(actionId, { operation: { ...operation,
            domainRef: { ...operation.domainRef, purpose: 'script' } } })).toBeNull();
        expect(readProjectSetupConsentHoldV1(actionId, { operation: { ...operation, state: 'cancelled', settledAt: 2 } })).toBeNull();
    });
});
