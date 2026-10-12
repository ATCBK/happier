import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup, teamGroupFixture, teamMembershipFixture } from '@/dev/testkit';

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
            failure: { kind: 'invalid', retryable: false, code: null },
        });
    });
});
