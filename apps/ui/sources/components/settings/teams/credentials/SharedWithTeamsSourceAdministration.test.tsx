import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema, type MachinePoolViewV1 } from '@happier-dev/protocol';

import { collectRenderedTestIds, createMachineAdministrationTargetSelectionMock, installMachineAdministrationTargetSelectionBoundary, renderScreen, standardCleanup, teamCredentialResourceFixture, teamCredentialSourceResourceFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const CONNECTION_ID = ProviderConnectionIdSchema.parse('connection-1');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installSettingsViewCommonModuleMocks();

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const machineSelection = createMachineAdministrationTargetSelectionMock({
    serverId: 'server-a',
    machines: [{ machineId: 'machine-exact', displayName: 'Exact broker' }],
    selectedMachineId: null,
});
installMachineAdministrationTargetSelectionBoundary(machineSelection);

const poolProjection = vi.hoisted(() => ({ pools: [] as MachinePoolViewV1[] }));
vi.mock('@/sync/engine/machines/useMachinePoolProjections', () => ({
    useMachinePoolProjections: () => [{
        serverId: 'server-a', accountId: 'owner', featureStatus: 'enabled', featureEnabled: true,
        pools: poolProjection.pools, status: 'idle', ready: true,
    }],
}));

const LIST_PATH = '/v1/teams/credential-resources/source-resources/list';
const UPDATE_PATH = '/v1/teams/credential-resources/update';

function selectBrokerMachine(
    screen: Readonly<{ findByType: (type: string) => ReactTestInstance }>,
    machineId: string,
): void {
    const selection = screen.findByType('MachineAdministrationTargetSelector').props.selection;
    const row = selection.pickerRows.find((candidateRow: { candidate: { target: { machineId: string } } }) => (
        candidateRow.candidate.target.machineId === machineId
    ));
    if (!row) throw new Error(`missing broker Machine ${machineId}`);
    act(() => selection.selectTarget(row.candidate.target));
}

beforeEach(async () => {
    poolProjection.pools = [];
    machineSelection.controller.reset();
    await harness.reset();
    await harness.selectHomes([]);
});
afterEach(standardCleanup);

describe('SharedWithTeamsSourceAdministration', () => {
    it('loads source-owner continuation explicitly without replacing prior rows', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, LIST_PATH, { body: {
            resources: [teamCredentialSourceResourceFixture({ id: 'resource-1', displayName: 'Same' })],
            nextCursor: 'cursor-1',
        } });
        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        await vi.waitFor(() => expect(screen.findByTestId('shared-with-teams:load-more')).not.toBeNull());
        harness.answer(serverId, LIST_PATH, { body: {
            resources: [teamCredentialSourceResourceFixture({ id: 'resource-2', displayName: 'Same' })],
            nextCursor: null,
        } });
        await screen.pressByTestIdAsync('shared-with-teams:load-more');
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toEqual(expect.arrayContaining([
            'shared-with-teams:resource:resource-1', 'shared-with-teams:resource:resource-2',
        ])));
        expect(harness.requestsFor(LIST_PATH).at(-1)?.input).toMatchObject({ cursor: 'cursor-1' });
    });

    it('renders only server-authorized source-owner controls without needing Team membership', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        machineSelection.controller.setMachines([{
            machineId: 'machine-exact', displayName: 'Exact broker', serverId, serverIdentityId: serverId,
        }]);
        harness.answer(serverId, LIST_PATH, { body: { resources: [teamCredentialSourceResourceFixture({
            disclosureCeiling: 'direct_allowed',
            capabilities: {
                manageAudience: false, managePolicy: false, manageLimits: false,
                updateBrokerPlacement: false, narrowDisclosure: true, widenDisclosure: false,
                refreshDirectMaterial: false, disable: true, enable: false, delete: true,
            },
        })] } });

        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        await screen.pressByTestIdAsync('shared-with-teams:resource:resource-1');
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('shared-with-teams:narrow:resource-1');
        expect(ids).toContain('shared-with-teams:disable:resource-1');
        expect(ids).toContain('shared-with-teams:delete:resource-1');
        expect(ids).not.toContain('shared-with-teams:enable:resource-1');
        expect(ids).not.toContain('shared-with-teams:broker:resource-1.current');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('teamId');
    });

    it('keeps authorized narrowing available after the source owner disabled the resource', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, LIST_PATH, { body: { resources: [teamCredentialSourceResourceFixture({
            enabled: false,
            disclosureCeiling: 'direct_allowed',
            capabilities: {
                manageAudience: false, managePolicy: false, manageLimits: false,
                updateBrokerPlacement: false, narrowDisclosure: true, widenDisclosure: false,
                refreshDirectMaterial: false, disable: false, enable: false, delete: true,
            },
        })] } });

        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        await screen.pressByTestIdAsync('shared-with-teams:resource:resource-1');

        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('shared-with-teams:narrow:resource-1');
    });

    it('surfaces canonical approval custody and suspends another source mutation', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        const row = teamCredentialSourceResourceFixture({
            disclosureCeiling: 'direct_allowed',
            capabilities: {
                manageAudience: false, managePolicy: false, manageLimits: false,
                updateBrokerPlacement: false, narrowDisclosure: true, widenDisclosure: false,
                refreshDirectMaterial: false, disable: true, enable: false, delete: true,
            },
        });
        harness.answer(serverId, LIST_PATH, { body: { resources: [row] } });
        await harness.requireUiApproval(serverId, 'teams.credentials.update');

        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        await screen.pressByTestIdAsync('shared-with-teams:resource:resource-1');
        await screen.pressByTestIdAsync('shared-with-teams:narrow:resource-1');
        await vi.waitFor(() => expect(screen.findByTestId('shared-with-teams:approval')).not.toBeNull());

        expect(screen.findByTestId('shared-with-teams:disable:resource-1')?.props.disabled).toBe(true);
    });

    it('submits one exact eligible Machine placement when the row grants that operation', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        machineSelection.controller.setMachines([{
            machineId: 'machine-exact', displayName: 'Exact broker', serverId, serverIdentityId: serverId,
        }]);
        const row = teamCredentialSourceResourceFixture({
            brokerPlacement: null,
            brokerPresentation: {
                selectedTarget: null,
                eligibleTargets: [{ machineId: 'machine-exact', displayName: 'Exact broker', availability: 'available' }],
                selectedPool: null,
                eligiblePools: [],
            },
            capabilities: {
                manageAudience: false, managePolicy: false, manageLimits: false,
                updateBrokerPlacement: true, narrowDisclosure: false, widenDisclosure: false,
                refreshDirectMaterial: false, disable: false, enable: false, delete: false,
            },
        });
        harness.answer(serverId, LIST_PATH, { body: { resources: [row] } });
        harness.answer(serverId, UPDATE_PATH, { body: { resourceId: 'resource-1', revision: 4 } });
        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        await screen.pressByTestIdAsync('shared-with-teams:resource:resource-1');
        selectBrokerMachine(screen, 'machine-exact');
        await vi.waitFor(() => expect(screen.findByTestId('shared-with-teams:broker:resource-1:save')?.props.disabled)
            .toBe(false));
        await screen.pressByTestIdAsync('shared-with-teams:broker:resource-1:save');
        expect(JSON.stringify(harness.requestsFor(UPDATE_PATH).at(-1)?.input)).toContain('"brokerPlacement":{"kind":"machine","machineId":"machine-exact"}');
    });

    it('keeps the original revision as the CAS basis when a dirty broker draft receives a newer row', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        machineSelection.controller.setMachines([{
            machineId: 'machine-exact', displayName: 'Exact broker', serverId, serverIdentityId: serverId,
        }]);
        const capabilities = {
            manageAudience: false, managePolicy: false, manageLimits: false,
            updateBrokerPlacement: true, narrowDisclosure: true, widenDisclosure: false,
            refreshDirectMaterial: false, disable: false, enable: false, delete: false,
        } as const;
        const initial = teamCredentialSourceResourceFixture({
            revision: 3,
            disclosureCeiling: 'direct_allowed',
            brokerPlacement: null,
            brokerPresentation: {
                selectedTarget: null,
                eligibleTargets: [{ machineId: 'machine-exact', displayName: 'Exact broker', availability: 'available' }],
                selectedPool: null,
                eligiblePools: [],
            },
            capabilities,
        });
        harness.answer(serverId, LIST_PATH, { body: { resources: [initial] } });
        harness.answer(serverId, UPDATE_PATH, { body: { resourceId: 'resource-1', revision: 4 } });

        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        await screen.pressByTestIdAsync('shared-with-teams:resource:resource-1');
        selectBrokerMachine(screen, 'machine-exact');
        await vi.waitFor(() => expect(screen.findByTestId('shared-with-teams:broker:resource-1:save')?.props.disabled)
            .toBe(false));

        harness.answer(serverId, LIST_PATH, { body: { resources: [{ ...initial, revision: 4 }] } });
        await screen.pressByTestIdAsync('shared-with-teams:narrow:resource-1');
        await vi.waitFor(() => expect(harness.requestsFor(UPDATE_PATH)).toHaveLength(1));
        await vi.waitFor(() => expect(screen.findByTestId('shared-with-teams:broker:resource-1:save')).not.toBeNull());
        await screen.pressByTestIdAsync('shared-with-teams:broker:resource-1:save');

        expect(harness.requestsFor(UPDATE_PATH).at(-1)?.input).toMatchObject({
            expectedRevision: 3,
            brokerPlacement: { kind: 'machine', machineId: 'machine-exact' },
        });
    });

    it('allows an eligible offline Pool to be saved as a repairable exact placement', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        const poolId = '00000000-0000-4000-8000-000000000001';
        poolProjection.pools = [{
            pool: {
                id: poolId, name: 'Travel Pool', description: null, revision: 1,
                createdAt: 1, updatedAt: 1,
                members: [{ machineId: 'machine-exact', priorityTier: 0, enabled: true, state: 'offline' }],
            },
            availability: { state: 'known', connectedCount: 0, enabledCount: 1 },
        }];
        const row = teamCredentialSourceResourceFixture({
            brokerPlacement: null,
            brokerPresentation: {
                selectedTarget: null, eligibleTargets: [], selectedPool: null,
                eligiblePools: [{ poolId, displayName: 'Travel Pool', availability: 'unavailable', availableMachineCount: 0 }],
            },
            capabilities: {
                manageAudience: false, managePolicy: false, manageLimits: false,
                updateBrokerPlacement: true, narrowDisclosure: false, widenDisclosure: false,
                refreshDirectMaterial: false, disable: false, enable: false, delete: false,
            },
        });
        harness.answer(serverId, LIST_PATH, { body: { resources: [row] } });
        harness.answer(serverId, UPDATE_PATH, { body: { resourceId: 'resource-1', revision: 4 } });

        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        await screen.pressByTestIdAsync('shared-with-teams:resource:resource-1');
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain(`shared-with-teams:broker:resource-1:machine_pool:${poolId}`));
        await screen.pressByTestIdAsync(`shared-with-teams:broker:resource-1:machine_pool:${poolId}`);
        await vi.waitFor(() => expect(screen.findByTestId('shared-with-teams:broker:resource-1:save')?.props.disabled)
            .toBe(false));
        await screen.pressByTestIdAsync('shared-with-teams:broker:resource-1:save');

        expect(harness.requestsFor(UPDATE_PATH).at(-1)?.input).toMatchObject({
            expectedRevision: 3,
            brokerPlacement: { kind: 'machine_pool', poolId },
        });
    });

    it('has translated accessible loading, empty, and error recovery states', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'owner' });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, LIST_PATH, { body: { resources: [] } });
        const { SharedWithTeamsSourceAdministration } = await import('./SharedWithTeamsSourceAdministration');
        const screen = await renderScreen(<SharedWithTeamsSourceAdministration
            scope={{ serverId, accountId: 'owner' }}
            source={{ v: 1, kind: 'provider_connection', connectionId: CONNECTION_ID }}
        />);
        await expect.poll(() => collectRenderedTestIds(screen.tree.toJSON())).toContain('shared-with-teams:empty');
        expect(screen.getTextContent()).toContain('teams.credentials.sourceAdministration.empty');
    });
});
