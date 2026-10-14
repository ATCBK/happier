import * as React from 'react';
import '@/dev/testkit/harness/syncSingletonLoader';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { AgentModelsProbeObservationSchema } from '@happier-dev/protocol/capabilities';
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
        if (request.method === RPC_METHODS.CAPABILITIES_INVOKE) return { ok: true, result: AgentModelsProbeObservationSchema.parse({
            availableModels: [
                { id: 'real-model', name: 'Real model', costTier: 'low', capabilities: { structuredOutput: 'supported' } },
                { id: 'rejected-model', name: 'Rejected model', capabilities: { structuredOutput: 'unsupported' } },
                { id: 'unknown-model', name: 'Unknown model', capabilities: { structuredOutput: 'unknown' } },
            ], supportsFreeform: false, source: 'dynamic',
        }) };
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
        const homeId = await homes.addHome({ name: 'Summary discovery', serverUrl: 'https://summary-discovery.example.test',
            accountId: 'summary-discovery-account', accountEncryptionMode: 'plain', currentAccount: true });
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
        getStorage().setState({ settingsScope: scope, profileScope: scope,
            machines: { [machine.id]: machine }, machineListByServerId: { [homeId]: [machine] } });
        const change = vi.fn();
        const selection = vi.fn();
        const screen = await renderSettingsView(<ScmDiffSummaryModelPicker value="" onChange={change}
            onSelection={selection} machineId={machine.id} serverId={homeId} defaultBackendTarget={target} />);
        const menu = () => screen.findAll(node => node.type === DropdownMenu)[0];
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
        expect(rpc.requests.find(request => request.method === RPC_METHODS.CAPABILITIES_INVOKE)).toMatchObject({
            machineId: machine.id, serverId: homeId, payload: {
                method: 'probeModels', params: { backendTarget: expect.objectContaining(target) },
            },
        });
        const rows = menu().props.items.filter((item: { title: string }) => item.title === 'Real model');
        // One row per model: the default is that row, marked, with the catalog's cost tier and no price.
        expect(rows).toHaveLength(1);
        const offered = rows[0];
        expect(offered).toMatchObject({ subtitle: 'Default · Low cost' });
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
        expect(menu().props.selectedId).toBe(offered.id);
        expect(change).not.toHaveBeenCalled();
        expect(getStorage().getState().settings['scm.diffSummary.modelProfileOverride']).toBe('');
        // Choosing the default returns to following it; the catalog's default is never written as a preference.
        await act(async () => { menu().props.onSelect(offered.id); });
        expect(change).toHaveBeenCalledWith('');
        expect(selection).toHaveBeenCalledWith(expect.objectContaining({
            backendTarget: expect.objectContaining(target), modelSelector: expect.objectContaining({ modelId: 'real-model' }),
        }));
        change.mockClear(); selection.mockClear();
        await act(async () => { menu().props.onSelect(id); });
        await vi.waitFor(() => expect(menu().props.items.find((item: { title: string }) => item.title === 'Real model')).toBeDefined());
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
