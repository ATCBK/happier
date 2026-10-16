import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { PROJECT_TRUST_ROUTE_V1, ProjectTrustMutationRequestV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

// Only Home HTTP, device credentials and disconnected sockets are boundaries.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
const { Modal } = await import('@/modal');
let serverId: string;
const project = { serverId: 'foreign-project-home', projectId: 'qualified-project' };
const value = { project, reviewedEffectDigest: 'reviewed-effect', approvedAtMs: 17 };
const listPath = `${PROJECT_TRUST_ROUTE_V1}/list`;
const readPath = `${PROJECT_TRUST_ROUTE_V1}/read`;
const mutatePath = `${PROJECT_TRUST_ROUTE_V1}/mutate`;
beforeEach(async () => {
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(false);
    await homes.reset(); await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Approving Account', serverUrl: 'https://trust-approving.test', accountId: 'approver', active: false });
    await homes.addHome({ name: 'Focused custodian', serverUrl: 'https://trust-custodian.test', accountId: 'custodian' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    homes.answer(serverId, listPath, { body: { rows: [{ project, revision: 4, content: { t: 'plain', v: value } }] } });
    homes.answer(serverId, readPath, { body: { status: 'present', revision: 4, content: { t: 'plain', v: value } } });
    homes.answer(serverId, mutatePath, { select: input => {
        expect(ProjectTrustMutationRequestV1Schema.parse(input)).toEqual({ project, expectedRevision: 4, content: null });
        return { body: { status: 'updated', revision: 5, cursor: 1 } };
    } });
});
afterEach(async () => { await homes.reset(); });

describe('Project Trust through the canonical UI Action policy', () => {
    it.each(['decline', 'approve', 'waived', 'required', 'confirmed', 'unrelatedConfirmation'] as const)(
        'uses the configurable declared-danger default through the real UI front door (%s)', async mode => {
            vi.mocked(Modal.confirm).mockResolvedValue(mode === 'approve');
            if (mode === 'waived') homes.answer(serverId, '/v2/account/settings', { body: {
                version: 1, content: { t: 'plain', v: { actionsSettingsV1: { v: 1,
                    approvalWaivedSurfaces: { 'projects.trust.revoke': ['ui'] } } } },
            } });
            if (mode === 'required') {
                await homes.requireUiApproval(serverId, 'projects.trust.revoke');
                homes.answer(serverId, '/v2/account/settings', { body: { version: 2, content: { t: 'plain', v: {
                    actionsSettingsV1: { v: 1, actions: { 'projects.trust.revoke': { approvalRequiredSurfaces: ['ui'] } },
                        approvalWaivedSurfaces: { 'projects.trust.revoke': ['ui'] } },
                } } } });
            }
            const actionId = 'projects.trust.revoke' as const;
            const spec = getActionSpec(actionId);
            expect(spec.safety).toBe('danger');
            expect(spec.safetyForInput).toBeUndefined();
            const result = await createFrontDoorActionExecute()(actionId, {
                project, expectedRevision: 4, expectedEffectDigest: value.reviewedEffectDigest,
            }, { serverId, expectedAccountId: 'approver', surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                ...(mode === 'confirmed' || mode === 'required' ? { presentUserConfirmation: { actionId } }
                    : mode === 'unrelatedConfirmation' ? { presentUserConfirmation: { actionId: 'projects.prepare' as const } } : {}),
            });
            if (mode === 'required') {
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId } });
                expect(homes.requestsFor(mutatePath)).toEqual([]);
            } else if (mode === 'decline' || mode === 'unrelatedConfirmation') {
                expect(result).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
                expect(homes.requestsFor(mutatePath)).toEqual([]);
            } else {
                expect(result).toEqual({ ok: true, result: { project, status: 'removed' } });
                if (!spec.outputSchema) throw new Error('Project Trust must declare an output schema');
                if (result.ok) expect(spec.outputSchema.parse(result.result)).toEqual(result.result);
                expect(homes.requestsFor(mutatePath)).toHaveLength(1);
            }
            expect(Modal.confirm).toHaveBeenCalledTimes(['decline', 'approve', 'unrelatedConfirmation'].includes(mode) ? 1 : 0);
        },
    );
    it('lists the requester Account at its explicit Home, never the qualified Project custodian or focused Account', async () => {
        expect(await createDefaultActionExecutor().execute('projects.trust.list', { project }, {
            serverId, expectedAccountId: 'approver', surface: 'ui',
        })).toEqual({ ok: true, result: { trust: [{ project, revision: 4, value }] } });
        expect(homes.requestsFor(listPath).map(row => ({ serverId: row.serverId, token: row.token, input: row.input })))
            .toEqual([{ serverId, token: createAccountTokenForTests('approver'), input: { project } }]);
    });
    it('honors configurable Ask first and exact reviewed revision/digest before Forget', async () => {
        const input = { project, expectedRevision: 4, expectedEffectDigest: value.reviewedEffectDigest };
        await homes.requireUiApproval(serverId, 'projects.trust.revoke');
        const pending = await createDefaultActionExecutor().execute('projects.trust.revoke', input, {
            serverId, expectedAccountId: 'approver', surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        });
        expect(pending).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId: 'projects.trust.revoke' } });
        expect(homes.requestsFor(mutatePath)).toEqual([]);
    });
    it('does not revoke a reapproved effect and removes only the exact current row when admitted', async () => {
        const executor = createDefaultActionExecutor();
        const context = { serverId, expectedAccountId: 'approver', surface: 'ui', authority: 'present_user',
            presentUserConfirmation: { actionId: 'projects.trust.revoke' } } as const;
        expect(await executor.execute('projects.trust.revoke', { project, expectedRevision: 4, expectedEffectDigest: 'older-effect' }, context))
            .toEqual({ ok: true, result: { project, status: 'conflict' } });
        expect(homes.requestsFor(mutatePath)).toEqual([]);
        expect(await executor.execute('projects.trust.revoke', { project, expectedRevision: 4, expectedEffectDigest: value.reviewedEffectDigest }, context))
            .toEqual({ ok: true, result: { project, status: 'removed' } });
        expect(homes.requestsFor(mutatePath)).toHaveLength(1);
    });
});
