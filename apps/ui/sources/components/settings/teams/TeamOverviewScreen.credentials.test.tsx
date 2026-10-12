import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, renderScreen, standardCleanup, teamCapabilitiesFixture, teamCredentialResourceFixture, teamCredentialViewerFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: routerPush, back: vi.fn(), replace: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const TEAM_GET_PATH = '/v1/teams/get';
const CREDENTIALS_LIST_PATH = '/v1/teams/credential-resources/list';

async function renderOverview(serverId: string) {
    const { TeamOverviewScreen } = await import('./TeamOverviewScreen');
    return renderScreen(<TeamOverviewScreen serverId={serverId} teamId="team-1" />);
}

async function addHome(options?: Readonly<{ credentialResourcesEnabled?: boolean }>): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
        teamsEnabled: true,
        credentialResourcesEnabled: options?.credentialResourcesEnabled ?? true,
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, {
        body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageMembers: true }) }),
    });
    return serverId;
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderOverview>>,
    testID: string,
): Promise<void> {
    await vi.waitFor(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(testID);
    });
}

beforeEach(async () => {
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
    const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
    routerPush.mockReset();
});

afterEach(() => {
    standardCleanup();
});

describe('TeamOverviewScreen shared-credentials destination', () => {
    it('offers the destination only once the Home projects resource authority', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: {
                resources: [teamCredentialResourceFixture()],
                viewer: teamCredentialViewerFixture({ manageCredentials: true, offerOwnCredential: true }),
            },
        });

        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-credentials');

        screen.pressByTestId('team-overview-credentials');
        expect(routerPush).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/credentials`);
    });

    it('offers the destination to a source-only viewer without exposing manager authority', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: { resources: [], viewer: teamCredentialViewerFixture({ offerOwnCredential: true }) },
        });

        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-members');

        await vi.waitFor(() => {
            expect(harness.requestsFor(CREDENTIALS_LIST_PATH).length).toBeGreaterThan(0);
        });
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-overview-credentials');

        screen.pressByTestId('team-overview-credentials');
        expect(routerPush).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/credentials`);
    });

    it('asks nothing at all when the Home has not enabled shared credentials', async () => {
        const serverId = await addHome({ credentialResourcesEnabled: false });

        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-members');

        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-overview-credentials');
        expect(harness.requestsFor(CREDENTIALS_LIST_PATH)).toHaveLength(0);
    });
});
