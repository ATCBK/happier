import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAutomationRunFixture, createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/protocol/actions/externalActionLimits';

// Only Home HTTP/credentials and the native Machine RPC leave the real path.
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
const { createWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
const { useWorkflowDefinitionLibrary, useWorkflowRunWindow, resetWorkflowLibraryReadsForTests } = await import('./workflowLibraryReads');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const route = '/v3/automations/runs/workflow-storage';
const definitionId = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';
const content = createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Continue', references: [], attachments: [] } }] });
let accountId = 'account-a';
let serverId: string;
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();

beforeEach(async () => {
    previous = storage.getState(); applied = getAppliedActiveServerSnapshot(); available = isAppliedActiveServerRuntimeAvailable();
    await home.reset(); accountId = 'account-a';
    serverId = await home.addHome({ name: 'Library Home', serverUrl: 'https://workflow-library.test', accountId });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId, accountId }, workflowRunsById: {}, workflowRunListWindows: {}, workflowRunInvocationsByRunId: {}, machines: {}, machineListByServerId: {} });
    home.answer(serverId, '/v3/automations', { body: { automations: [], nextCursor: null } });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    machineRpc.mockReset();
});
afterEach(async () => {
    await standardCleanup(); resetWorkflowLibraryReadsForTests(); retireActiveServerAccountScopeLifetime();
    clearDaemonMergedProjectionCacheForTests(); await home.reset();
    storage.setState(previous); publishAppliedActiveServerSnapshot(applied, available);
});

async function saved(id = definitionId, title = 'Saved', description?: string) {
    return await createWorkflowDefinition({ definitionId: id, definition: content, metadata: { title, ...(description ? { description } : {}) } });
}

async function runPage(runs: readonly ReturnType<typeof createWorkflowRunSummaryFixture>[], nextCursor?: string, destination?: string, title?: string) {
    const acceptedEnvelopesByRunId: Record<string, string> = {};
    const keyCensusByRunId: Record<string, ReturnType<typeof WorkflowRunRecipientCensusResponseV1Schema.parse>> = {};
    for (const run of runs) {
        const definition = destination ? createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            conversation: { kind: 'existing_session', sessionId: destination, machineId: run.machineId },
        } }) : content;
        const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition, admission: { kind: 'user' },
            effects: { resolveTargetAvailability: async () => true }, context: { source: run.origin.kind === 'automation'
                ? { kind: 'automation', automationId: run.origin.automationId } : { kind: 'inline' }, inputs: {}, machineId: run.machineId,
                executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                ...(run.origin.kind === 'direct' ? { origin: run.origin } : { actionCaller: {
                    kind: 'automationRun' as const, runId: run.id, automationId: run.origin.automationId, cause: { kind: 'manual' as const, invokedAt: 1 },
                } }), ...(title ? { metadata: { title } } : {}), authorization: { principal: { kind: 'host' } } } });
        if (!materialized.ok) throw new Error(`fixture_materialization_failed:${materialized.error.code}`);
        acceptedEnvelopesByRunId[run.id] = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: run.ownerAccountId, runId: run.id }, acceptedSnapshot: materialized.snapshot }));
        keyCensusByRunId[run.id] = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: run.ownerAccountId,
            access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
            ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    }
    return { runs, acceptedEnvelopesByRunId, keyCensusByRunId, ...(nextCursor ? { nextCursor } : {}) };
}

const run = (id: string, state: 'running' | 'failed' | 'succeeded' = 'running') => createWorkflowRunSummaryFixture({ id, state, ownerAccountId: accountId });
const waitLoaded = (hook: { getCurrent(): { status: string } }) => waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('loaded'));

describe('Workflow library reads through real Account Actions and HTTP', () => {
    it('keeps an addressed trigger picker on B while the active library shows the same id from A', async () => {
        await saved(definitionId, 'A workflow');
        const serverB = await home.addHome({ name: 'B library', serverUrl: 'https://workflow-library-b.test',
            accountId: 'account-b', active: false, currentAccount: true });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        home.answer(serverB, '/v3/automations', { body: { automations: [], nextCursor: null } });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverB);
        try {
            await createWorkflowDefinition({ definitionId, definition: content, metadata: { title: 'B workflow' }, accountLifetime: account.accountLifetime });
            const active = await renderHook(() => useWorkflowDefinitionLibrary());
            const addressed = await renderHook(() => useWorkflowDefinitionLibrary({ accountLifetime: account.accountLifetime }));
            await waitLoaded(active); await waitLoaded(addressed);
            expect(active.getCurrent().definitions[0]?.metadata?.title).toBe('A workflow');
            expect(addressed.getCurrent().definitions[0]?.metadata?.title).toBe('B workflow');
            expect(storage.getState().profileScope).toEqual({ serverId, accountId: 'account-a' });
        } finally { account.dispose(); }
    });
    it('settles a missing Account destination instead of inventing a pending read', async () => {
        storage.setState({ profileScope: null });
        const hook = await renderHook(() => useWorkflowRunWindow('destination:stopped-session'));
        expect(hook.getCurrent().status).toBe('failed');
        expect(hook.getCurrent().runIds).toEqual([]);
        expect(home.requestsFor(route)).toEqual([]);
    });

    it('shares visible library demand and preserves row identity and renders on an equal refresh', async () => {
        await saved();
        const pending = createDeferred<void>();
        home.answer(serverId, 'GET /v1/artifacts', { body: home.artifacts(serverId).list(), respondAfter: pending.promise });
        let renders = 0;
        const first = await renderHook(() => { renders++; return useWorkflowDefinitionLibrary(); });
        const second = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => expect(home.requestsFor('/v1/artifacts?limit=500&includeBody=true')).toHaveLength(1));
        await act(async () => pending.resolve());
        await waitLoaded(first); await waitForHomeGovernance(() => expect(first.getCurrent().loadingMore).toBe(false));
        expect(first.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
        expect(second.getCurrent().definitions).toBe(first.getCurrent().definitions);
        const before = first.getCurrent().definitions;
        const settledRenders = renders;
        await act(async () => first.getCurrent().retry());
        await waitForHomeGovernance(() => expect(first.getCurrent().loadingMore).toBe(false));
        expect(first.getCurrent().definitions).toBe(before);
        expect(second.getCurrent().definitions).toBe(before);
        expect(renders).toBe(settledRenders);
    });

    it('reads nothing without demand and serves the current Account after enable', async () => {
        await saved();
        const before = home.requests.length;
        const hook = await renderHook((props: { enabled: boolean }) => useWorkflowDefinitionLibrary(props), { initialProps: { enabled: false } });
        expect(hook.getCurrent().definitions).toEqual([]);
        expect(home.requests.length).toBe(before);
        await hook.rerender({ enabled: true }); await waitLoaded(hook);
        expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
    });

    it('refreshes mounted readers after a definition is created through the real writer', async () => {
        const hook = await renderHook(() => useWorkflowDefinitionLibrary()); await waitLoaded(hook);
        expect(hook.getCurrent().definitions).toEqual([]);
        await act(async () => { await saved(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]));
    });

    it('retains known rows while refreshing and rechecks a wake received during the first page', async () => {
        await saved();
        const firstPage = createDeferred<void>();
        const oldRows = home.artifacts(serverId).list();
        let reads = 0;
        home.answer(serverId, 'GET /v1/artifacts', { select: () => ++reads === 1
            ? { body: oldRows, respondAfter: firstPage.promise } : { body: home.artifacts(serverId).list() } });
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => expect(reads).toBe(1));
        await act(async () => { await saved(secondId, 'Created during read'); });
        await act(async () => firstPage.resolve());
        await waitForHomeGovernance(() => expect(hook.getCurrent().definitions).toHaveLength(2));
        expect(reads).toBe(2);
        const before = hook.getCurrent().definitions;
        const refresh = createDeferred<void>();
        home.answer(serverId, 'GET /v1/artifacts', { body: home.artifacts(serverId).list(), respondAfter: refresh.promise });
        await act(async () => publishHomeAccountChange(serverId));
        expect(hook.getCurrent().definitions).toBe(before);
        await act(async () => refresh.resolve());
        await waitForHomeGovernance(() => expect(hook.getCurrent().loadingMore).toBe(false));
        expect(hook.getCurrent().definitions).toBe(before);
    });

    it('replaces retired same-Account reads without waiting for their old response', async () => {
        await saved();
        const retired = createDeferred<void>();
        let reads = 0;
        home.answer(serverId, 'GET /v1/artifacts', { select: () => ++reads === 1
            ? { body: [], respondAfter: retired.promise } : { body: home.artifacts(serverId).list() } });
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => expect(reads).toBe(1));
        await act(async () => { storage.setState({ profileScope: null }); });
        await act(async () => { storage.setState({ profileScope: { serverId, accountId } }); });
        await waitLoaded(hook);
        expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
        await act(async () => retired.resolve());
        expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
    });

    it('retires pending reads during sign-in restore and never discloses another Account\'s rows', async () => {
        await saved();
        const retired = createDeferred<void>();
        let reads = 0;
        const oldRows = home.artifacts(serverId).list();
        home.answer(serverId, 'GET /v1/artifacts', { select: () => ++reads === 1
            ? { body: oldRows, respondAfter: retired.promise }
            : { body: home.artifacts(serverId).list().filter(row => row.ownerAccountId === accountId) } });
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => expect(reads).toBe(1));
        await act(async () => retireActiveServerAccountScopeLifetime());
        await waitLoaded(hook);
        expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
        const accountB = createDeferred<void>();
        home.answer(serverId, 'GET /v1/artifacts', { body: [], respondAfter: accountB.promise });
        await act(async () => { accountId = 'account-b'; await home.switchAccount(serverId, accountId); storage.setState({ profileScope: { serverId, accountId } }); });
        expect(hook.getCurrent().status).toBe('loading');
        expect(hook.getCurrent().definitions).toEqual([]);
        await act(async () => accountB.resolve());
        await waitLoaded(hook);
        expect(hook.getCurrent().definitions).toEqual([]);
        await act(async () => retired.resolve());
        expect(hook.getCurrent().definitions).toEqual([]);
    });

    it('retains the complete demanded saved span during remount refresh, then removes authoritative deletions', async () => {
        // Real pagination is defined by the public Action envelope's byte budget.
        // Two individually valid headers exceed that combined budget.
        const description = 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 2);
        await saved(definitionId, 'First', description); await saved(secondId, 'Second', description);
        const first = await renderHook(() => useWorkflowDefinitionLibrary()); await waitLoaded(first);
        expect(first.getCurrent().definitions).toHaveLength(1);
        await act(async () => first.getCurrent().loadMore());
        await waitForHomeGovernance(() => { expect(first.getCurrent().definitions).toHaveLength(2); expect(first.getCurrent().loadingMore).toBe(false); });
        const before = first.getCurrent().definitions;
        const refresh = createDeferred<void>();
        const rows = home.artifacts(serverId).list();
        const response = await home.artifacts(serverId).handle('/v1/artifacts?limit=500&includeBody=true');
        if (!response) throw new Error('Expected the canonical Artifact list boundary');
        home.answer(serverId, 'GET /v1/artifacts?limit=500&includeBody=true', { body: await response.json(), respondAfter: refresh.promise });
        const second = await renderHook(() => useWorkflowDefinitionLibrary());
        expect(first.getCurrent().definitions).toBe(before);
        await act(async () => refresh.resolve());
        await waitForHomeGovernance(() => expect(first.getCurrent().loadingMore).toBe(false));
        expect(first.getCurrent().definitions).toBe(before); expect(second.getCurrent().definitions).toBe(before);
        // Return an authoritative smaller collection at the actual network leaf.
        home.answer(serverId, 'GET /v1/artifacts?limit=500&includeBody=true', { body: rows.filter(row => row.id === definitionId) });
        await act(async () => first.getCurrent().retry());
        await waitForHomeGovernance(() => expect(first.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]));
        expect(first.getCurrent().hasMore).toBe(false);
    });

    it('clears retired pagination busy state after a failed replacement and allows retry', async () => {
        const description = 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 2);
        await saved(definitionId, 'First', description); await saved(secondId, 'Second', description);
        const hook = await renderHook(() => useWorkflowDefinitionLibrary()); await waitLoaded(hook);
        const retired = createDeferred<void>();
        home.answer(serverId, 'GET /v1/artifacts', { body: home.artifacts(serverId).list().filter(row => row.id === definitionId), respondAfter: retired.promise });
        await act(async () => hook.getCurrent().loadMore());
        expect(hook.getCurrent().loadingMore).toBe(true);
        home.answer(serverId, 'GET /v1/artifacts', { status: 503, body: { error: 'storage_unavailable' } });
        await act(async () => retireActiveServerAccountScopeLifetime());
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('failed'));
        expect(hook.getCurrent().loadingMore).toBe(false);
        home.answer(serverId, 'GET /v1/artifacts', { body: home.artifacts(serverId).list().filter(row => row.id === definitionId) });
        await act(async () => hook.getCurrent().retry()); await waitLoaded(hook);
        await act(async () => retired.resolve());
        expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
    });

    it('reissues a wake during retired pagination and preserves the queued refresh on the fresh read', async () => {
        const description = 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 2);
        await saved(definitionId, 'First', description); await saved(secondId, 'Second', description);
        const hook = await renderHook(() => useWorkflowDefinitionLibrary()); await waitLoaded(hook);
        const before = hook.getCurrent().definitions;
        const retired = createDeferred<void>();
        home.answer(serverId, 'GET /v1/artifacts', { body: home.artifacts(serverId).list().filter(row => row.id === definitionId), respondAfter: retired.promise });
        await act(async () => hook.getCurrent().loadMore());
        await waitForHomeGovernance(() => expect(home.requests.filter(request => request.path.startsWith('/v1/artifacts?'))).toHaveLength(2));
        const fresh = createDeferred<void>();
        const response = await home.artifacts(serverId).handle('/v1/artifacts?limit=500&includeBody=true');
        if (!response) throw new Error('Expected the canonical Artifact list boundary');
        home.answer(serverId, 'GET /v1/artifacts', { body: await response.json(), respondAfter: fresh.promise });
        await act(async () => {
            storage.setState({ profileScope: null });
            retireActiveServerAccountScopeLifetime();
            storage.setState({ profileScope: { serverId, accountId } });
            publishHomeAccountChange(serverId);
        });
        await waitForHomeGovernance(() => expect(home.requests.filter(request => request.path.startsWith('/v1/artifacts?'))).toHaveLength(3));
        await act(async () => publishHomeAccountChange(serverId));
        home.answer(serverId, 'GET /v1/artifacts', { body: home.artifacts(serverId).list().filter(row => row.id === definitionId) });
        await act(async () => retired.resolve());
        expect(hook.getCurrent().definitions).toBe(before);
        await act(async () => fresh.resolve());
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().status).toBe('loaded'); expect(hook.getCurrent().loadingMore).toBe(false);
            expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
        });
    });

    it('keeps saved rows usable while plugin discovery is pending and retains equal plugin descriptors', async () => {
        await saved();
        const machine = createMachineFixture({ id: 'library-machine', activeAt: Date.now(), daemonState: { status: 'running', pid: 17, contributionRegistryProjectionRevision: 0 } });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        const pending = createDeferred<unknown>(); machineRpc.mockReturnValue(pending.promise);
        const hook = await renderHook(() => useWorkflowDefinitionLibrary()); await waitLoaded(hook);
        await waitForHomeGovernance(() => expect(machineRpc).toHaveBeenCalled());
        expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
        const savedRows = hook.getCurrent().definitions;
        const projection = { protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { 'example.recipe': { id: 'example.recipe', displayName: 'Example recipe', version: '1.2.3', enabled: true, source: { kind: 'path', locator: '/plugins/example.recipe' } } },
            familiesById: { workflows: { family: 'workflows', entriesById: { 'example.recipe/review': { id: 'example.recipe/review', pluginId: 'example.recipe', pluginVersion: '1.2.3',
                definition: { id: 'review', title: 'Plugin review', definition: content } } } } },
        }) };
        await act(async () => pending.resolve(projection));
        await waitForHomeGovernance(() => expect(hook.getCurrent().pluginWorkflows).toHaveLength(1));
        expect(hook.getCurrent().definitions).toBe(savedRows);
        const pluginRows = hook.getCurrent().pluginWorkflows;
        const second = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => expect(second.getCurrent().loadingMore).toBe(false));
        expect(second.getCurrent().pluginWorkflows).toBe(pluginRows);
        expect(second.getCurrent().definitions).toBe(savedRows);
    });

    it('accumulates real byte-paged plugin sources by qualified identity without discarding saved rows', async () => {
        await saved();
        const machine = createMachineFixture({ id: 'paged-plugin-machine', activeAt: Date.now(), daemonState: { status: 'running', pid: 17, contributionRegistryProjectionRevision: 0 } });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        const text = 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 2);
        const definition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait', document: { text, references: [], attachments: [] } }] });
        machineRpc.mockResolvedValue({ protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { 'example.recipe': { id: 'example.recipe', displayName: 'Example recipe', version: '1.2.3', enabled: true, source: { kind: 'path', locator: '/plugins/example.recipe' } } },
            familiesById: { workflows: { family: 'workflows', entriesById: Object.fromEntries(['check', 'review'].map(id => [`example.recipe/${id}`, {
                id: `example.recipe/${id}`, pluginId: 'example.recipe', pluginVersion: '1.2.3', definition: { id, title: id, definition },
            }])) } },
        }) });
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => { expect(hook.getCurrent().pluginWorkflows).toHaveLength(1); expect(hook.getCurrent().loadingMore).toBe(false); });
        const savedRows = hook.getCurrent().definitions;
        await act(async () => hook.getCurrent().loadMore());
        await waitForHomeGovernance(() => expect(hook.getCurrent().pluginWorkflows.map(row => row.workflow)).toEqual(['plugin:example.recipe/check', 'plugin:example.recipe/review']));
        expect(hook.getCurrent().definitions).toBe(savedRows); expect(hook.getCurrent().hasMore).toBe(false);
    });
});

describe('Workflow Run windows through real Account storage', () => {
    const membershipPage = (runs: readonly ReturnType<typeof createWorkflowRunSummaryFixture>[], nextCursor?: string) => ({
        projection: 'membership', runs, acceptedEnvelopesByRunId: {}, keyCensusByRunId: {}, ...(nextCursor ? { nextCursor } : {}),
    });

    it('promotes completed membership through the same window, then returns to compact demand on a shell-only wake', async () => {
        const summary = run('compact-attention');
        const fullPage = await runPage([summary], undefined, undefined, 'Release review');
        home.answer(serverId, route, { body: membershipPage([summary]) });
        const member = await renderHook(() => useWorkflowRunWindow('attention', { projection: 'membership' }));
        await waitLoaded(member);
        expect(home.requestsFor(route)[0]?.input).toMatchObject({ request: { attention: 'required', projection: 'membership' } });
        expect(member.getCurrent().runIds).toEqual([summary.id]);
        expect(member.getCurrent().rows).toEqual([]);
        const pending = createDeferred<void>();
        home.answer(serverId, route, { body: fullPage, respondAfter: pending.promise });
        const full = await renderHook(() => useWorkflowRunWindow('attention'));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(2));
        expect(full.getCurrent().status).toBe('loading');
        expect(full.getCurrent().knownAt).toBeNull();
        expect(full.getCurrent().rows).toEqual([]);
        expect(home.requestsFor(route)[1]?.input).toMatchObject({ request: { attention: 'required' } });
        expect(home.requestsFor(route)[1]?.input).not.toHaveProperty('request.projection');
        await act(async () => pending.resolve()); await waitLoaded(full);
        expect(full.getCurrent().rows[0]?.metadata).toEqual({ kind: 'available', value: { title: 'Release review' } });
        const opened = full.getCurrent().rows[0];
        await full.unmount();
        home.answer(serverId, route, { body: membershipPage([summary]) });
        await act(async () => publishHomeAccountChange(serverId, [`workflow-run:${summary.id}`]));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(3));
        await waitLoaded(member);
        expect(home.requestsFor(route).at(-1)?.input).toHaveProperty('request.projection', 'membership');
        expect(storage.getState().workflowRunsById[Object.keys(storage.getState().workflowRunsById)[0]!]).toBe(opened);
        await act(async () => retireActiveServerAccountScopeLifetime());
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(4));
        expect(home.requestsFor(route).at(-1)?.input).toHaveProperty('request.projection', 'membership');
    });

    it.each([false, true])('honors richer demand while the first membership response is pending (compact failure: %s)', async compactFails => {
        const summary = run('in-flight-attention');
        const pending = createDeferred<void>();
        home.answer(serverId, route, { ...(compactFails ? { status: 503, body: { error: 'storage_unavailable' } }
            : { body: membershipPage([summary]) }), respondAfter: pending.promise });
        await renderHook(() => useWorkflowRunWindow('attention', { projection: 'membership' }));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(1));
        const full = await renderHook(() => useWorkflowRunWindow('attention'));
        expect(home.requestsFor(route)).toHaveLength(1);
        home.answer(serverId, route, { body: await runPage([summary], undefined, undefined, 'Current review') });
        await act(async () => pending.resolve());
        await waitLoaded(full);
        expect(home.requestsFor(route)).toHaveLength(2);
        expect(home.requestsFor(route)[1]?.input).not.toHaveProperty('request.projection');
        expect(full.getCurrent().rows[0]?.metadata).toEqual({ kind: 'available', value: { title: 'Current review' } });
    });

    it('retains opened rows and their Home qualification while promoting compact membership', async () => {
        const summary = run('retained-private');
        const opened = workflowRunRowFromSummary(summary, { kind: 'available', value: { title: 'Last known review' } });
        storage.getState().upsertWorkflowRuns([opened]);
        const bodies = storage.getState().workflowRunsById;
        home.answer(serverId, route, { body: membershipPage([summary]) });
        const member = await renderHook(() => useWorkflowRunWindow('attention', { projection: 'membership' })); await waitLoaded(member);
        expect(member.getCurrent().rows).toEqual([]);
        expect(storage.getState().workflowRunsById).toBe(bodies);
        const pending = createDeferred<void>();
        home.answer(serverId, route, { body: await runPage([summary], undefined, undefined, 'Last known review'), respondAfter: pending.promise });
        const full = await renderHook(() => useWorkflowRunWindow('attention'));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(2));
        expect(full.getCurrent().status).toBe('loading');
        expect(full.getCurrent().knownAt).toBeNull();
        expect(full.getCurrent().serverId).toBe(serverId);
        expect(full.getCurrent().rows).toEqual([opened]);
        await act(async () => pending.resolve()); await waitLoaded(full);
    });

    it('retires a pending compact read and its queued promotion without letting its late answer affect the new lifetime', async () => {
        const old = run('retired-member');
        const pending = createDeferred<void>();
        home.answer(serverId, route, { body: membershipPage([old]), respondAfter: pending.promise });
        await renderHook(() => useWorkflowRunWindow('attention', { projection: 'membership' }));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(1));
        const full = await renderHook(() => useWorkflowRunWindow('attention'));
        const current = run('current-member');
        const fullPage = await runPage([current], undefined, undefined, 'Current lifetime');
        home.answer(serverId, route, { select: input => ({ body: input && typeof input === 'object' && 'request' in input
            && input.request && typeof input.request === 'object' && 'projection' in input.request
            ? membershipPage([current]) : fullPage }) });
        await act(async () => retireActiveServerAccountScopeLifetime());
        await waitLoaded(full);
        expect(full.getCurrent().runIds).toEqual([current.id]);
        const count = home.requestsFor(route).length;
        await act(async () => pending.resolve());
        expect(home.requestsFor(route)).toHaveLength(count);
        expect(full.getCurrent().runIds).toEqual([current.id]);
        expect(full.getCurrent().rows[0]?.metadata).toEqual({ kind: 'available', value: { title: 'Current lifetime' } });
    });

    it('restates compact membership through its body-free frontier and clears an exhausted window', async () => {
        const ordered = [60, 50, 40, 30, 20, 10].map(value => createWorkflowRunSummaryFixture({ ...run(`member-${value}`),
            createdAt: new Date(value * 1000).toISOString() }));
        home.answer(serverId, route, { body: membershipPage(ordered.slice(1, 3), 'member-second') });
        const member = await renderHook(() => useWorkflowRunWindow('attention', { projection: 'membership' })); await waitLoaded(member);
        home.answer(serverId, route, { body: membershipPage(ordered.slice(3, 5), 'member-tail') });
        await act(async () => member.getCurrent().loadMore());
        await waitForHomeGovernance(() => expect(member.getCurrent().runIds).toHaveLength(4));
        const pages = [membershipPage(ordered.slice(0, 2), 'fresh-second'), membershipPage(ordered.slice(2, 4), 'fresh-third'),
            membershipPage(ordered.slice(5))];
        home.answer(serverId, route, { select: () => ({ body: pages.shift() }) });
        await act(async () => publishHomeAccountChange(serverId, ['workflow-run:member-20']));
        await waitForHomeGovernance(() => expect(member.getCurrent().runIds).toEqual(ordered.filter(row => row.id !== 'member-20').map(row => row.id)));
        expect(storage.getState().workflowRunsById).toEqual({});
        expect(storage.getState().workflowRunListWindows.attention?.frontier).toEqual({ id: 'member-10', createdAt: 10_000 });
        home.answer(serverId, route, { body: membershipPage([]) });
        await act(async () => publishHomeAccountChange(serverId, ['workflow-run:member-10']));
        await waitForHomeGovernance(() => expect(member.getCurrent().runIds).toEqual([]));
        expect(storage.getState().workflowRunListWindows.attention?.frontier).toBeUndefined();
        expect(member.getCurrent().hasMore).toBe(false);
    });

    it('issues one full refresh for one wake while shell and row demand are both mounted', async () => {
        const summary = run('shared-wake');
        home.answer(serverId, route, { body: membershipPage([summary]) });
        const member = await renderHook(() => useWorkflowRunWindow('attention', { projection: 'membership' })); await waitLoaded(member);
        home.answer(serverId, route, { body: await runPage([summary]) });
        const full = await renderHook(() => useWorkflowRunWindow('attention')); await waitLoaded(full);
        expect(home.requestsFor(route)).toHaveLength(2);
        const pending = createDeferred<void>();
        const current = { ...summary, revision: summary.revision + 1 };
        home.answer(serverId, route, { body: await runPage([current]), respondAfter: pending.promise });
        await act(async () => publishHomeAccountChange(serverId, [`workflow-run:${summary.id}`]));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(3));
        await act(async () => pending.resolve());
        await waitForHomeGovernance(() => expect(full.getCurrent().rows[0]?.summary?.revision).toBe(current.revision));
        expect(home.requestsFor(route)).toHaveLength(3);
    });

    it('replays the membership frontier through full pages without mixing projection-bound cursors', async () => {
        const ordered = [50, 40, 30, 20].map(value => createWorkflowRunSummaryFixture({ ...run(`frontier-${value}`),
            createdAt: new Date(value * 1000).toISOString() }));
        home.answer(serverId, route, { body: membershipPage(ordered.slice(1), 'compact-tail') });
        const member = await renderHook(() => useWorkflowRunWindow('attention', { projection: 'membership' }));
        await waitLoaded(member);
        const pages = [await runPage(ordered.slice(0, 2), 'full-second'), await runPage(ordered.slice(2), 'full-tail')];
        home.answer(serverId, route, { select: () => ({ body: pages.shift() }) });
        const full = await renderHook(() => useWorkflowRunWindow('attention')); await waitLoaded(full);
        expect(full.getCurrent().runIds).toEqual(ordered.map(row => row.id));
        expect(home.requestsFor(route).slice(1).map(request => request.input)).toEqual([
            expect.objectContaining({ request: { attention: 'required' } }),
            expect.objectContaining({ request: { attention: 'required', cursor: 'full-second' } }),
        ]);
        expect(storage.getState().workflowRunListWindows.attention?.nextCursor).toBe('full-tail');
    });

    it('shares destination demand, keeps destinations distinct from origins, and avoids unrelated renders', async () => {
        const summary = createWorkflowRunSummaryFixture({ id: 'writes-here', ownerAccountId: accountId, origin: { kind: 'direct', originSessionId: 'another-session' } });
        const pending = createDeferred<void>();
        home.answer(serverId, route, { body: await runPage([summary], undefined, 'bot-session'), respondAfter: pending.promise });
        let renders = 0;
        const first = await renderHook(() => { renders++; return useWorkflowRunWindow('destination:bot-session'); });
        const second = await renderHook(() => useWorkflowRunWindow('destination:bot-session'));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(1));
        expect(home.requestsFor(route)[0]?.input).toMatchObject({ request: { targetSessionId: 'bot-session', states: ['queued', 'claimed', 'running', 'pause_requested', 'paused', 'interrupted'] } });
        await act(async () => pending.resolve()); await waitLoaded(first);
        expect(first.getCurrent().runIds).toEqual(['writes-here']); expect(second.getCurrent().runIds).toBe(first.getCurrent().runIds);
        expect(first.getCurrent().rows[0]?.summary?.origin).toEqual(summary.origin);
        const windowSnapshot = first.getCurrent();
        await first.rerender();
        expect(first.getCurrent()).toBe(windowSnapshot);
        const ids = first.getCurrent().runIds; const before = renders;
        await act(async () => storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run('unrelated'))]));
        expect(first.getCurrent().runIds).toBe(ids); expect(renders).toBe(before);
    });

    it('pages exact Automation history and retains its filter on continuation', async () => {
        home.answer(serverId, route, { body: await runPage([run('newest')], 'next') });
        const first = await renderHook(() => useWorkflowRunWindow('automation:habit')); await waitLoaded(first);
        const second = await renderHook(() => useWorkflowRunWindow('automation:habit'));
        home.answer(serverId, route, { body: await runPage([run('older')]) });
        await act(async () => first.getCurrent().loadMore());
        await waitForHomeGovernance(() => expect(second.getCurrent().runIds).toEqual(['newest', 'older']));
        expect(home.requestsFor(route).at(-1)?.input).toMatchObject({ request: { automationId: 'habit', cursor: 'next' } });
    });

    it.each(['all', 'active', 'attention', 'automationAttention'] as const)('renews %s demand and subsequent Home wakes after retirement', async windowId => {
        home.answer(serverId, route, { body: await runPage([run('run-0')]) });
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [createAutomationRunFixture({ id: 'run-0', state: 'failed' })], nextCursor: null } });
        const hook = await renderHook(() => useWorkflowRunWindow(windowId)); await waitLoaded(hook);
        expect(hook.getCurrent().runIds).toContain('run-0');
        home.answer(serverId, route, { body: await runPage([run('run-1')]) });
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [createAutomationRunFixture({ id: 'run-1', state: 'failed' })], nextCursor: null } });
        await act(async () => retireActiveServerAccountScopeLifetime());
        await waitForHomeGovernance(() => expect(hook.getCurrent().runIds).toContain('run-1'));
        home.answer(serverId, route, { body: await runPage([run('run-2')]) });
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [createAutomationRunFixture({ id: 'run-2', state: 'failed' })], nextCursor: null } });
        await act(async () => publishHomeAccountChange(serverId, [windowId === 'automationAttention' ? 'automation:automation-1' : 'workflow-run:run-2']));
        await waitForHomeGovernance(() => expect(hook.getCurrent().runIds).toContain('run-2'));
    });

    it('does not restart disabled or unmounted Run windows on retirement and wakes', async () => {
        home.answer(serverId, route, { body: await runPage([]) });
        await renderHook(() => useWorkflowRunWindow('attention', { enabled: false }));
        const active = await renderHook(() => useWorkflowRunWindow('active')); await waitLoaded(active); await active.unmount();
        const before = home.requestsFor(route).length;
        await act(async () => { retireActiveServerAccountScopeLifetime(); publishHomeAccountChange(serverId, ['workflow-run:changed']); });
        expect(home.requestsFor(route)).toHaveLength(before);
    });

    it.each(['reactivation', 'restore'] as const)('replaces a pending %s read and refuses its late rows', async kind => {
        const retired = createDeferred<void>();
        home.answer(serverId, route, { body: await runPage([run('retired-run')]), respondAfter: retired.promise });
        const hook = await renderHook(() => useWorkflowRunWindow('all'));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(1));
        home.answer(serverId, route, { body: await runPage([run('current-run')]) });
        if (kind === 'restore') await act(async () => retireActiveServerAccountScopeLifetime());
        else {
            await act(async () => storage.setState({ profileScope: null }));
            await act(async () => storage.setState({ profileScope: { serverId, accountId } }));
        }
        await waitLoaded(hook); expect(hook.getCurrent().runIds).toEqual(['current-run']);
        await act(async () => retired.resolve());
        expect(hook.getCurrent().runIds).toEqual(['current-run']); expect(storage.getState().workflowRunsById['retired-run']).toBeUndefined();
    });

    it('keeps one window\'s render scope local while another loads and while disabled', async () => {
        home.answer(serverId, route, { body: await runPage([run('window-run')]) });
        let renders = 0;
        const all = await renderHook((props: { enabled: boolean }) => { renders++; return useWorkflowRunWindow('all', props); }, { initialProps: { enabled: true } });
        await waitLoaded(all); const before = renders;
        const pending = createDeferred<void>();
        home.answer(serverId, route, { body: await runPage([]), respondAfter: pending.promise });
        await renderHook(() => useWorkflowRunWindow('active'));
        await act(async () => pending.resolve()); expect(renders).toBe(before);
        await all.rerender({ enabled: false }); const disabled = renders;
        await act(async () => storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ ...run('window-run', 'succeeded'), revision: 2 }))]));
        expect(renders).toBe(disabled);
        home.answer(serverId, route, { body: await runPage([createWorkflowRunSummaryFixture({ ...run('window-run', 'succeeded'), revision: 2 })]) });
        await all.rerender({ enabled: true }); await waitLoaded(all);
        expect(all.getCurrent().rows[0]?.summary?.state).toBe('succeeded');
    });
});

describe('Automation attention through real HTTP and the shared Run store', () => {
    it.each([false, true])('rechecks a Home wake during the first read or continuation (%s)', async continuation => {
        const pending = createDeferred<void>();
        const failed = createAutomationRunFixture({ id: 'cleared', state: 'failed' });
        home.answer(serverId, '/v3/automations/runs', { body: { runs: continuation ? [] : [failed], nextCursor: continuation ? 'tail' : null }, ...(continuation ? {} : { respondAfter: pending.promise }) });
        const hook = await renderHook(() => useWorkflowRunWindow('automationAttention'));
        if (continuation) {
            await waitLoaded(hook);
            home.answer(serverId, '/v3/automations/runs', { body: { runs: [failed], nextCursor: null }, respondAfter: pending.promise });
            await act(async () => hook.getCurrent().loadMore());
        }
        await waitForHomeGovernance(() => expect(home.requests.filter(request => request.path.startsWith('/v3/automations/runs?'))).toHaveLength(continuation ? 2 : 1));
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [], nextCursor: null } });
        await act(async () => publishHomeAccountChange(serverId, ['automation:automation-1']));
        await act(async () => pending.resolve());
        await waitForHomeGovernance(() => { expect(hook.getCurrent().status).toBe('loaded'); expect(hook.getCurrent().runIds).toEqual([]); });
        expect(hook.getCurrent().hasMore).toBe(false);
    });

    it('refreshes every loaded attention page, removing cleared failures while retaining older selection', async () => {
        const failed = (createdAt: number) => createAutomationRunFixture({ id: `run-${createdAt}`, createdAt, state: 'failed' });
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [failed(40), failed(30)], nextCursor: 'next' } });
        const hook = await renderHook(() => useWorkflowRunWindow('automationAttention')); await waitLoaded(hook);
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [failed(20), failed(10)], nextCursor: 'tail' } });
        await act(async () => hook.getCurrent().loadMore());
        await waitForHomeGovernance(() => expect(hook.getCurrent().runIds).toEqual(['run-40', 'run-30', 'run-20', 'run-10']));
        const pages = [{ runs: [failed(60), failed(50)], nextCursor: 'current-2' }, { runs: [failed(40), failed(30)], nextCursor: 'current-3' }, { runs: [failed(10), failed(5)], nextCursor: 'current-4' }];
        home.answer(serverId, '/v3/automations/runs', { select: () => ({ body: pages.shift() }) });
        await act(async () => hook.getCurrent().retry());
        await waitForHomeGovernance(() => expect(hook.getCurrent().runIds).toEqual(['run-60', 'run-50', 'run-40', 'run-30', 'run-10', 'run-5']));
        expect(storage.getState().workflowRunListWindows.automationAttention?.nextCursor).toBe('current-4');
        expect(home.requests.filter(request => request.path.startsWith('/v3/automations/runs?')).map(request => request.path)).toEqual([
            '/v3/automations/runs?limit=20&attention=required', '/v3/automations/runs?limit=20&cursor=next&attention=required',
            '/v3/automations/runs?limit=20&attention=required', '/v3/automations/runs?limit=20&cursor=current-2&attention=required',
            '/v3/automations/runs?limit=20&cursor=current-3&attention=required',
        ]);
    });

    it('shares attention, retains known rows on failure, and removes cleared rows on retry', async () => {
        const failed = createAutomationRunFixture({ id: 'pre-session', state: 'failed', errorCode: 'machine_unavailable' });
        const pending = createDeferred<void>();
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [failed], nextCursor: null }, respondAfter: pending.promise });
        const first = await renderHook(() => useWorkflowRunWindow('automationAttention'));
        const second = await renderHook(() => useWorkflowRunWindow('automationAttention'));
        await act(async () => pending.resolve()); await waitLoaded(first);
        expect(first.getCurrent().rows[0]?.automation).toEqual(failed); expect(second.getCurrent().rows[0]).toBe(first.getCurrent().rows[0]);
        expect(second.getCurrent().runIds).toBe(first.getCurrent().runIds);
        home.answer(serverId, '/v3/automations/runs', { status: 503, body: { error: 'storage_unavailable' } });
        await act(async () => first.getCurrent().retry());
        await waitForHomeGovernance(() => expect(first.getCurrent().status).toBe('failed')); expect(first.getCurrent().rows[0]?.automation).toEqual(failed);
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [], nextCursor: null } });
        await act(async () => second.getCurrent().retry()); await waitLoaded(first); expect(first.getCurrent().rows).toEqual([]);
    });

    it('discards an old Account\'s late attention page after a real credential switch', async () => {
        const pending = createDeferred<void>();
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [createAutomationRunFixture({ id: 'foreign-late', state: 'failed' })], nextCursor: null }, respondAfter: pending.promise });
        const hook = await renderHook(() => useWorkflowRunWindow('automationAttention'));
        await waitForHomeGovernance(() => expect(home.requests.filter(request => request.path.startsWith('/v3/automations/runs?'))).toHaveLength(1));
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [], nextCursor: null } });
        await act(async () => { accountId = 'account-b'; await home.switchAccount(serverId, accountId); storage.setState({ profileScope: { serverId, accountId } }); });
        await waitLoaded(hook); await act(async () => pending.resolve());
        expect(hook.getCurrent().rows).toEqual([]); expect(storage.getState().workflowRunsById['foreign-late']).toBeUndefined();
    });
});
