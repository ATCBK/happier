import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    TeamCredentialResourceSummaryV1Schema,
    teamCredentialResourcesQueryKeyV1,
} from '@happier-dev/protocol/teams';

const listTeamCredentialResourcesMock = vi.hoisted(() => vi.fn());
const listEntitledTeamCredentialResourcesMock = vi.hoisted(() => vi.fn());
const getTeamCredentialResourceMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/teams/teamCredentialOperations', () => ({
    listTeamCredentialResources: listTeamCredentialResourcesMock,
    listEntitledTeamCredentialResources: listEntitledTeamCredentialResourcesMock,
    getTeamCredentialResource: getTeamCredentialResourceMock,
}));

import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createTeamAddress } from '@/sync/domains/teams/teamAddress';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    getTeamCredentialResourceCatalogSnapshot,
    getTeamCredentialResourceSnapshot,
    getTeamCredentialResourcesSnapshot,
    resetTeamsSnapshotsForTests,
} from '@/sync/store/teams/teamsSnapshots';

import {
    observeTeamCredentialResourceCatalog,
    observeTeamCredentialResource,
    observeTeamCredentialResources,
    resetTeamsDirectoryEngineForTests,
} from './teamsDirectoryEngine';

const scope = createServerAccountScope('home-a', 'account')!;
const address = createTeamAddress('home-a', 'team-1')!;

function credentialResource(id: string, teamId = 'team-1') {
    return TeamCredentialResourceSummaryV1Schema.parse({
        id, teamId, custodianAccountId: 'account',
        displayName: 'Deep-linked credential', enabled: true, revision: 1,
        disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed',
        source: null,
        sourcePresentation: {
            kind: 'provider',
            provider: {
                identity: { pluginId: 'happier.provider.test', localId: 'provider' },
                definitionRevision: 1,
            },
        },
        requestPolicy: null, brokerPlacement: null, allMembersDeliveryMode: null,
        groupGrants: [], memberGrants: [], readiness: { kind: 'available' }, recoveryAction: null,
        brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] },
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    });
}

beforeEach(() => {
    listTeamCredentialResourcesMock.mockReset();
    listEntitledTeamCredentialResourcesMock.mockReset();
    getTeamCredentialResourceMock.mockReset();
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
});

afterEach(() => {
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    vi.clearAllMocks();
});

describe('Team credential resource observations', () => {
    it('publishes a complete recipient catalog only after following continuation', async () => {
        const first = {
            id: 'resource-1', teamId: address.teamId, displayName: 'Same name', resourceRevision: 1,
            readiness: { kind: 'available' as const }, recoveryAction: null,
            mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered' as const,
            sessionUsePolicy: 'personal_allowed' as const, providerModels: [], connectedServiceSelections: [],
            sourcePresentation: null,
        };
        const second = { ...first, id: 'resource-2' };
        listEntitledTeamCredentialResourcesMock
            .mockResolvedValueOnce({ kind: 'succeeded', value: { resources: [first], nextCursor: 'catalog-page-2' } })
            .mockResolvedValueOnce({ kind: 'succeeded', value: { resources: [second], nextCursor: null } });

        const application = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            implementationIdentity: { pluginId: 'happier.provider.test', localId: 'test' },
            endpointTemplateId: 'responses', protocol: 'openai-responses',
        } as const;
        const release = observeTeamCredentialResourceCatalog(scope, address, application);
        await vi.waitFor(() => {
            expect(getTeamCredentialResourceCatalogSnapshot(scope, address, application)).toMatchObject({
                status: 'ready', data: [{ id: first.id }, { id: second.id }],
            });
        });
        expect(listEntitledTeamCredentialResourcesMock).toHaveBeenNthCalledWith(2, {
            scope, address, application, cursor: 'catalog-page-2',
        });
        expect(getTeamCredentialResourceCatalogSnapshot(scope, address)).toBeNull();
        release();
    });

    it('loads one exact resource independently of the first administration page and scopes it by Home, Account and Team', async () => {
        const resource = credentialResource('resource-51');
        getTeamCredentialResourceMock.mockResolvedValue({ kind: 'succeeded', value: resource });

        const release = observeTeamCredentialResource(scope, address, resource.id);
        await vi.waitFor(() => {
            expect(getTeamCredentialResourceSnapshot(scope, address, resource.id)?.status).toBe('ready');
        });

        expect(getTeamCredentialResourceMock).toHaveBeenCalledWith({ scope, resourceId: resource.id });
        expect(getTeamCredentialResourceSnapshot(scope, address, resource.id)?.data).toBe(resource);
        expect(getTeamCredentialResourcesSnapshot(scope, address)).toBeNull();
        expect(getTeamCredentialResourceSnapshot(
            createServerAccountScope('home-a', 'other-account')!, address, resource.id,
        )).toBeNull();
        expect(getTeamCredentialResourceSnapshot(
            scope, createTeamAddress('home-a', 'other-team')!, resource.id,
        )).toBeNull();
        release();
    });

    it.each([
        { name: 'Team', response: credentialResource('resource-shared', 'other-team') },
        { name: 'resource id', response: credentialResource('other-resource') },
    ])('rejects a successful exact response whose $name does not match the observed route', async ({ response }) => {
        getTeamCredentialResourceMock.mockResolvedValue({
            kind: 'succeeded',
            value: response,
        });

        const release = observeTeamCredentialResource(scope, address, 'resource-shared');
        await vi.waitFor(() => {
            expect(getTeamCredentialResourceSnapshot(scope, address, 'resource-shared')?.status).toBe('error');
        });

        expect(getTeamCredentialResourceSnapshot(scope, address, 'resource-shared')).toMatchObject({
            data: null,
            stale: false,
            error: { kind: 'forbidden', retryable: false, code: 'not_found_or_not_visible' },
        });
        release();
    });

    it('keeps an exact not-visible answer typed and does not borrow another Team resource', async () => {
        getTeamCredentialResourceMock.mockResolvedValue({
            kind: 'failed',
            failure: { kind: 'forbidden', retryable: false, code: 'not_found_or_not_visible' },
        });

        const release = observeTeamCredentialResource(scope, address, 'resource-hidden');
        await vi.waitFor(() => {
            expect(getTeamCredentialResourceSnapshot(scope, address, 'resource-hidden')?.status).toBe('error');
        });

        expect(getTeamCredentialResourceSnapshot(scope, address, 'resource-hidden')).toMatchObject({
            data: null,
            stale: false,
            error: { kind: 'forbidden', retryable: false, code: 'not_found_or_not_visible' },
        });
        release();
    });

    it('keys administration reads by filter while observing the recipient catalog once per Team', async () => {
        listTeamCredentialResourcesMock.mockResolvedValue({
            kind: 'succeeded',
            value: { resources: [], nextCursor: null, viewer: { manageCredentials: true, offerOwnCredential: true } },
        });
        listEntitledTeamCredentialResourcesMock.mockResolvedValue({
            kind: 'succeeded',
            value: { resources: [] },
        });

        const releaseCatalog = observeTeamCredentialResourceCatalog(scope, address);
        const releaseAll = observeTeamCredentialResources(scope, address);
        await vi.waitFor(() => {
            expect(getTeamCredentialResourcesSnapshot(scope, address)?.status).toBe('ready');
            expect(getTeamCredentialResourceCatalogSnapshot(scope, address)?.status).toBe('ready');
        });
        releaseAll();

        const releaseFiltered = observeTeamCredentialResources(scope, address, 'claude', 'brokered');
        const filteredKey = teamCredentialResourcesQueryKeyV1({
            teamId: address.teamId,
            search: 'claude',
            filter: 'brokered',
        });
        await vi.waitFor(() => {
            expect(getTeamCredentialResourcesSnapshot(scope, address, filteredKey)?.status).toBe('ready');
        });

        expect(listTeamCredentialResourcesMock).toHaveBeenCalledTimes(2);
        expect(listTeamCredentialResourcesMock.mock.calls[1]?.[0]).toMatchObject({ search: 'claude', filter: 'brokered' });
        expect(listEntitledTeamCredentialResourcesMock).toHaveBeenCalledTimes(1);
        releaseFiltered();
        releaseCatalog();
    });

    it('refreshes both projections on invalidation and retains admin rows while catalog selection fails closed', async () => {
        const resource = TeamCredentialResourceSummaryV1Schema.parse({
            id: 'resource-1', teamId: 'team-1', custodianAccountId: 'account',
            displayName: 'Managed credential', enabled: true, revision: 1,
            disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed',
            source: {
                v: 1, kind: 'provider_connection', connectionId: 'connection-1',
                connectionSecurityFingerprint: 'connection-security:v1:test', credentialSlotId: 'api-key',
            },
            sourcePresentation: {
                kind: 'provider',
                provider: {
                    identity: { pluginId: 'happier.provider.test', localId: 'provider' },
                    definitionRevision: 1,
                },
            },
            requestPolicy: null, brokerPlacement: null, allMembersDeliveryMode: null,
            groupGrants: [], memberGrants: [], readiness: { kind: 'available' }, recoveryAction: null,
            brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] },
            createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
        });
        listTeamCredentialResourcesMock.mockResolvedValue({
            kind: 'succeeded',
            value: { resources: [resource], nextCursor: null, viewer: { manageCredentials: true, offerOwnCredential: true } },
        });
        listEntitledTeamCredentialResourcesMock.mockResolvedValueOnce({
            kind: 'succeeded',
            value: { resources: [{
                id: resource.id, teamId: resource.teamId, displayName: resource.displayName, resourceRevision: 1,
                readiness: 'available', recoveryAction: null, deliveryMode: 'brokered', mayBroker: true,
                mayReceiveDirect: false, directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
                providerModels: [], sourcePresentation: resource.sourcePresentation,
            }] },
        });

        const releaseCatalog = observeTeamCredentialResourceCatalog(scope, address);
        const releaseAdmin = observeTeamCredentialResources(scope, address);
        await vi.waitFor(() => {
            expect(getTeamCredentialResourcesSnapshot(scope, address)?.status).toBe('ready');
            expect(getTeamCredentialResourceCatalogSnapshot(scope, address)?.status).toBe('ready');
        });

        listEntitledTeamCredentialResourcesMock.mockResolvedValueOnce({
            kind: 'failed',
            failure: { kind: 'unreachable', retryable: true, code: null },
        });
        publishHomeAccountChange(scope.serverId);

        await vi.waitFor(() => {
            expect(listTeamCredentialResourcesMock).toHaveBeenCalledTimes(2);
            expect(listEntitledTeamCredentialResourcesMock).toHaveBeenCalledTimes(2);
            expect(getTeamCredentialResourceCatalogSnapshot(scope, address)?.status).toBe('error');
        });
        expect(getTeamCredentialResourcesSnapshot(scope, address)).toMatchObject({
            status: 'ready', stale: false, data: [{ id: resource.id }],
        });
        expect(getTeamCredentialResourceCatalogSnapshot(scope, address)).toMatchObject({
            status: 'error', stale: true, data: [{ id: resource.id }],
        });
        releaseAdmin();
        releaseCatalog();
    });
});
