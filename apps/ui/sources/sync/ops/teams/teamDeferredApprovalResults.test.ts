import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { teamGroupsQueryKeyV1 } from '@happier-dev/protocol/teams';
import { createDeferred, standardCleanup, teamGroupFixture, teamGroupMemberFixture, teamInvitationRowFixture, teamMembershipFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';

// Only the Home HTTP and secure-storage boundaries are synthetic. Approval
// creation/replay, continuation parsing, Team wrappers and projections stay real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createTeamGroup, addTeamGroupMember } = await import('./teamGroupOperations');
const { addTeamMember } = await import('./teamMemberOperations');
const { createTeam } = await import('./teamOperations');
const { createTeamInvitation, reissueTeamInvitation } = await import('./teamInvitationOperations');
const { isTeamActionApprovalPendingError, resetTeamActionClientForTests } = await import('./teamActionClient');
const snapshots = await import('@/sync/store/teams/teamsSnapshots');
const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');

let serverId: string;
let scope: Readonly<{ serverId: string; accountId: string }>;
let address: Readonly<{ serverId: string; teamId: string }>;
const team = teamSummaryFixture({ id: 'team-new', name: 'Design' });
const group = teamGroupFixture({ id: 'group-new', name: 'Design' });
const membership = teamMembershipFixture({ id: 'membership-grace', accountId: 'account-grace' });

beforeEach(async () => {
    await homes.reset();
    resetTeamActionClientForTests();
    serverId = await homes.addHome({ name: 'Team Home', serverUrl: 'https://deferred-team.test', accountId: 'account-ada' });
    scope = { serverId, accountId: 'account-ada' };
    address = { serverId, teamId: 'team-1' };
});
afterEach(() => { resetTeamActionClientForTests(); standardCleanup(); });

async function pendingApproval(operation: Promise<unknown>) {
    const result = await operation.then(() => null, (cause: unknown) => cause);
    expect(isTeamActionApprovalPendingError(result)).toBe(true);
    if (!isTeamActionApprovalPendingError(result)) throw result ?? new Error('Expected pending approval');
    return result;
}

async function settle(pending: Awaited<ReturnType<typeof pendingApproval>>, decision: 'approve' | 'reject' = 'approve') {
    expect(typeof pending.registration).not.toBe('string');
    if (typeof pending.registration === 'string') throw new Error('Expected result-bearing approval');
    await expect(decideApprovalAsInbox(serverId, pending.artifactId, decision)).resolves.toMatchObject({
        ok: true, result: decision === 'approve' ? { status: 'executed', execution: { ok: true } } : { status: 'rejected' },
    });
    const account = await captureActionAccountContext(serverId, new AbortController().signal);
    try {
        const artifact = await account.fetchArtifact(pending.artifactId);
        if (!artifact) throw new Error('Expected persisted approval Artifact');
        if (decision === 'approve') expect(await pending.registration.onExecuted(artifact)).toBe('consumed');
        else {
            expect(typeof pending.registration.onTerminal).toBe('function');
            pending.registration.onTerminal?.('rejected', artifact);
        }
    } finally { account.dispose(); }
}

function seedGroups() {
    const queryKey = teamGroupsQueryKeyV1({ v: 1, teamId: address.teamId, archived: 'active' });
    snapshots.applyTeamGroupsPage({ scope, address, queryKey, items: [], nextCursor: null, observedAt: 1 });
    return () => snapshots.getTeamGroupsSnapshot(scope, address, queryKey);
}

describe('deferred Team mutation results', () => {
    it('publishes an approved Team creation under the id only its answer carries', async () => {
        const path = '/v1/teams/create';
        homes.answer(serverId, path, { body: team });
        await homes.requireUiApproval(serverId, 'teams.create');
        const received: unknown[] = [];
        const pending = await pendingApproval(createTeam({ scope, name: 'Design', description: null, requestKey: 'key-1',
            onApprovalSucceeded: result => { received.push(result); } }));
        const createdAddress = { serverId, teamId: team.id };
        expect(snapshots.getTeamSnapshot(scope, createdAddress)).toBeNull();
        expect(homes.requestsFor(path)).toHaveLength(0);
        await settle(pending);
        expect(snapshots.getTeamSnapshot(scope, createdAddress)?.data).toEqual(team);
        expect(received).toEqual([team]);
        expect(homes.requestsFor(path)).toHaveLength(1);
    });

    it('publishes an approved Group creation and marks the sequences it moved', async () => {
        const path = '/v1/teams/groups/create';
        homes.answer(serverId, path, { body: group });
        await homes.requireUiApproval(serverId, 'teams.groups.create');
        const readGroups = seedGroups();
        const received: unknown[] = [];
        const pending = await pendingApproval(createTeamGroup({ scope, address, name: 'Design', description: null,
            requestKey: 'key-1', onApprovalSucceeded: result => { received.push(result); } }));
        expect(readGroups()?.stale).toBe(false);
        await settle(pending);
        expect(snapshots.getTeamGroupSnapshot(scope, address, group.id)?.data).toEqual(group);
        expect(readGroups()?.stale).toBe(true);
        expect(received).toEqual([group]);
        expect(homes.requestsFor(path)).toHaveLength(1);
    });

    it('invalidates the exact Team behind an approved admission before the caller acts', async () => {
        const path = '/v1/teams/members/add';
        homes.answer(serverId, path, { body: membership });
        await homes.requireUiApproval(serverId, 'teams.members.add');
        snapshots.applyTeamProjection({ scope, address, team: teamSummaryFixture(), observedAt: 1 });
        const revalidation = createDeferred<void>();
        homes.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture(), respondAfter: revalidation.promise });
        const received: unknown[] = [];
        const pending = await pendingApproval(addTeamMember({ scope, address, accountId: 'account-grace', role: 'member',
            historyAccess: 'all_existing', onApprovalSucceeded: result => {
                expect(snapshots.getTeamSnapshot(scope, address)?.stale).toBe(true);
                received.push(result);
            } }));
        expect(homes.requestsFor('/v1/teams/get')).toHaveLength(0);
        try {
            await settle(pending);
            await waitForHomeGovernance(() => expect(homes.requestsFor('/v1/teams/get')).toHaveLength(1));
            expect(received).toEqual([membership]);
            expect(homes.requestsFor(path)).toHaveLength(1);
        } finally {
            revalidation.resolve();
            const { refreshTeam } = await import('@/sync/engine/teams/teamsDirectoryEngine');
            await refreshTeam(scope, address);
        }
    });

    it('keeps an approved Group contribution truthful about whether it changed anything', async () => {
        const path = '/v1/teams/groups/members/add';
        await homes.requireUiApproval(serverId, 'teams.groups.members.add');
        for (const status of ['added', 'unchanged'] as const) {
            const result = status === 'added'
                ? { status, member: teamGroupMemberFixture({ accountId: 'account-grace', membershipId: 'membership-grace' }) }
                : { status };
            homes.answer(serverId, path, { body: result });
            const readGroups = seedGroups();
            const received: unknown[] = [];
            const pending = await pendingApproval(addTeamGroupMember({ scope, address, groupId: 'group-1', accountId: 'account-grace',
                historyAccess: status === 'added' ? 'all_existing' : 'from_membership',
                onApprovalSucceeded: value => { received.push(value); } }));
            await settle(pending);
            expect(readGroups()?.stale).toBe(status === 'added');
            expect(received).toEqual([result]);
        }
        expect(homes.requestsFor(path)).toHaveLength(2);
    });

    it('keeps invitation creation and reissue on live-only custody, never a continuation', async () => {
        await homes.requireUiApproval(serverId, ['teams.invitations.create', 'teams.invitations.reissue']);
        const token = 'a'.repeat(43);
        for (const operation of ['create', 'reissue'] as const) {
            const lifetime = new AbortController();
            const path = `/v1/teams/invitations/${operation}`;
            homes.answer(serverId, path, { body: operation === 'create'
                ? { invitation: teamInvitationRowFixture(), joinUrl: `https://deferred-team.test/join/${token}` }
                : { replacement: teamInvitationRowFixture({ id: 'invitation-2' }), joinUrl: `https://deferred-team.test/join/${token}` } });
            const before = homes.artifacts(serverId).list().length;
            const pending = (operation === 'create'
                ? createTeamInvitation({ scope, address, role: 'member', historyAccess: 'from_membership', recipientEmail: null,
                    requestKey: 'key-create', signal: lifetime.signal })
                : reissueTeamInvitation({ scope, address, invitationId: 'invitation-1', recipientEmail: null,
                    requestKey: 'key-reissue', signal: lifetime.signal })).then(value => ({ value }), cause => ({ cause }));
            try {
                await waitForHomeGovernance(() => expect(homes.artifacts(serverId).list()).toHaveLength(before + 1));
                expect(homes.requestsFor(path)).toHaveLength(0);
                lifetime.abort();
                await expect(pending).resolves.toMatchObject({ value: { kind: 'failed' } });
                const artifactId = homes.artifacts(serverId).list().at(-1)!.id;
                await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({
                    ok: true, result: { status: 'failed', execution: { errorCode: 'approval_stale', effectAttempted: false } },
                });
                expect(homes.requestsFor(path)).toHaveLength(0);
                expect(homes.artifacts(serverId).readPlainBody(artifactId)).not.toContain(token);
            } finally { lifetime.abort(); await pending; }
        }
    });

    it('carries a refusal back as the operations own typed code, not as success', async () => {
        await homes.requireUiApproval(serverId, 'teams.create');
        const received: unknown[] = [];
        const refusals: string[] = [];
        const pending = await pendingApproval(createTeam({ scope, name: 'Design', description: null, requestKey: 'key-1',
            onApprovalSucceeded: result => { received.push(result); }, onApprovalFailed: code => { refusals.push(code); } }));
        await settle(pending, 'reject');
        expect(refusals).toEqual(['approval_rejected']);
        expect(received).toEqual([]);
        expect(snapshots.getTeamSnapshot(scope, { serverId, teamId: team.id })).toBeNull();
        expect(homes.requestsFor('/v1/teams/create')).toHaveLength(0);
    });

    it('leaves a wrapper without result handlers registering only its Artifact id', async () => {
        await homes.requireUiApproval(serverId, 'teams.groups.create');
        const pending = await pendingApproval(createTeamGroup({ scope, address, name: 'Design', description: null, requestKey: 'key-1' }));
        expect(pending.registration).toBe(pending.artifactId);
        expect(homes.requestsFor('/v1/teams/groups/create')).toHaveLength(0);
    });
});
