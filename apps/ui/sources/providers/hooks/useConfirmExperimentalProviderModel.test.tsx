import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1, ProviderConnectionIdSchema } from '@happier-dev/protocol';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createProviderModelProjectionFixture, createProviderModelProjectionGroupFixture, createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary, installProviderConnectionsCatalogHttpBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { TeamCredentialProviderModelCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const confirmSpy = vi.hoisted(() => vi.fn());
const alertSpy = vi.hoisted(() => vi.fn());
const commitSelectionSpy = vi.hoisted(() => vi.fn());

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: confirmSpy, alert: alertSpy } }).module;
});

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
// This hook suite has no live Machine census. Substitute RPC delivery, as in
// the projection hook suite, while keeping Action admission, parsing and Account writes real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: import('@/dev/testkit/harness/providerSettingsHarness').ProviderRpcRequest) => rpc.machineRpc(request),
}));
const account = createProviderSettingsAccountHarness();
let serverId = '';
let otherServerId = '';
let row: ReturnType<typeof installProviderConnectionsCatalogHttpBoundary>;

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const confirmation = {
    kind: 'confirm-experimental',
    connectionId: ProviderConnectionIdSchema.parse('pc_experimental'),
    expectedConnectionRevision: 3,
    agentTargetKey: 'agent:happier.agent.codex/codex',
    modelId: 'experimental-model',
    compatibilityFingerprint: 'compatibility:v1:experimental',
    providerName: 'Gateway',
    modelName: 'Experimental model',
} as const;

const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    connections: [{ v: 1, id: confirmation.connectionId, source: { kind: 'contribution',
        contributionKey: 'happier.provider.deepseek/deepseek' }, role: 'named', displayName: 'DeepSeek',
        displayNameMode: 'custom', revision: confirmation.expectedConnectionRevision, createdAt: 1, updatedAt: 1 }],
});
const teamModel = TeamCredentialProviderModelCatalogEntryV1Schema.parse({
    selection: { kind: 'team_credential_provider_model', resourceId: 'resource-a', teamId: 'team-a',
        expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey: confirmation.agentTargetKey, modelId: 'gpt-5.5' },
    descriptor: { id: 'gpt-5.5', name: 'GPT-5.5' },
    application: { agentTargetKey: confirmation.agentTargetKey, implementationIdentity: { pluginId: 'acme.gateway', localId: 'gateway' },
        endpointTemplateId: 'responses', protocol: 'openai-responses' },
    confirmationSource: { connectionId: 'connected-source:recipient', catalogSourceKey: 's'.repeat(43) },
    sourceRevision: 'source-a', availability: 'available',
});
function teamProjection(status: 'experimental' | 'incompatible' = 'experimental') {
    return createProviderModelProjectionFixture({ agentTargetKey: confirmation.agentTargetKey,
        groups: [createProviderModelProjectionGroupFixture({ connectionId: teamModel.confirmationSource!.connectionId,
            connectionRevision: 0, rows: [{
                ref: { agentTargetKey: confirmation.agentTargetKey, providerConnectionId: teamModel.confirmationSource!.connectionId, modelId: 'gpt-5.5' },
                descriptor: teamModel.descriptor, confirmationSource: teamModel.confirmationSource,
                sources: { manual: false, static: false, probe: false }, confidence: 'account_unverified',
                compatibility: { result: { status, reasons: ['compatibility_evidence_missing'],
                    ...(status === 'experimental' ? { selectedProtocol: 'openai-responses', confirmationScope: { kind: 'model', modelId: 'gpt-5.5' } } : {}) },
                    compatibilityFingerprint: 'compatibility:v1:worker', confirmed: false },
                endpointHealth: 'not_checked', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible',
            }] })] });
}
function installRow(reply?: Parameters<typeof installProviderConnectionsCatalogHttpBoundary>[0]['reply']) {
    row = installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId, catalog, reply });
    return row;
}
function installTeamConsent() {
    row = installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId,
        catalog: ProviderConnectionsCatalogV1Schema.parse({ ...catalog, experimentalBindingConfirmations: [{
            v: 1, ...teamModel.confirmationSource, agentTargetKey: confirmation.agentTargetKey,
            modelId: 'gpt-5.5', compatibilityFingerprint: 'compatibility:v1:worker', confirmedAt: 1,
        }] }) });
}

// Warm the real Sync module after the transport leaves are installed, not inside a test hook's budget.
await loadSyncSingletonForTests();

describe('useConfirmExperimentalProviderModel', () => {
    it.each(['model', 'connection'] as const)('projects a Team selection on its worker and confirms the returned recipient scope before selection (%s)', async scope => {
        const emptyCatalog = { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 };
        serverId = (await account.restore({ catalog: emptyCatalog,
            waivedActions: ['providers.models.experimental.confirm'] })).serverId;
        row = installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId, catalog: emptyCatalog });
        const projection = teamProjection();
        const compatibility = projection.groups[0]!.rows[0]!.compatibility;
        if (compatibility.result.status === 'experimental' && scope === 'connection') {
            compatibility.result.confirmationScope = { kind: 'connection' };
        }
        // The worker belongs to C and never sees B's private catalog. Both
        // replies stay unconfirmed; the real Account read must compose B's write.
        rpc.setResponse(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, projection);
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({ enabled: true, machineId: 'machine-a',
            serverId, agentTargetKey: confirmation.agentTargetKey, refresh: async () => {} }));
        let result = false;
        await act(async () => { result = await hook.getCurrent().confirm({ kind: 'team-model', model: teamModel }, commitSelectionSpy); });
        expect(result).toBe(true);
        expect(rpc.state.requests.map(request => ({ method: request.method, payload: request.payload }))).toEqual([
            expect.objectContaining({ method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
                payload: expect.objectContaining({ machineId: 'machine-a', teamCredentialModel: teamModel, refreshPolicy: 'current_only' }) }),
            expect.objectContaining({ method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
                payload: expect.objectContaining({ machineId: 'machine-a', teamCredentialModel: teamModel, refreshPolicy: 'current_only' }) }),
        ]);
        expect(row.catalog.connections).toEqual([]);
        expect(row.catalog.experimentalBindingConfirmations).toEqual([expect.objectContaining({
            connectionId: teamModel.confirmationSource!.connectionId, catalogSourceKey: teamModel.confirmationSource!.catalogSourceKey,
            modelId: scope === 'model' ? 'gpt-5.5' : null, compatibilityFingerprint: 'compatibility:v1:worker',
        })]);
        expect(commitSelectionSpy).toHaveBeenCalledOnce();
    });

    it('uses the requester catalog confirmation even when the custodian has none', async () => {
        installTeamConsent();
        const projection = teamProjection();
        rpc.setResponse(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, projection);
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({ enabled: true, machineId: 'machine-a',
            serverId, agentTargetKey: confirmation.agentTargetKey, refresh: async () => {} }));
        let result = false;
        await act(async () => { result = await hook.getCurrent().confirm({ kind: 'team-model', model: teamModel }, commitSelectionSpy); });
        expect(result).toBe(true);
        expect(commitSelectionSpy).toHaveBeenCalledOnce();
        expect(row.writes).toBe(0);
    });

    it.each(['custodian-only', 'wrong-source', 'wrong-fingerprint'] as const)(
        'never treats %s consent as requester consent', async scenario => {
            row = installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId,
                catalog: ProviderConnectionsCatalogV1Schema.parse({ ...catalog, experimentalBindingConfirmations:
                    scenario === 'custodian-only' ? [] : [{ v: 1, ...teamModel.confirmationSource,
                        catalogSourceKey: scenario === 'wrong-source' ? 'x'.repeat(43) : teamModel.confirmationSource!.catalogSourceKey,
                        agentTargetKey: confirmation.agentTargetKey, modelId: 'gpt-5.5', confirmedAt: 1,
                        compatibilityFingerprint: scenario === 'wrong-fingerprint' ? 'compatibility:v1:source-only' : 'compatibility:v1:worker',
                    }] }) });
            const projection = teamProjection();
            projection.groups[0]!.rows[0]!.compatibility.confirmed = true;
            rpc.setResponse(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, projection);
            const { describeProviderModels } = await import('@/providers/actions/client');
            const result = await describeProviderModels({ serverId, machineId: 'machine-a',
                agentTargetKey: confirmation.agentTargetKey, teamCredentialModel: teamModel });
            expect(result).toMatchObject({ status: 'success', groups: [{ rows: [{ compatibility: { confirmed: false } }] }] });
            expect(row.writes).toBe(0);
        },
    );

    it('refuses a worker source withdrawn while recipient consent is saved', async () => {
        const emptyCatalog = { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 };
        serverId = (await account.restore({ catalog: emptyCatalog,
            waivedActions: ['providers.models.experimental.confirm'] })).serverId;
        row = installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId, catalog: emptyCatalog });
        rpc.enqueueResponse(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, teamProjection());
        rpc.enqueueResponse(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
            { status: 'error', error: createProviderErrorV1('provider_catalog_unavailable') });
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({ enabled: true, machineId: 'machine-a',
            serverId, agentTargetKey: confirmation.agentTargetKey, refresh: async () => {} }));
        let result = true;
        await act(async () => { result = await hook.getCurrent().confirm({ kind: 'team-model', model: teamModel }, commitSelectionSpy); });
        expect(result).toBe(false);
        expect(hook.getCurrent().error?.code).toBe('provider_catalog_unavailable');
        expect(row.writes).toBe(1);
        expect(commitSelectionSpy).not.toHaveBeenCalled();
        rpc.setResponse(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, teamProjection());
        await act(async () => { result = await hook.getCurrent().retry?.() ?? false; });
        expect(result).toBe(true);
        expect(row.writes).toBe(1);
        expect(commitSelectionSpy).toHaveBeenCalledOnce();
    });

    it('keeps a Team selection pending until its retained commit completes', async () => {
        installTeamConsent();
        rpc.setResponse(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, teamProjection());
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({ enabled: true, machineId: 'machine-a',
            serverId, agentTargetKey: confirmation.agentTargetKey, refresh: async () => {} }));
        const commit = createDeferred<void>();
        let settled = false;
        let result!: Promise<boolean>;
        await act(async () => {
            result = hook.getCurrent().confirm({ kind: 'team-model', model: teamModel }, async () => {
                commitSelectionSpy();
                await commit.promise;
            });
            void result.then(() => { settled = true; });
        });
        await waitForHomeGovernance(() => expect(commitSelectionSpy).toHaveBeenCalledOnce());
        expect(settled).toBe(false);
        expect(hook.getCurrent().pending).toBe(true);
        await act(async () => { commit.resolve(); await result; });
        expect(settled).toBe(true);
    });

    it('refuses a Team model rejected by the worker even when the source reports it confirmed', async () => {
        rpc.setResponse(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, teamProjection('incompatible'));
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({ enabled: true, machineId: 'machine-a',
            serverId, agentTargetKey: confirmation.agentTargetKey, refresh: async () => {} }));
        let result = true;
        await act(async () => { result = await hook.getCurrent().confirm({ kind: 'team-model',
            model: { ...teamModel, compatibility: { ...teamProjection().groups[0]!.rows[0]!.compatibility, confirmed: true } },
        }, commitSelectionSpy); });
        expect(result).toBe(false);
        expect(hook.getCurrent().error?.code).toBe('provider_incompatible_with_agent');
        expect(commitSelectionSpy).not.toHaveBeenCalled();
        expect(row.writes).toBe(0);
    });

    it('retires the Team worker read when the selected Machine changes', async () => {
        const read = createDeferred<ReturnType<typeof teamProjection>>();
        rpc.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, () => read.promise);
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(({ machineId }) => useConfirmExperimentalProviderModel({ enabled: true, machineId,
            serverId, agentTargetKey: confirmation.agentTargetKey, refresh: async () => {} }),
        { initialProps: { machineId: 'machine-a' } });
        let result!: Promise<boolean>;
        await act(async () => { result = hook.getCurrent().confirm({ kind: 'team-model', model: teamModel }, commitSelectionSpy); });
        await waitForHomeGovernance(() => expect(rpc.state.requests).toHaveLength(1));
        await hook.rerender({ machineId: 'machine-b' });
        await act(async () => { read.resolve(teamProjection()); await result; });
        expect(await result).toBe(false);
        expect(commitSelectionSpy).not.toHaveBeenCalled();
        expect(row.writes).toBe(0);
    });

    it('persists opaque recipient catalog consent without a personal connection or private source target', async () => {
        const emptyCatalog = { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 };
        serverId = (await account.restore({ catalog: emptyCatalog,
            waivedActions: ['providers.models.experimental.confirm'] })).serverId;
        row = installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId, catalog: emptyCatalog });
        const sourceConfirmation = { ...confirmation, connectionId: 'connected-source:recipient',
            expectedConnectionRevision: 0, catalogSourceKey: 's'.repeat(43) };
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({ enabled: true, machineId: null,
            serverId, agentTargetKey: confirmation.agentTargetKey, refresh: async () => {} }));
        let result = false;
        await act(async () => { result = await hook.getCurrent().confirm(sourceConfirmation, commitSelectionSpy); });
        expect(result).toBe(true);
        expect(row.catalog.connections).toEqual([]);
        expect(row.catalog.experimentalBindingConfirmations).toEqual([expect.objectContaining({
            connectionId: sourceConfirmation.connectionId, catalogSourceKey: sourceConfirmation.catalogSourceKey,
            compatibilityFingerprint: confirmation.compatibilityFingerprint,
        })]);
        expect(commitSelectionSpy).toHaveBeenCalledOnce();
    });

    it('persists a source-scoped confirmation through the existing Account Action and commits the selection', async () => {
        const emptyCatalog = { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 };
        serverId = (await account.restore({ catalog: emptyCatalog,
            waivedActions: ['providers.models.experimental.confirm'] })).serverId;
        row = installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId, catalog: emptyCatalog });
        const connectedAccountTarget = { kind: 'group' as const,
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'pool-a' };
        const sourceConfirmation = { ...confirmation, connectionId: ProviderConnectionIdSchema.parse('connected-source:catalog-a'),
            expectedConnectionRevision: 0, connectedAccountTarget };
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({ enabled: true, machineId: null,
            serverId, agentTargetKey: confirmation.agentTargetKey, refresh: async () => {} }));
        let result = false;
        await act(async () => { result = await hook.getCurrent().confirm(sourceConfirmation, commitSelectionSpy); });
        expect(result).toBe(true);
        expect(row.catalog.connections).toEqual([]);
        expect(row.catalog.experimentalBindingConfirmations).toEqual([expect.objectContaining({
            connectionId: sourceConfirmation.connectionId, connectedAccountTarget,
            agentTargetKey: confirmation.agentTargetKey, compatibilityFingerprint: confirmation.compatibilityFingerprint,
        })]);
        expect(commitSelectionSpy).toHaveBeenCalledOnce();
    });
    it('honors an experimental-confirm Action waiver without a second unwaivable modal', async () => {
        confirmSpy.mockResolvedValue(false);
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({ enabled: true, machineId: null,
            serverId, agentTargetKey: confirmation.agentTargetKey, refresh: async () => {} }));
        let result = false;
        await act(async () => { result = await hook.getCurrent().confirm(confirmation, commitSelectionSpy); });
        expect(result).toBe(true);
        expect(row.catalog.experimentalBindingConfirmations).toHaveLength(1);
        expect(confirmSpy).not.toHaveBeenCalled();
    });
    beforeEach(async () => {
        confirmSpy.mockReset();
        alertSpy.mockReset();
        rpc.reset();
        commitSelectionSpy.mockReset();
        serverId = (await account.restore({ catalog, waivedActions: ['providers.models.experimental.confirm'] })).serverId;
        installRow();
        otherServerId = await account.addHome({ name: 'Other Provider Home', serverUrl: 'https://provider-settings-other.test', accountId: 'account-a', active: false });
    });
    afterEach(async () => { standardCleanup(); await account.reset(); });

    it('keeps authoring pending until the confirmed selection is committed', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        const mutationResult = createDeferred<void>();
        installRow(() => ({ respondAfter: mutationResult.promise, body: { status: 'updated', revision: 2, cursor: 2 } }));
        const refresh = vi.fn(async () => {});
        const commitSelection = vi.fn();
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            refresh,
        }));

        let confirmationResult: Promise<boolean> | null = null;
        await act(async () => {
            confirmationResult = hook.getCurrent().confirm(confirmation, commitSelection);
            await Promise.resolve();
        });

        await waitForHomeGovernance(() => expect(row.writes).toBe(1));
        expect(hook.getCurrent().pending).toBe(true);
        expect(commitSelection).not.toHaveBeenCalled();

        await act(async () => {
            mutationResult.resolve();
            await confirmationResult;
        });

        expect(commitSelection).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
        expect(hook.getCurrent().pending).toBe(false);
        expect(row.writes).toBe(1);
        expect(rpc.state.requests).toEqual([]);
    });

    it('commits the acknowledged selection while presentation refresh is pending', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        const revalidation = createDeferred<void>();
        const refresh = vi.fn(() => revalidation.promise);
        const commitSelection = vi.fn();
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true, machineId: 'machine-a', serverId,
            agentTargetKey: confirmation.agentTargetKey, refresh,
        }));
        let operation!: Promise<boolean>;
        await act(async () => { operation = hook.getCurrent().confirm(confirmation, commitSelection); });
        try {
            await waitForHomeGovernance(() => expect(refresh).toHaveBeenCalled());
            expect(row.catalog.experimentalBindingConfirmations).toHaveLength(1);
            await act(async () => { await Promise.resolve(); });
            expect(commitSelection).toHaveBeenCalledOnce();
            expect(hook.getCurrent().pending).toBe(false);
        } finally {
            await act(async () => { revalidation.resolve(); await operation; });
        }
    });


    it('does not refresh or select the old scope after an in-flight mutation crosses a scope change', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        const mutationResult = createDeferred<void>();
        installRow(() => ({ respondAfter: mutationResult.promise, body: { status: 'updated', revision: 2, cursor: 2 } }));
        const refresh = vi.fn(async () => {});
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(
            (props: { machineId: string; serverId: string }) => useConfirmExperimentalProviderModel({
                enabled: true,
                machineId: props.machineId,
                serverId: props.serverId,
                agentTargetKey: 'agent:happier.agent.codex/codex',
                refresh,
            }),
            { initialProps: { machineId: 'machine-a', serverId } },
        );

        let pending!: Promise<boolean>;
        act(() => {
            pending = hook.getCurrent().confirm(confirmation, commitSelectionSpy);
        });
        await waitForHomeGovernance(() => expect(row.writes).toBe(1));
        await hook.rerender({ machineId: 'machine-b', serverId: otherServerId });
        await act(async () => mutationResult.resolve());

        await expect(pending).resolves.toBe(false);
        expect(refresh).not.toHaveBeenCalled();
        expect(alertSpy).not.toHaveBeenCalled();
        expect(commitSelectionSpy).not.toHaveBeenCalled();
        expect(row.writes).toBe(1);
        expect(rpc.state.requests).toEqual([]);
    });

    it('exposes an exact typed Account revision failure to the picker instead of flattening it into a modal', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        const expectedError = createProviderErrorV1('provider_connection_changed', {
            connectionId: confirmation.connectionId,
        });
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            refresh: vi.fn(async () => {}),
        }));

        await act(async () => {
            await expect(hook.getCurrent().confirm({ ...confirmation, expectedConnectionRevision: 2 }, commitSelectionSpy)).resolves.toBe(false);
        });

        expect(hook.getCurrent().error).toEqual(expectedError);
        expect(hook.getCurrent().retry).toBeNull();
        expect(row.writes).toBe(0);
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('reconciles a commit-then-reject outcome and never exposes the stored mutation for replay', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        installRow(() => ({ dispatchThenFail: true }));
        const refresh = vi.fn(async () => {});
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            refresh,
        }));

        await act(async () => {
            await expect(hook.getCurrent().confirm(confirmation, commitSelectionSpy)).resolves.toBe(false);
        });
        expect(hook.getCurrent().error).toEqual(createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
            connectionId: confirmation.connectionId,
            machineId: 'machine-a',
        }));
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(row.writes).toBe(1);
        expect(row.catalog.experimentalBindingConfirmations).toHaveLength(1);
        expect(rpc.state.requests).toEqual([]);
        expect(refresh).toHaveBeenCalledOnce();
        expect(commitSelectionSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent().error?.action).toBe('review_current_state');
        expect(hook.getCurrent().retry).toBeNull();
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('does not repeat a successful confirmation mutation when only the presentation refresh fails', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        const refresh = vi.fn(async () => { throw new Error('refresh failed'); });
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            refresh,
        }));

        await act(async () => {
            await expect(hook.getCurrent().confirm(confirmation, commitSelectionSpy)).resolves.toBe(true);
        });

        expect(row.writes).toBe(1);
        expect(rpc.state.requests).toEqual([]);
        expect(refresh).toHaveBeenCalledOnce();
        expect(commitSelectionSpy).toHaveBeenCalledOnce();
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().retry).toBeNull();
    });

    it('refuses a captured retry after the machine/server scope changes', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(
            (props: { machineId: string; serverId: string }) => useConfirmExperimentalProviderModel({
                enabled: true,
                machineId: props.machineId,
                serverId: props.serverId,
                agentTargetKey: 'agent:happier.agent.codex/codex',
                refresh: vi.fn(async () => {}),
            }),
            { initialProps: { machineId: 'machine-a', serverId: 'missing-home' } },
        );
        await act(async () => {
            await hook.getCurrent().confirm(confirmation, commitSelectionSpy);
        });
        const capturedRetry = hook.getCurrent().retry;
        expect(capturedRetry).toBeTypeOf('function');

        await hook.rerender({ machineId: 'machine-b', serverId: otherServerId });
        await act(async () => {
            await expect(capturedRetry?.()).resolves.toBe(false);
        });

        expect(row.writes).toBe(0);
        expect(rpc.state.requests).toEqual([]);
    });

    it('clears a previous failure when a new admitted confirmation succeeds', async () => {
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            refresh: vi.fn(async () => {}),
        }));
        await act(async () => { await hook.getCurrent().confirm({ ...confirmation, expectedConnectionRevision: 2 }, commitSelectionSpy); });
        expect(hook.getCurrent().error).not.toBeNull();

        await act(async () => { await hook.getCurrent().confirm(confirmation, commitSelectionSpy); });

        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().retry).toBeNull();
        expect(row.writes).toBe(1);
        expect(rpc.state.requests).toEqual([]);
    });
    it.each(['Agent target', 'Providers feature', 'nothing'] as const)(
        'keeps the confirmation bound to its original intent when %s retires during canonical approval',
        async retiredInput => {
            await account.home.requireUiApproval(serverId, 'providers.models.experimental.confirm');
            const refresh = vi.fn(async () => undefined);
            const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
            const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
            const { decideApprovalAsInbox } = await import('@/dev/testkit/harness/approvalInbox');
            const hook = await renderHook((props: { enabled: boolean; agentTargetKey: string }) => ({
                confirmation: useConfirmExperimentalProviderModel({
                    ...props, machineId: 'machine-a', serverId, refresh,
                }),
                ready: useProviderActionClient(serverId).ready,
            }), { initialProps: { enabled: true, agentTargetKey: confirmation.agentTargetKey as string } });
            await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
            let execution!: Promise<boolean>;
            await act(async () => {
                execution = hook.getCurrent().confirmation.confirm(confirmation, commitSelectionSpy);
            });
            await waitForHomeGovernance(() => expect(account.home.artifacts(serverId).list()).toHaveLength(1));
            const artifactId = account.home.artifacts(serverId).list()[0]!.id;
            expect(JSON.parse(account.home.artifacts(serverId).readPlainBody(artifactId)!)).toMatchObject({ approval: { flow: 'blocking' } });
            expect(row.writes).toBe(0);
            await hook.rerender({
                enabled: retiredInput !== 'Providers feature',
                agentTargetKey: retiredInput === 'Agent target' ? 'agent:happier.agent.claude/claude' : confirmation.agentTargetKey,
            });
            await decideApprovalAsInbox(serverId, artifactId, 'approve');
            const remainsCurrent = retiredInput === 'nothing';
            await act(async () => { await expect(execution).resolves.toBe(remainsCurrent); });
            expect(row.writes).toBe(remainsCurrent ? 1 : 0);
            expect(row.catalog.experimentalBindingConfirmations).toHaveLength(remainsCurrent ? 1 : 0);
            expect(refresh).toHaveBeenCalledTimes(remainsCurrent ? 1 : 0);
            expect(commitSelectionSpy).toHaveBeenCalledTimes(remainsCurrent ? 1 : 0);
            expect(rpc.state.requests).toEqual([]);
        },
    );

});
