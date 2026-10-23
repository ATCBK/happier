import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TeamCredentialResourceEntitledPageV1Schema, TeamCredentialResourcePageV1Schema } from '@happier-dev/protocol/teams';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';

import { renderHook, standardCleanup, teamCredentialResourceFixture, teamCredentialViewerFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { useTeamCredentialResources, useTeamCredentialResourceCatalog } = await import('./useTeamCredentialResources');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { invalidateTeamCredentialResources, resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');

beforeEach(async () => {
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    resetTeamActionClientForTests();
    await home.reset();
});

afterEach(async () => {
    standardCleanup();
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    resetTeamActionClientForTests();
    await home.reset();
});

describe('Team credential resource demand', () => {
    it('shares administration reads without loading the recipient catalog until its own consumer mounts', async () => {
        const serverId = await home.addHome({ name: 'Credential Home', serverUrl: 'https://credential-demand.example.test',
            accountId: 'account-ada', teamsEnabled: true, credentialResourcesEnabled: true });
        const scope = { serverId, accountId: 'account-ada' };
        const address = { serverId, teamId: 'team-1' };
        const list = bindHomeDomainActionHttpRequestV1('teams.credentials.list', { teamId: address.teamId });
        const entitled = bindHomeDomainActionHttpRequestV1('teams.credentials.entitled.list', { teamId: address.teamId });
        home.answer(serverId, list.path, { body: TeamCredentialResourcePageV1Schema.parse({
            resources: [teamCredentialResourceFixture()], nextCursor: null,
            viewer: teamCredentialViewerFixture({ manageCredentials: true }),
        }) });
        home.answer(serverId, entitled.path, { body: TeamCredentialResourceEntitledPageV1Schema.parse({ resources: [], nextCursor: null }) });
        const input = { scope, address, enabled: true };
        const administration = await renderHook(() => ({
            first: useTeamCredentialResources(input), second: useTeamCredentialResources(input),
        }));
        await waitForHomeGovernance(() => expect(administration.getCurrent().first.isCurrent).toBe(true));
        expect(administration.getCurrent().second.rows).toHaveLength(1);
        expect(home.requestsFor(list.path)).toHaveLength(1);
        expect(home.requestsFor(entitled.path)).toHaveLength(0);

        await act(async () => { await administration.getCurrent().first.reload(); });
        expect(home.requestsFor(list.path)).toHaveLength(2);
        expect(home.requestsFor(entitled.path)).toHaveLength(0);

        const recipient = await renderHook(() => useTeamCredentialResourceCatalog(input));
        await waitForHomeGovernance(() => expect(recipient.getCurrent().isCurrent).toBe(true));
        expect(home.requestsFor(entitled.path)).toHaveLength(1);
        expect(home.requestsFor(list.path)).toHaveLength(2);

        // Real credential writes invalidate both snapshots; the Home's content-free
        // Teams wake then refreshes each independently demanded authority.
        await act(async () => { invalidateTeamCredentialResources(scope, address); });
        expect(administration.getCurrent().first.isCurrent).toBe(false);
        expect(recipient.getCurrent().isCurrent).toBe(false);
        await act(async () => { publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]); });
        await waitForHomeGovernance(() => {
            expect(administration.getCurrent().first.isCurrent).toBe(true);
            expect(recipient.getCurrent().isCurrent).toBe(true);
            expect(home.requestsFor(list.path)).toHaveLength(3);
            expect(home.requestsFor(entitled.path)).toHaveLength(2);
        });
    });
});
