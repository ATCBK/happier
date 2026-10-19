import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeferred, standardCleanup, teamGroupFixture, teamMembershipFixture, teamSummaryFixture } from '@/dev/testkit';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const MEMBER_GROUPS_LIST_PATH = '/v1/teams/members/groups/list';
const MEMBER_ADD_PATH = '/v1/teams/members/add';

async function operations() {
    return await import('./teamMemberOperations');
}

async function scopeAndAddress(serverId: string) {
    const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
    const { createTeamAddress } = await import('@/sync/domains/teams/teamAddress');
    return {
        scope: createServerAccountScope(serverId, 'account-ada')!,
        address: createTeamAddress(serverId, 'team-1')!,
    };
}

async function addHome(): Promise<string> {
    return await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
    });
}

beforeEach(async () => {
    await harness.reset();
});

afterEach(() => {
    standardCleanup();
});

describe('teamMemberOperations', () => {
    it.each(['add', 'role', 'remove', 'leave'] as const)(
        'settles an acknowledged %s while the Team revalidation is pending',
        async (operation) => {
            const serverId = await addHome();
            const { scope, address } = await scopeAndAddress(serverId);
            const snapshots = await import('@/sync/store/teams/teamsSnapshots');
            const { resolveTeamViewState } = await import('@/components/settings/teams/teamViewState');
            snapshots.applyTeamProjection({ scope, address, team: teamSummaryFixture(), observedAt: 1 });
            const refresh = createDeferred<void>();
            harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
                actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
                    'teams.members.remove': ['ui'], 'teams.members.leave': ['ui'],
                } }),
            } }, version: 1 } });
            harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture(), respondAfter: refresh.promise });
            harness.answer(serverId, '/v1/teams/list', { body: { items: [], nextCursor: null }, respondAfter: refresh.promise });
            harness.answer(serverId, MEMBER_ADD_PATH, { body: teamMembershipFixture() });
            harness.answer(serverId, '/v1/teams/members/role/set', { body: teamMembershipFixture({ role: 'admin' }) });
            harness.answer(serverId, '/v1/teams/members/remove', { body: { status: 'removed', membershipId: 'membership-1' } });
            harness.answer(serverId, '/v1/teams/members/leave', { body: { status: 'removed', membershipId: 'membership-1' } });
            const owner = await operations();
            let continued = false;
            const receipt = operation === 'add'
                ? owner.addTeamMember({ scope, address, accountId: 'account-ada', role: 'member', historyAccess: 'from_membership' })
                : operation === 'role'
                    ? owner.setTeamMemberRole({ scope, address, membershipId: 'membership-1', role: 'admin' })
                    : operation === 'remove'
                        ? owner.removeTeamMember({ scope, address, membershipId: 'membership-1' })
                        : owner.leaveTeam({ scope, address, onSucceeded: () => { continued = true; } });
            let settled: unknown;
            void receipt.then(value => { settled = value; });
            try {
                await vi.waitFor(() => expect(settled).toMatchObject({ kind: 'succeeded' }));
                expect(harness.requestsFor('/v1/teams/get').length).toBeGreaterThan(0);
                expect(snapshots.getTeamSnapshot(scope, address)?.stale).toBe(true);
                expect(resolveTeamViewState(snapshots.getTeamSnapshot(scope, address))).toMatchObject({
                    kind: 'ready', mutationsAvailable: false,
                });
                if (operation === 'leave') expect(continued).toBe(true);
            } finally {
                refresh.resolve();
                // Join real revalidation before the next case replaces this Home's HTTP answers.
                const engine = await import('@/sync/engine/teams/teamsDirectoryEngine');
                await Promise.all([
                    receipt,
                    engine.refreshTeam(scope, address),
                    ...(operation === 'leave' ? [
                        engine.refreshTeamsDirectory(scope, { v: 1, scope: 'member', archived: 'active' }),
                        engine.refreshTeamsDirectory(scope, { v: 1, scope: 'member', archived: 'archived' }),
                    ] : []),
                ]);
            }
        },
    );

    it('lists the effective Groups for one membership through the canonical Action', async () => {
        const serverId = await addHome();
        harness.answer(serverId, MEMBER_GROUPS_LIST_PATH, {
            body: { items: [teamGroupFixture()], nextCursor: 'next-page' },
        });
        const { scope, address } = await scopeAndAddress(serverId);

        const outcome = await (await operations()).listTeamMemberGroups({
            scope,
            address,
            membershipId: 'membership-1',
            cursor: 'current-page',
            limit: 25,
        });

        expect(outcome).toMatchObject({
            kind: 'succeeded',
            value: { items: [{ id: 'group-1' }], nextCursor: 'next-page' },
        });
        expect(harness.requestsFor(MEMBER_GROUPS_LIST_PATH)).toHaveLength(1);
        expect(harness.requestsFor(MEMBER_GROUPS_LIST_PATH)[0]?.input).toEqual({
            v: 1,
            teamId: 'team-1',
            membershipId: 'membership-1',
            cursor: 'current-page',
            limit: 25,
        });
    });

    it('returns the canonical membership row from member admission', async () => {
        const serverId = await addHome();
        harness.answer(serverId, MEMBER_ADD_PATH, {
            body: teamMembershipFixture({
                id: 'membership-new',
                accountId: 'account-grace',
                account: {
                    name: 'Grace Hopper',
                    firstName: 'Grace',
                    lastName: 'Hopper',
                    username: 'grace',
                    avatarUrl: null,
                },
                role: 'admin',
                historyAccess: 'all_existing',
            }),
        });
        const { scope, address } = await scopeAndAddress(serverId);

        const outcome = await (await operations()).addTeamMember({
            scope,
            address,
            accountId: 'account-grace',
            role: 'admin',
            historyAccess: 'all_existing',
        });

        expect(outcome).toMatchObject({
            kind: 'succeeded',
            value: {
                v: 1,
                id: 'membership-new',
                teamId: 'team-1',
                accountId: 'account-grace',
                role: 'admin',
                historyAccess: 'all_existing',
            },
        });
        expect(harness.requestsFor(MEMBER_ADD_PATH)[0]?.input).toEqual({
            v: 1,
            teamId: 'team-1',
            accountId: 'account-grace',
            role: 'admin',
            historyAccess: 'all_existing',
        });
        const { refreshTeam } = await import('@/sync/engine/teams/teamsDirectoryEngine');
        await refreshTeam(scope, address);
    });

    it('rejects the retired add-result envelope instead of rendering it as admission success', async () => {
        const serverId = await addHome();
        harness.answer(serverId, MEMBER_ADD_PATH, {
            body: { outcome: 'added', teamId: 'team-1', accountId: 'account-grace' },
        });
        const { scope, address } = await scopeAndAddress(serverId);

        const outcome = await (await operations()).addTeamMember({
            scope,
            address,
            accountId: 'account-grace',
            role: 'member',
            historyAccess: 'from_membership',
        });

        expect(outcome).toEqual({
            kind: 'failed',
            failure: { kind: 'invalid', retryable: false, code: null, httpStatus: 200 },
        });
        expect(harness.requestsFor('/v1/teams/get')).toHaveLength(0);
    });
});
