import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/protocol/actions/externalActionLimits';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { useWorkflowDefinitionLibrary } from '@/components/workflows/library/workflowLibraryReads';
import { storage } from '@/sync/domains/state/storageStore';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useWorkflowFlowChildren } from './useWorkflowFlowChildren';

const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
// The daemon's contribution projection enters through its external Machine RPC boundary.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
let boundary: Awaited<ReturnType<typeof installWorkflowActionHttpBoundary>> | undefined;
let previousStorageState = storage.getState();
let previousApplied = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();
const workflowRef = 'plugin:example.recipe/check';
const parent = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {},
    blocks: [{ kind: 'workflow', id: 'call', workflowRef, input: {} }],
});
const child = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {},
    blocks: [{ kind: 'wait', id: 'held', document: { text: 'Continue?', references: [], attachments: [] } }],
});
const plugin = { workflow: workflowRef, pluginId: 'example.recipe', version: '1.0.0', title: 'Check', definition: child };
const pluginProjection = (...contributions: Readonly<{ id: string; title: string; description?: string; definition: typeof child }>[]) => ({
    protocolVersion: 1,
    projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById: { [plugin.pluginId]: { id: plugin.pluginId, displayName: plugin.title,
            version: plugin.version, enabled: true, source: { kind: 'path', locator: '/plugins/example.recipe' } } },
        familiesById: { workflows: { family: 'workflows', entriesById: Object.fromEntries(contributions.map(contribution => {
            const id = `${plugin.pluginId}/${contribution.id}`;
            return [id, { id, pluginId: plugin.pluginId, pluginVersion: plugin.version, definition: contribution }];
        })) } },
    }),
});
const projection = () => pluginProjection({ id: 'check', title: plugin.title, definition: child });

await initializeRealAppRuntimeForTests();

beforeEach(async () => {
    previousStorageState = storage.getState();
    previousApplied = getAppliedActiveServerSnapshot();
    previousAvailable = isAppliedActiveServerRuntimeAvailable();
    const runtime = await import('@/sync/domains/server/serverRuntime');
    await runtime.upsertAndActivateServer({ serverUrl: 'http://workflow-flow.test', name: 'Flow' });
    const machine = createPlainMachineRowFixture({ id: 'machine-1', accountId: 'flow-account' });
    boundary = await installWorkflowActionHttpBoundary({ accountId: () => 'flow-account', machineRows: () => [machine], fixtureResponse: async (actionId) => {
        if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [] } };
        throw new Error(`Unexpected workflow HTTP fixture request: ${actionId}`);
    } });
    await (await import('@/sync/runtime/orchestration/connectionManager')).restoreConnectionToActiveServer(boundary.credentials);
    await (await import('@/sync/sync')).sync.refreshMachines();
    boundary.prime();
    machineRpc.mockImplementation(async (request: { method: string }) => {
        if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            throw new Error(`Unexpected workflow Machine RPC: ${request.method}`);
        }
        return projection();
    });
});
afterEach(async () => {
    await standardCleanup();
    (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    machineRpc.mockReset();
    clearDaemonMergedProjectionCacheForTests();
    await boundary?.dispose();
    boundary = undefined;
    storage.setState(previousStorageState);
    publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
});

describe('editor Flow child read lifetime', () => {
    it('renews a mounted child preview when the same Account lifetime retires', async () => {
        const hook = await renderHook(() => useWorkflowFlowChildren(parent, true));
        await vi.waitFor(() => expect(hook.getCurrent().children[workflowRef]).toEqual(child));
        await act(async () => { (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime(); });
        expect(hook.getCurrent().loading).toBe(false);
        expect(hook.getCurrent().children[workflowRef]).toEqual(child);
    });
    it('keeps a pending plugin read loading, then expands the child from the shared library owner', async () => {
        const page = createDeferred<ReturnType<typeof projection>>();
        machineRpc.mockReturnValueOnce(page.promise);
        const hook = await renderHook(() => useWorkflowFlowChildren(parent, true));
        await act(async () => { await Promise.resolve(); });
        expect(hook.getCurrent()).toMatchObject({ loading: true, problem: null, children: {} });
        await act(async () => { page.resolve(projection()); });
        await vi.waitFor(() => expect(hook.getCurrent().children[workflowRef]).toEqual(child));
    });

    it('retries a failed plugin-library read through that owner instead of retrying an empty projection', async () => {
        machineRpc.mockRejectedValueOnce(new Error('transport unavailable'));
        const hook = await renderHook(() => useWorkflowFlowChildren(parent, true));
        await vi.waitFor(() => expect(hook.getCurrent().problem).not.toBeNull());
        await act(async () => { hook.getCurrent().retry(); });
        await vi.waitFor(() => expect(hook.getCurrent().children[workflowRef]).toEqual(child));
        expect(hook.getCurrent().problem).toBeNull();
    });

    it('resolves a plugin child beyond the first shared library page without reporting it missing', async () => {
        // Each descriptor fits, but neighboring descriptors exceed the real Action response
        // envelope together. The production list owner creates every continuation cursor.
        const description = 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 2);
        const filler = (id: string) => ({ id, title: id, description, definition: child });
        const page = createDeferred<ReturnType<typeof projection>>();
        machineRpc.mockReturnValueOnce(page.promise);
        const hook = await renderHook(() => ({ preview: useWorkflowFlowChildren(parent, true), library: useWorkflowDefinitionLibrary() }));
        await vi.waitFor(() => expect(machineRpc).toHaveBeenCalled());
        expect(hook.getCurrent().preview).toMatchObject({ loading: true, problem: null });
        await act(async () => { page.resolve(pluginProjection(filler('aa-first'), filler('bb-second'),
            { id: 'check', title: plugin.title, definition: child }, filler('zz-remaining'))); });
        await vi.waitFor(() => expect(hook.getCurrent().preview.children[workflowRef]).toEqual(child));
        expect(hook.getCurrent().preview.problem).toBeNull();
        expect(hook.getCurrent().library.hasMore).toBe(true);
        expect(hook.getCurrent().library.pluginWorkflows.map(source => source.workflow)).toEqual([
            'plugin:example.recipe/aa-first', 'plugin:example.recipe/bb-second', workflowRef,
        ]);
    });
});
