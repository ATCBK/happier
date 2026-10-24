import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { teamDirectoryQueryKeyV1, teamGroupsQueryKeyV1 } from '@happier-dev/protocol/teams';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { standardCleanup, teamGroupFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const engine = await import('./teamsDirectoryEngine');
const snapshots = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { storage } = await import('@/sync/domains/state/storage');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const input = { v: 1, scope: 'member', archived: 'active' } as const;

beforeEach(async () => {
    engine.resetTeamsDirectoryEngineForTests();
    snapshots.resetTeamsSnapshotsForTests();
    resetTeamActionClientForTests();
    await home.reset();
});
afterEach(async () => {
    standardCleanup();
    engine.resetTeamsDirectoryEngineForTests();
    snapshots.resetTeamsSnapshotsForTests();
    resetTeamActionClientForTests();
    await home.reset();
});

async function setup() {
    const serverId = await home.addHome({ name: 'Teams', serverUrl: 'https://team-read-policy.example.test', accountId: 'account', teamsEnabled: true });
    return { scope: { serverId, accountId: 'account' }, address: { serverId, teamId: 'team-1' } };
}

describe('Team snapshot Action admission', () => {
    it.each(['teams.list', 'teams.get', 'teams.groups.list', 'teams.groups.get'] as const)('admits %s through its own Ask-first policy and exact Home', async actionId => {
        const { scope, address } = await setup();
        const group = teamGroupFixture();
        const team = teamSummaryFixture({ id: address.teamId });
        const path = `/v1/${actionId.replaceAll('.', '/')}`;
        const list = actionId.endsWith('.list');
        const value = actionId.startsWith('teams.groups') ? group : team;
        home.answer(scope.serverId, path, { body: list ? { items: [value], nextCursor: null } : value });
        await home.requireUiApproval(scope.serverId, actionId);
        const queryKey = teamGroupsQueryKeyV1({ v: 1, teamId: address.teamId, archived: 'active' });
        const observe = () => actionId === 'teams.list' ? engine.observeTeamsDirectory(scope, input)
            : actionId === 'teams.get' ? engine.observeTeam(scope, address)
                : actionId === 'teams.groups.list' ? engine.observeTeamGroups(scope, address, 'active')
                    : engine.observeTeamGroup(scope, address, group.id);
        const read = (readScope = scope) => actionId === 'teams.list' ? snapshots.getTeamsDirectorySnapshot(readScope, teamDirectoryQueryKeyV1(input))
            : actionId === 'teams.get' ? snapshots.getTeamSnapshot(readScope, address)
                : actionId === 'teams.groups.list' ? snapshots.getTeamGroupsSnapshot(readScope, address, queryKey)
                    : snapshots.getTeamGroupSnapshot(readScope, address, group.id);
        const release = observe();
        try {
            await waitForHomeGovernance(() => expect(home.artifacts(scope.serverId).list().length + home.requestsFor(path).length).toBeGreaterThan(0));
            expect(home.requestsFor(path).length).toBe(0);
            expect(home.artifacts(scope.serverId).list().length).toBe(1);
            const other = await home.addHome({ name: 'Other', serverUrl: 'https://other-team-read.example.test', accountId: 'other', teamsEnabled: true });
            await setActiveServerId(other, { scope: 'device' });
            await decideApprovalAsInbox(scope.serverId, home.artifacts(scope.serverId).list()[0]!.id, 'approve');
            await waitForHomeGovernance(() => expect(read()).toMatchObject({ status: 'ready', data: list ? [value] : value }));
            expect(home.requestsFor(path).map(request => request.serverId)).toEqual([scope.serverId]);
            expect(read({ ...scope, accountId: 'other' })).toBeNull();
            // A second consumer and a settled microtask add no domain read.
            const releaseSecond = observe();
            await Promise.resolve();
            expect(home.requestsFor(path)).toHaveLength(1);
            releaseSecond();
        } finally { release(); }
    });

    it('refuses a disabled Group snapshot before transport', async () => {
        const { scope, address } = await setup();
        const previous = storage.getState().settings.actionsSettingsV1;
        const disabled = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'teams.groups.list': { enabled: false } } });
        storage.getState().applySettingsLocal({ actionsSettingsV1: disabled });
        home.answer(scope.serverId, '/v2/account/settings', { body: {
            version: 1, content: { t: 'plain', v: { actionsSettingsV1: disabled } },
        } });
        const release = engine.observeTeamGroups(scope, address, 'active');
        try {
            const queryKey = teamGroupsQueryKeyV1({ v: 1, teamId: address.teamId, archived: 'active' });
            await waitForHomeGovernance(() => expect(snapshots.getTeamGroupsSnapshot(scope, address, queryKey)?.status).toBe('error'));
            expect(home.requestsFor('/v1/teams/groups/list')).toHaveLength(0);
            expect(home.artifacts(scope.serverId).list().length).toBe(0);
        } finally {
            release();
            storage.getState().applySettingsLocal({ actionsSettingsV1: previous });
        }
    });

    it.each(['teams.list', 'teams.groups.list'] as const)('applies Ask-first independently to %s continuation without extra reads', async actionId => {
        const { scope, address } = await setup();
        const path = `/v1/${actionId.replaceAll('.', '/')}`;
        const first = actionId === 'teams.list' ? teamSummaryFixture({ id: 'team-1' }) : teamGroupFixture({ id: 'group-1' });
        const second = actionId === 'teams.list' ? teamSummaryFixture({ id: 'team-2' }) : teamGroupFixture({ id: 'group-2' });
        home.answer(scope.serverId, path, { select: body => {
            const more = typeof body === 'object' && body !== null && 'cursor' in body && body.cursor;
            return { body: { items: [more ? second : first], nextCursor: more ? null : 'page-2' } };
        } });
        await home.requireUiApproval(scope.serverId, actionId);
        const read = () => actionId === 'teams.list'
            ? snapshots.getTeamsDirectorySnapshot(scope, teamDirectoryQueryKeyV1(input))
            : snapshots.getTeamGroupsSnapshot(scope, address, teamGroupsQueryKeyV1({ v: 1, teamId: address.teamId, archived: 'active' }));
        const release = actionId === 'teams.list' ? engine.observeTeamsDirectory(scope, input) : engine.observeTeamGroups(scope, address, 'active');
        try {
            await waitForHomeGovernance(() => expect(home.artifacts(scope.serverId).list().length + home.requestsFor(path).length).toBeGreaterThan(0));
            expect(home.requestsFor(path).length).toBe(0);
            expect(home.artifacts(scope.serverId).list().length).toBe(1);
            await decideApprovalAsInbox(scope.serverId, home.artifacts(scope.serverId).list()[0]!.id, 'approve');
            await waitForHomeGovernance(() => expect(read()?.nextCursor).toBe('page-2'));
            const pending = actionId === 'teams.list' ? engine.loadMoreTeamsDirectory(scope, input) : engine.loadMoreTeamGroups(scope, address, 'active');
            await waitForHomeGovernance(() => expect(home.artifacts(scope.serverId).list().length).toBe(2));
            expect(home.requestsFor(path)).toHaveLength(1);
            await decideApprovalAsInbox(scope.serverId, home.artifacts(scope.serverId).list()[1]!.id, 'approve');
            await pending;
            expect(read()?.data).toEqual([first, second]);
            expect(home.requestsFor(path)).toHaveLength(2);
        } finally { release(); }
    });
});
