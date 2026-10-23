import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeferred, renderHook, flushHookEffects } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, TeamCredentialResourceCatalogEntryV1Schema,
    TeamCredentialResourceDiscoverInputV1Schema, TeamCredentialResourceDiscoveryPageV1Schema } from '@happier-dev/protocol/teams';
import { PROVIDER_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { describeApprovalActionFields } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { readActionApprovalSubject } = await import('./actionApprovalPresentation');
const { readActionApprovalReview } = await import('./actionApprovalReview');
const { ApprovalRequestV2Schema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
const { resolveApprovalRequestTitle, useApprovalRequestTitle } = await import('./approvalRequestTitle');
const { useApprovalReferenceReading, readApprovalReferenceForConfirmation } = await import('./approvalReferenceReading');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { applyTeamCredentialResourceCatalog, applyTeamProjection, resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');

const actionId = 'providers.models.experimental.confirm';
const input = PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse({ action: 'confirmExperimental',
    connectionId: 'connected-source:recipient', catalogSourceKey: 's'.repeat(43), expectedConnectionRevision: 0,
    agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5.6-luna',
    compatibilityFingerprint: 'compatibility:v1:experimental' });
const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
    id: 'resource-a', teamId: 'team-a', displayName: 'Engineering gateway', resourceRevision: 1,
    readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
    directMaterialState: 'never_delivered', sessionUsePolicy: null, sourcePresentation: null,
    providerModels: [{ selection: { kind: 'team_credential_provider_model', resourceId: 'resource-a', teamId: 'team-a',
        expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey: input.agentTargetKey, modelId: input.modelId },
        descriptor: { id: input.modelId, name: 'GPT-5.6 Luna' },
        application: { agentTargetKey: input.agentTargetKey, implementationIdentity: { pluginId: 'acme.gateway', localId: 'gateway' },
            endpointTemplateId: 'responses', protocol: 'openai-responses' },
        confirmationSource: { connectionId: input.connectionId, catalogSourceKey: input.catalogSourceKey },
        sourceRevision: 'source-a', availability: 'available' }],
});

describe('Provider approval reference reading', () => {
    beforeEach(async () => {
        standardCleanup();
        resetTeamsSnapshotsForTests();
        resetTeamsDirectoryEngineForTests();
        resetTeamActionClientForTests();
        resetServerFeaturesClientForTests();
        await harness.reset();
    });
    afterEach(() => standardCleanup());

    it('reads a Provider approval computer through its captured Home Machine reference', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://provider-machine-reference.test',
            accountId: 'recipient', serverIdentityId: 'srv_approval' });
        const { storage } = await import('@/sync/domains/state/storage');
        const machine = createMachineFixture({ id: 'machine-provider', metadata: {
            ...createMachineFixture().metadata!, displayName: 'Studio computer',
        } });
        storage.setState({ machineListByServerId: { [home]: [machine] },
            machineListStatusByServerId: { [home]: 'idle' } });
        const fields = describeApprovalActionFields({ actionId, actionArgs: { ...input, machineId: machine.id } });
        const field = fields.rows.find(row => row.path === 'machineId');
        if (!field || field.kind !== 'value') throw new Error('Missing computer field');
        const hook = await renderHook(() => useApprovalReferenceReading(field.reference, field.value, home));
        expect(hook.getCurrent()).toMatchObject({ text: 'Studio computer', named: true });
        const account = await captureLazyActionAccountContext(home);
        try {
            expect(await readApprovalReferenceForConfirmation(field.reference, account))
                .toMatchObject({ text: 'Studio computer', named: true });
        } finally { account.dispose(); }
    });

    it('names a brokered connection in the captured Home Account without borrowing another Account catalog', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://provider-reference.test',
            accountId: 'recipient', serverIdentityId: 'srv_approval' });
        applyTeamCredentialResourceCatalog({ scope: { serverId: 'srv_approval', accountId: 'other' },
            address: { serverId: 'srv_approval', teamId: resource.teamId },
            resources: [{ ...resource, displayName: 'Wrong Account gateway' }], observedAt: 1 });
        applyTeamProjection({ scope: { serverId: 'srv_approval', accountId: 'other' },
            address: { serverId: 'srv_approval', teamId: resource.teamId },
            team: teamSummaryFixture({ id: resource.teamId, name: 'Wrong Account Team' }), observedAt: 1 });
        const account = await captureLazyActionAccountContext(home);
        try {
            const reference = { kind: 'providerConnection' as const, id: input.connectionId };
            expect((await readApprovalReferenceForConfirmation(reference, account)).text).toBe('Unavailable');
            applyTeamCredentialResourceCatalog({ scope: { serverId: 'srv_approval', accountId: 'recipient' },
                address: { serverId: 'srv_approval', teamId: resource.teamId }, resources: [resource], observedAt: 1 });
            expect(await readApprovalReferenceForConfirmation(reference, account))
                .toMatchObject({ text: resource.displayName, named: true });
            applyTeamProjection({ scope: { serverId: 'srv_approval', accountId: 'recipient' },
                address: { serverId: 'srv_approval', teamId: resource.teamId },
                team: teamSummaryFixture({ id: resource.teamId, name: 'Platform' }), observedAt: 1 });
            expect((await readApprovalReferenceForConfirmation(reference, account)).text)
                .toBe(`${resource.displayName} · Platform`);
            expect((await readApprovalReferenceForConfirmation({ ...reference, catalogSourceKey: 'x'.repeat(43) }, account)).text)
                .toBe('Unavailable');
        } finally { account.dispose(); }
    });

    it('reads only the selected source Team name when confirming among thousands of cached resources', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://provider-reference-cost.test',
            accountId: 'recipient', serverIdentityId: 'srv_approval_cost' });
        const scope = { serverId: 'srv_approval_cost', accountId: 'recipient' };
        const address = { serverId: scope.serverId, teamId: resource.teamId };
        let teamNameReads = 0;
        // Count actual DTO field reads while retaining the real store and reference resolver.
        const team = { ...teamSummaryFixture({ id: resource.teamId }), get name() {
            teamNameReads += 1;
            return 'Platform';
        } };
        applyTeamProjection({ scope, address, team, observedAt: 1 });
        applyTeamCredentialResourceCatalog({ scope, address, observedAt: 1,
            resources: [...Array.from({ length: 1_000 }, (_, index) => ({ ...resource,
                id: `unrelated-${index}`, providerModels: [] })), resource] });
        const account = await captureLazyActionAccountContext(home);
        teamNameReads = 0;
        try {
            const reference = { kind: 'providerConnection' as const, id: input.connectionId,
                catalogSourceKey: input.catalogSourceKey };
            expect((await readApprovalReferenceForConfirmation(reference, account)).text)
                .toBe(`${resource.displayName} · Platform`);
            expect(teamNameReads).toBe(1);
            teamNameReads = 0;
            expect((await readApprovalReferenceForConfirmation({ ...reference, catalogSourceKey: 'x'.repeat(43) }, account)).text)
                .toBe('Unavailable');
            expect(teamNameReads).toBe(0);
        } finally { account.dispose(); }
    });

    it('uses the declared model as the subject and names the Agent in the generic approval reader', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://provider-model-reference.test',
            accountId: 'recipient', serverIdentityId: 'srv_approval' });
        const fields = describeApprovalActionFields({ actionId, actionArgs: input });
        const agent = fields.rows.find(row => row.path === 'agentTargetKey');
        expect(agent?.kind).toBe('value');
        if (!agent || agent.kind !== 'value') throw new Error('Missing Agent field');
        const subject = readActionApprovalSubject({ actionId, actionArgs: input });
        expect(subject).toMatchObject({ kind: 'providerModel', id: input.modelId });
        const hook = await renderHook(() => useApprovalReferenceReading(agent.reference, agent.value, home));
        await flushHookEffects();
        expect(hook.getCurrent()).toMatchObject({ text: 'Codex', named: true });
        const title = await renderHook(() => useApprovalRequestTitle({ storedTitle: null, actionId, actionArgs: input }, home));
        expect(title.getCurrent().title).toContain(input.modelId);
        // The exact recipient catalog name is also used by the non-hook confirmation path.
        applyTeamCredentialResourceCatalog({ scope: { serverId: 'srv_approval', accountId: 'recipient' },
            address: { serverId: 'srv_approval', teamId: resource.teamId }, resources: [resource], observedAt: 1 });
        const account = await captureLazyActionAccountContext(home);
        try {
            const reading = await readApprovalReferenceForConfirmation(subject, account);
            expect(reading.text).toBe('GPT-5.6 Luna');
            expect(resolveApprovalRequestTitle({ storedTitle: null, actionId, actionArgs: input, subject: reading.text }).title).toContain(reading.text);
        } finally { account.dispose(); }
    });

    it('loads brokered model and connection names through the real Home catalog wiring for approval details and title', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://provider-catalog-reference.test',
            accountId: 'recipient', serverIdentityId: 'srv_catalog_approval', teamsEnabled: true, credentialResourcesEnabled: true });
        await harness.selectHomes([home]);
        const directory = bindHomeDomainActionHttpRequestV1('teams.list', { v: 1, scope: 'member', archived: 'active' });
        harness.answer(home, `${directory.method} ${directory.path.split('?')[0]}`,
            { body: { items: [teamSummaryFixture({ id: resource.teamId, name: 'Platform' })], nextCursor: null } });
        harness.answer(home, `POST ${TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1}`, { select: input => {
            const { application, teamIds } = TeamCredentialResourceDiscoverInputV1Schema.parse(input);
            expect(teamIds).toEqual([resource.teamId]);
            return { body: TeamCredentialResourceDiscoveryPageV1Schema.parse({ resources: [application ? resource : { ...resource, providerModels: [],
                sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } } }],
                failures: [], nextCursor: null }) };
        } });
        const fields = describeApprovalActionFields({ actionId, actionArgs: input });
        const connection = fields.rows.find(row => row.path === 'connectionId');
        if (!connection || connection.kind !== 'value') throw new Error('Missing connection');
        const hook = await renderHook(() => useApprovalReferenceReading(connection.reference, connection.value, home),
            { flushOptions: { cycles: 25 } });
        await flushHookEffects({ cycles: 25 });
        await vi.waitFor(() => {
            expect(hook.getCurrent().text).toBe(`${resource.displayName} · Platform`);
        });
        const title = await renderHook(() => useApprovalRequestTitle({ storedTitle: null, actionId, actionArgs: input }, home));
        await vi.waitFor(() => expect(title.getCurrent().title).toContain('GPT-5.6 Luna'));
        const account = await captureLazyActionAccountContext(home);
        try {
            const reading = await readApprovalReferenceForConfirmation(connection.reference, account);
            expect(reading.text).toBe(hook.getCurrent().text);
        } finally { account.dispose(); }
    });

    it.each([true, false])('keeps the pending approval connection resolving until its Agent-qualified catalog answers (source matches: %s)', async (sourceMatches) => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://pending-provider-reference.test',
            accountId: 'recipient', serverIdentityId: 'srv_pending_approval', teamsEnabled: true, credentialResourcesEnabled: true });
        await harness.selectHomes([home]);
        const directory = bindHomeDomainActionHttpRequestV1('teams.list', { v: 1, scope: 'member', archived: 'active' });
        harness.answer(home, `${directory.method} ${directory.path.split('?')[0]}`,
            { body: { items: [teamSummaryFixture({ id: resource.teamId, name: 'Platform' })], nextCursor: null } });
        const response = createDeferred<void>();
        const requested = createDeferred<void>();
        const pendingResource = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...resource,
            sourcePresentation: { kind: 'connected_service',
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
            providerModels: [{ ...resource.providerModels[0],
                selection: { ...resource.providerModels[0]!.selection, modelId: 'gpt-5.5' },
                descriptor: { id: 'gpt-5.5', name: 'GPT-5.5' },
                application: { agentTargetKey: input.agentTargetKey,
                    implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
                    endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses' },
                confirmationSource: { connectionId: input.connectionId,
                    catalogSourceKey: sourceMatches ? input.catalogSourceKey : 'x'.repeat(43) } }],
        });
        harness.answer(home, `POST ${TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1}`, { select: value => {
            const { application, teamIds } = TeamCredentialResourceDiscoverInputV1Schema.parse(value);
            expect(teamIds).toEqual([resource.teamId]);
            if (!application) return { body: TeamCredentialResourceDiscoveryPageV1Schema.parse({
                resources: [{ ...pendingResource, providerModels: [] }], failures: [], nextCursor: null,
            }) };
            if (JSON.stringify(application) !== JSON.stringify(pendingResource.providerModels[0]!.application)) {
                return { body: TeamCredentialResourceDiscoveryPageV1Schema.parse({ resources: [{ ...pendingResource, providerModels: [],
                    readiness: { kind: 'broker_unavailable', reason: 'projection_unavailable' },
                }], failures: [], nextCursor: null }) };
            }
            requested.resolve();
            return { respondAfter: response.promise,
                body: TeamCredentialResourceDiscoveryPageV1Schema.parse({ resources: [pendingResource], failures: [], nextCursor: null }) };
        } });
        // CLI-created c88 approval: both original operands and the observation preview
        // retain the Agent target and opaque confirmation-source identity.
        const actionArgs = { ...input, modelId: 'gpt-5.5', machineId: 'a512fd05-e2c6-428c-9611-1b11a536df12' };
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'cli' }, requestedSurface: 'cli', summary: 'Allow experimental Provider model',
            actionId, actionArgs, preview: { actionId, actionArgs: getActionSpec(actionId).projectObservationInput?.(actionArgs) },
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
                serverId: home, actionId, requestId: 'pending-provider-approval' } });
        const review = readActionApprovalReview(request);
        const connection = review.admission?.presentation.rows.find(row => row.path === 'connectionId');
        if (!connection || connection.kind !== 'value') throw new Error('Missing connection');
        const hook = await renderHook(() => useApprovalReferenceReading(connection.reference, connection.value, home));
        try {
            await requested.promise;
            await flushHookEffects();
            expect(hook.getCurrent()).toMatchObject({ text: 'Loading…', resolving: true });
        } finally {
            response.resolve();
            await flushHookEffects({ cycles: 25 });
        }
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({
            text: sourceMatches ? `${resource.displayName} · Platform` : 'Unavailable',
        }));
        expect(hook.getCurrent().resolving).not.toBe(true);
    });
});
