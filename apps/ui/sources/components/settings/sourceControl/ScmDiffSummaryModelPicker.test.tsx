import * as React from 'react';
import '@/dev/testkit/harness/syncSingletonLoader';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

const rpc = vi.hoisted(() => ({ requests: [] as Array<Readonly<{ method: string; machineId: string; serverId?: string | null; payload: unknown }>> }));
// Home HTTP, device credentials and Machine RPC are the boundaries; Action admission,
// Account catalog, discovery/cache and picker projection remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const invoke = async (request: typeof rpc.requests[number]): Promise<unknown> => {
        rpc.requests.push(request);
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
            return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
                projection: { v: 2, generation: 1, familiesById: {} } });
        throw new Error(`Unexpected Machine RPC: ${request.method}`);
    };
    // The arbitrary generic wire return is narrowed by real response schemas above this boundary.
    return createServerScopedMachineRpcBoundaryMock(invoke as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope);
});
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@expo/vector-icons/Ionicons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    const icons = createExpoVectorIconsMock();
    return { default: icons.Ionicons, Ionicons: icons.Ionicons };
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
const disposeActionLoader = await installRealActionExecutorModuleLoader();
afterAll(disposeActionLoader);
const { renderSettingsView } = await import('@/dev/testkit/harness/settingsViewHarness');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { ScmDiffSummaryModelPicker } = await import('./ScmDiffSummaryModelPicker');
const { getStorage } = await import('@/sync/domains/state/storage');
const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
const { resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { resetAcpCatalogEngineForTests } = await import('@/sync/engine/settings/acpCatalogEngine');
const { resetAcpCatalogSnapshotsForTests } = await import('@/sync/store/settings/acpCatalogSnapshot');
const { getAcpCatalogSnapshot } = await import('@/sync/store/settings/acpCatalogSnapshot');
const { readCachedDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { standardCleanup } = await import('@/dev/testkit/cleanup/standardCleanup');

describe('Summary model discovery', () => {
    const initialStorage = getStorage().getState();
    beforeEach(async () => { await homes.reset(); rpc.requests = []; resetDynamicModelProbeCacheForTests(); clearDaemonMergedProjectionCacheForTests(); resetAcpCatalogEngineForTests(); resetAcpCatalogSnapshotsForTests(); });
    afterEach(async () => { standardCleanup(); getStorage().setState(initialStorage, true); await homes.reset(); });
    it.each([
        { name: 'Codex', target: { kind: 'backend' as const, backendId: 'codex' }, configured: false },
        { name: 'configured ACP', target: { kind: 'backend' as const, backendId: 'review-bot', configuredBackendId: 'review-bot' }, configured: true },
    ])('discovers $name without saving a fabricated model choice', async ({ target, configured }) => {
        const serverUrl = 'https://summary-discovery.example.test';
        const serverIdentityId = 'srv_summary_discovery';
        const accountId = 'summary-discovery-account';
        const token = `test.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.test`;
        const homeId = await homes.addHome({ name: 'Summary discovery', serverUrl, serverIdentityId,
            accountId, credentials: { token }, accountEncryptionMode: 'plain', currentAccount: true });
        const scope = { serverId: homeId, accountId: 'summary-discovery-account' };
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: configured ? [{ id: target.backendId,
            name: target.backendId, title: 'Review Bot', launch: { kind: 'command' as const, command: 'review-cli', args: ['acp'] }, env: {}, createdAt: 1, updatedAt: 1 }] : [] });
        homes.answer(homeId, ACP_CATALOG_ROWS_ROUTE_V1, { body: AcpCatalogRowReadResponseV1Schema.parse({
            status: 'present', revision: 1, content: { t: 'plain', v: record },
        }) });
        homes.answer(homeId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } });
        const machine = createMachineFixture({ id: 'summary-discovery-machine', activeAt: Date.now() });
        const observations: Array<string | undefined> = [];
        let discoveries = 0;
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId,
            machineId: machine.id, actionId: 'agents.models.list', tokenEpoch: 1,
            execute(input, context) {
                expect(input).toMatchObject({ purpose: 'scm_diff_summary', machineId: machine.id });
                const discoveryTargetKey = input && typeof input === 'object' && 'discoveryTargetKey' in input ? input.discoveryTargetKey : undefined;
                if (discoveryTargetKey) expect(discoveryTargetKey).toBe(buildBackendTargetKeyV2(target));
                expect(context.target).toEqual({ kind: 'machine', machineId: machine.id });
                observations.push(typeof discoveryTargetKey === 'string' ? discoveryTargetKey : undefined);
                if (discoveryTargetKey) discoveries += 1;
                const automaticModels = [{ id: 'initial-model', name: 'Initial model', costTier: 'low' as const,
                    capabilities: { structuredOutput: 'supported' as const } }];
                const models = discoveries === 0 ? automaticModels : [...automaticModels,
                    { id: 'real-model', name: 'Real model', costTier: 'low' as const, capabilities: { structuredOutput: 'supported' as const } },
                    { id: 'rejected-model', name: 'Rejected model', capabilities: { structuredOutput: 'unsupported' as const } },
                    { id: 'unknown-model', name: 'Unknown model', capabilities: { structuredOutput: 'unknown' as const } },
                    ...(discoveries > 1 ? [{ id: 'refreshed-model', name: 'Refreshed model', capabilities: { structuredOutput: 'supported' as const } }] : []),
                ];
                const profiles = buildScmDiffSummaryModelProfiles({ backendTarget: readBackendTargetRefV2(target), models });
                return { items: [], scmDiffSummaryCatalog: { profiles,
                    automaticProfiles: configured ? [] : buildScmDiffSummaryModelProfiles({ backendTarget: readBackendTargetRefV2(target), models: automaticModels }),
                    discoveryTargetKeys: [buildBackendTargetKeyV2(target)] } };
            } });
        for (const path of ['/v1/machines', '/v1/actions/agents.models.list/execution-authorization', '/v1/actions/agents.models.list']) {
            homes.answer(homeId, path, { select: async input => {
                const response = await boundary.handle(new URL(path, serverUrl), input === undefined ? undefined
                    : { method: 'POST', body: JSON.stringify(input) });
                if (!response) throw new Error(`Unexpected catalog boundary path: ${path}`);
                return { body: await response.json() };
            } });
        }
        getStorage().setState({ settingsScope: scope, profileScope: scope,
            machines: { [machine.id]: machine }, machineListByServerId: { [homeId]: [machine] } });
        const change = vi.fn();
        const selection = vi.fn();
        const screen = await renderSettingsView(<ScmDiffSummaryModelPicker value="" onChange={change}
            onSelection={selection} machineId={machine.id} serverId={homeId} defaultBackendTarget={target} />);
        const menu = () => screen.findAll(node => node.type === DropdownMenu)[0];
        await act(async () => { menu().props.onOpenChange(true); });
        const diagnostic = () => JSON.stringify({ paths: homes.requests.map(request => request.path), rpc: rpc.requests,
            catalog: getAcpCatalogSnapshot(scope), projection: readCachedDaemonMergedProjectionCacheEntry({ machineId: machine.id, serverId: homeId }),
            items: menu().props.items.map(({ id, title, disabled, subtitle }: { id: string; title: string; disabled?: boolean; subtitle?: string }) => ({ id, title, disabled, subtitle })) });
        const id = `backend-discovery:${buildBackendTargetKeyV2(target)}`;
        await vi.waitFor(() => expect(menu().props.items.find((item: { id: string }) => item.id === id),
            diagnostic()).toBeDefined());
        const discovery = menu().props.items.find((item: { id: string }) => item.id === id);
        await act(async () => { menu().props.onSelect(discovery.id); });
        expect(change).not.toHaveBeenCalled();
        expect(selection).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(menu().props.items.find((item: { title: string }) => item.title === 'Real model'),
            diagnostic()).toBeDefined());
        expect(discoveries).toBe(1);
        expect(rpc.requests.some(request => request.method === RPC_METHODS.CAPABILITIES_INVOKE)).toBe(false);
        const rows = menu().props.items.filter((item: { title: string }) => item.title === 'Real model');
        // Discovery adds choices without changing the automatic default marker.
        expect(rows).toHaveLength(1);
        const offered = rows[0];
        expect(offered).toMatchObject({ subtitle: 'Low cost' });
        expect(offered.disabled).not.toBe(true);
        // Models that cannot write a walkthrough are not dead rows: the agent's section says once how many it leaves out.
        expect(menu().props.items.some((item: { title: string }) => item.title === 'Rejected model' || item.title === 'Unknown model')).toBe(false);
        expect(menu().props.showCategoryTitles).toBe(true);
        expect(menu().props.categoryDecorations[offered.category]).toMatchObject({ note: '2 models can’t write walkthroughs' });
        expect(menu().props.categoryDecorations[offered.category].icon).toBeTruthy();
        // Discovery is one operation inside that agent's section and does not repeat the agent's name.
        const sectionOperation = menu().props.items.find((item: { id: string }) => item.id === id);
        expect(sectionOperation).toMatchObject({ category: offered.category });
        expect(sectionOperation.subtitle).toBeUndefined();
        expect(menu().props.items.some((item: { id: string }) => item.id === '')).toBe(false);
        const automatic = menu().props.items.find((item: { title: string }) => item.title === 'Initial model');
        expect(automatic).toMatchObject({ subtitle: configured ? 'Low cost' : 'Default · Low cost' });
        expect(menu().props.selectedId).toBe(configured ? '' : automatic.id);
        expect(change).not.toHaveBeenCalled();
        expect(getStorage().getState().settings['scm.diffSummary.modelProfileOverride']).toBe('');
        // Dismissing preserves discovered choices, but reopening must use the Machine's cache.
        await act(async () => { menu().props.onOpenChange(false); });
        const beforeReopen = observations.length;
        await act(async () => { menu().props.onOpenChange(true); });
        await vi.waitFor(() => expect(observations.length).toBeGreaterThan(beforeReopen));
        expect(observations.slice(beforeReopen).every(key => key === undefined)).toBe(true);
        await vi.waitFor(() => expect(menu().props.items.some((item: { title: string }) => item.title === 'Real model')).toBe(true));
        expect(discoveries).toBe(1);
        // A second explicit operation refreshes even though the same target remains selected for discovery.
        await act(async () => { menu().props.onSelect(id); });
        await vi.waitFor(() => expect(menu().props.items.some((item: { title: string }) => item.title === 'Refreshed model')).toBe(true));
        expect(discoveries).toBe(2);
        expect(change).not.toHaveBeenCalled();
        expect(selection).not.toHaveBeenCalled();
        // Choosing the default returns to following it; the catalog's default is never written as a preference.
        await act(async () => { menu().props.onSelect(automatic.id); });
        expect(change).toHaveBeenCalledWith(configured ? automatic.id : '');
        expect(selection).toHaveBeenCalledWith(expect.objectContaining({
            backendTarget: expect.objectContaining(target), modelSelector: expect.objectContaining({ modelId: 'initial-model' }),
        }));
        await screen.unmount();
    });
    it('offers no Load models operation, and no placeholder model row, when no machine can answer it', async () => {
        const screen = await renderSettingsView(<ScmDiffSummaryModelPicker value="" onChange={vi.fn()} />);
        const items: ReadonlyArray<{ id: string; title: string }> = screen.findAll(node => node.type === DropdownMenu)[0]!.props.items;
        expect(items.some(item => item.id.startsWith('backend-discovery:'))).toBe(false);
        expect(items.some(item => item.id === '')).toBe(false);
        await screen.unmount();
    });
});
