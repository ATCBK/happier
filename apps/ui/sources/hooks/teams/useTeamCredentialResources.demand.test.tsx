import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, TeamCredentialResourceDiscoveryPageV1Schema, TeamCredentialResourcePageV1Schema } from '@happier-dev/protocol/teams';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';

import { createDeferred, renderHook, standardCleanup, teamCredentialResourceFixture, teamCredentialViewerFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { useTeamCredentialResources, useTeamCredentialResourceCatalog } = await import('./useTeamCredentialResources');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { invalidateTeamCredentialResources, resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { useTeamBinding } = await import('./useTeamBinding');

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
    it('keeps the admitted credential list when its real Team binding publishes an edited Team', async () => {
        const serverId = await home.addHome({ name: 'Credential Home', serverUrl: 'https://credential-binding.example.test',
            accountId: 'account-ada', teamsEnabled: true, credentialResourcesEnabled: true });
        const get = bindHomeDomainActionHttpRequestV1('teams.get', { v: 1, teamId: 'team-1' });
        const list = bindHomeDomainActionHttpRequestV1('teams.credentials.list', { teamId: 'team-1' });
        home.answer(serverId, get.path, { body: teamSummaryFixture() });
        home.answer(serverId, list.path, { body: TeamCredentialResourcePageV1Schema.parse({
            resources: [teamCredentialResourceFixture()], nextCursor: null,
            viewer: teamCredentialViewerFixture({ manageCredentials: true }),
        }) });
        const screen = await renderHook(() => {
            const binding = useTeamBinding(serverId, 'team-1');
            const ready = binding.kind === 'bound' && binding.state.kind === 'ready' ? binding.state : null;
            const resources = useTeamCredentialResources({ scope: ready?.scope ?? null,
                address: ready?.address ?? null, enabled: ready !== null });
            return { binding, resources };
        });
        await waitForHomeGovernance(() => expect(screen.getCurrent().resources.isCurrent).toBe(true));
        const initial = screen.getCurrent().binding;
        if (initial.kind !== 'bound' || initial.state.kind !== 'ready') throw new Error('Expected the loaded Team');
        const { scope, address } = initial.state;
        const edited = createDeferred<void>();
        home.answer(serverId, get.path, { body: teamSummaryFixture({ name: 'Renamed Team' }), respondAfter: edited.promise });
        await act(async () => {
            const binding = screen.getCurrent().binding;
            if (binding.kind !== 'bound') throw new Error('Expected the real Team binding');
            binding.refresh();
        });
        await waitForHomeGovernance(() => {
            const binding = screen.getCurrent().binding;
            expect(binding.kind === 'bound' && binding.state.kind === 'ready' && binding.state.refreshing).toBe(true);
            if (binding.kind !== 'bound' || binding.state.kind !== 'ready') throw new Error('Expected Team refresh continuity');
            expect(binding.state.scope).toBe(scope);
            expect(binding.state.address).toBe(address);
        });
        await act(async () => { edited.resolve(); });
        await waitForHomeGovernance(() => {
            const binding = screen.getCurrent().binding;
            expect(binding.kind === 'bound' && binding.state.kind === 'ready' && binding.state.team.name).toBe('Renamed Team');
            if (binding.kind !== 'bound' || binding.state.kind !== 'ready') throw new Error('Expected the edited Team');
            expect(binding.state.scope).toBe(scope);
            expect(binding.state.address).toBe(address);
        });
        expect(screen.getCurrent().resources.isCurrent).toBe(true);
        expect(home.requestsFor(list.path)).toHaveLength(1);
    });

    it('keeps one credential list acquisition across equivalent scope objects and a later consumer', async () => {
        const serverId = await home.addHome({ name: 'Credential Home', serverUrl: 'https://credential-identity.example.test',
            accountId: 'account-ada', teamsEnabled: true, credentialResourcesEnabled: true });
        const scope = { serverId, accountId: 'account-ada' };
        const address = { serverId, teamId: 'team-1' };
        const list = bindHomeDomainActionHttpRequestV1('teams.credentials.list', { teamId: address.teamId });
        home.answer(serverId, list.path, { body: TeamCredentialResourcePageV1Schema.parse({
            resources: [teamCredentialResourceFixture()], nextCursor: null,
            viewer: teamCredentialViewerFixture({ manageCredentials: true }),
        }) });
        const first = await renderHook((input: { scope: typeof scope; address: typeof address }) =>
            useTeamCredentialResources({ ...input, enabled: true }), { initialProps: { scope, address } });
        await waitForHomeGovernance(() => expect(first.getCurrent().isCurrent).toBe(true));
        const reload = first.getCurrent().reload;
        await first.rerender({ scope: { ...scope }, address: { ...address } });
        await waitForHomeGovernance(() => expect(first.getCurrent().isCurrent).toBe(true));
        expect(home.requestsFor(list.path)).toHaveLength(1);
        expect(first.getCurrent().reload).toBe(reload);
        const second = await renderHook(() => useTeamCredentialResources({ scope: { ...scope }, address: { ...address }, enabled: true }));
        await waitForHomeGovernance(() => expect(second.getCurrent().isCurrent).toBe(true));
        await first.unmount();
        expect(home.requestsFor(list.path)).toHaveLength(1);
        await act(async () => { publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]); });
        await waitForHomeGovernance(() => expect(home.requestsFor(list.path)).toHaveLength(2));
        await waitForHomeGovernance(() => expect(second.getCurrent().isCurrent).toBe(true));
    });

    it('shares administration reads without loading the recipient catalog until its own consumer mounts', async () => {
        const serverId = await home.addHome({ name: 'Credential Home', serverUrl: 'https://credential-demand.example.test',
            accountId: 'account-ada', teamsEnabled: true, credentialResourcesEnabled: true });
        const scope = { serverId, accountId: 'account-ada' };
        const address = { serverId, teamId: 'team-1' };
        const list = bindHomeDomainActionHttpRequestV1('teams.credentials.list', { teamId: address.teamId });
        const discoveryPath = TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1;
        home.answer(serverId, list.path, { body: TeamCredentialResourcePageV1Schema.parse({
            resources: [teamCredentialResourceFixture()], nextCursor: null,
            viewer: teamCredentialViewerFixture({ manageCredentials: true }),
        }) });
        home.answer(serverId, discoveryPath, { body: TeamCredentialResourceDiscoveryPageV1Schema.parse({ resources: [], nextCursor: null, failures: [] }) });
        const input = { scope, address, enabled: true };
        const administration = await renderHook(() => ({
            first: useTeamCredentialResources(input), second: useTeamCredentialResources(input),
        }));
        await waitForHomeGovernance(() => expect(administration.getCurrent().first.isCurrent).toBe(true));
        expect(administration.getCurrent().second.rows).toHaveLength(1);
        expect(home.requestsFor(list.path)).toHaveLength(1);
        expect(home.requestsFor(discoveryPath)).toHaveLength(0);

        await act(async () => { await administration.getCurrent().first.reload(); });
        expect(home.requestsFor(list.path)).toHaveLength(2);
        expect(home.requestsFor(discoveryPath)).toHaveLength(0);

        const recipient = await renderHook((values: typeof input) => useTeamCredentialResourceCatalog(values), { initialProps: input });
        await waitForHomeGovernance(() => expect(recipient.getCurrent().isCurrent).toBe(true));
        expect(home.requestsFor(discoveryPath)).toHaveLength(1);
        expect(home.requestsFor(list.path)).toHaveLength(2);
        const reloadRecipient = recipient.getCurrent().reload;
        await recipient.rerender({ ...input, scope: { ...scope }, address: { ...address } });
        await waitForHomeGovernance(() => expect(recipient.getCurrent().isCurrent).toBe(true));
        expect(home.requestsFor(discoveryPath)).toHaveLength(1);
        expect(recipient.getCurrent().reload).toBe(reloadRecipient);

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
            expect(home.requestsFor(discoveryPath)).toHaveLength(2);
        });
    });
});
