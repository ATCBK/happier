import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { AutomationDefinitionDetailSchema, AutomationDefinitionListItemSchema, AutomationDefinitionReconcileRequestSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { AutomationStoredWorkflowDefinitionRecipeV2Schema, AutomationStoredWorkflowDefinitionV2Schema } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';

// The real Action owner asks for destructive confirmation before removing a set.
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home); installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { listWorkflowTriggerSets, removeWorkflowTrigger, updateWorkflowTrigger } = await import('./workflowTriggerActions');
const { useWorkflowTriggerSets } = await import('@/components/workflows/triggers/useWorkflowTriggerSets');
const { useSessionTriggerLastRuns } = await import('@/components/workflows/triggers/useSessionTriggerLastRuns');
const { useServerCredentialAccountScopeStates } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
const { resetWorkflowLibraryReadsForTests } = await import('@/components/workflows/library/workflowLibraryReads');
let serverId: string;
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();
beforeEach(async () => {
    previous = storage.getState(); applied = getAppliedActiveServerSnapshot(); available = isAppliedActiveServerRuntimeAvailable();
    await home.reset();
    serverId = await home.addHome({ name: 'Trigger Home', serverUrl: 'https://trigger-read.test', accountId: 'account-one' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId, accountId: 'account-one' }, workflowTriggerSetsById: {}, workflowTriggerSetIdsByQuery: {}, workflowRunsById: {}, workflowRunListWindows: {} });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
});
afterEach(async () => {
    await standardCleanup(); resetWorkflowLibraryReadsForTests(); retireActiveServerAccountScopeLifetime();
    await home.reset(); storage.setState(previous); publishAppliedActiveServerSnapshot(applied, available);
});

function automation(id: string, revision = 1, enabled = true) {
    const inlineDefinition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Continue', references: [], attachments: [] } }] });
    return AutomationDefinitionDetailSchema.parse({ id, name: 'Inline trigger', description: null, enabled,
        workflowDefinitionId: null, scopeSessionId: null, targetType: null, existingSessionId: null, templateVersion: revision,
        lastRunAt: null, createdAt: 1, updatedAt: revision, assignments: [{ machineId: 'machine-a', enabled: true, priority: 0, updatedAt: 1 }], triggers: [],
        executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: revision,
            workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition } }, triggerEvidence: null }),
    });
}

function listed(row: ReturnType<typeof automation>) {
    const { executionRecipe: _recipe, ...publicRow } = row;
    return AutomationDefinitionListItemSchema.parse(publicRow);
}

describe('Account trigger reads through real Action and Automation owners', () => {
    it('retains the authoritative delete revision when an already-committed update ACK arrives late', async () => {
        let row: ReturnType<typeof automation> | null = automation('delayed-ack', 10);
        home.answer(serverId, '/v3/automations', { body: { automations: [listed(row)], nextCursor: null } });
        home.answer(serverId, 'GET /v3/automations/delayed-ack', { select: () => row ? { body: row } : { status: 404, body: { error: 'automation_not_found' } } });
        const [set] = await listWorkflowTriggerSets({ scope: 'account_inline' });
        expect(set?.revision).toBe(10);
        const pending = createDeferred<void>();
        home.answer(serverId, 'PUT /v3/automations/delayed-ack', { select: input => {
            const request = AutomationDefinitionReconcileRequestSchema.parse(input);
            expect(request).toMatchObject({ expectedTemplateVersion: 10, enabled: false });
            row = AutomationDefinitionDetailSchema.parse({ ...automation('delayed-ack', 11, request.enabled),
                ...(request.executionRecipe === undefined ? {} : { executionRecipe: request.executionRecipe }) });
            return { body: row, respondAfter: pending.promise };
        } });
        const updated = updateWorkflowTrigger({ automationId: 'delayed-ack', expectedRevision: 10, patch: { enabled: false } });
        await waitForHomeGovernance(() => expect(row?.templateVersion).toBe(11));
        home.answer(serverId, 'DELETE /v3/automations/delayed-ack', { select: () => { row = null; return { body: { ok: true, removedRevision: 11 } }; } });
        await removeWorkflowTrigger({ automationId: 'delayed-ack' });
        storage.getState().applyWorkflowTriggerSetPage({ queryKey: 'account_inline', sets: [] });
        await act(async () => pending.resolve()); await updated;
        expect(storage.getState().workflowTriggerSetsById['delayed-ack']).toBeUndefined();
        expect(storage.getState().workflowTriggerSetIdsByQuery.account_inline).toEqual([]);
    });

    it('removes a Manual set from every cached membership without changing other sets or Run history', async () => {
        const manual = automation('retained-manual', 3, false); const other = automation('unrelated', 3, false);
        home.answer(serverId, '/v3/automations', { body: { automations: [listed(manual), listed(other)], nextCursor: null } });
        home.answer(serverId, '/v3/automations/retained-manual', { body: manual });
        home.answer(serverId, '/v3/automations/unrelated', { body: other });
        const sets = await listWorkflowTriggerSets({ scope: 'account_inline' });
        storage.getState().applyWorkflowTriggerSetPage({ queryKey: 'account_all', sets });
        const unrelated = storage.getState().workflowTriggerSetsById.unrelated;
        const history = { 'past-run': workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'past-run', state: 'succeeded', origin: { kind: 'automation', automationId: manual.id } })) };
        storage.setState({ workflowRunsById: history });
        home.answer(serverId, 'DELETE /v3/automations/retained-manual', { body: { ok: true } });
        expect(await removeWorkflowTrigger({ automationId: manual.id })).toEqual({ automationId: manual.id, deleted: true });
        expect(storage.getState().workflowTriggerSetsById).toEqual({ unrelated });
        expect(storage.getState().workflowTriggerSetIdsByQuery).toEqual({ account_inline: ['unrelated'], account_all: ['unrelated'] });
        expect(storage.getState().workflowRunsById).toBe(history);
    });

    it('reads the addressed Home and retains its facts on failed refresh without publishing into the focused Home', async () => {
        const targetId = serverId; const serverIds = [targetId]; const row = automation('addressed-rule');
        home.answer(targetId, '/v3/automations', { body: { automations: [listed(row)], nextCursor: null } });
        home.answer(targetId, '/v3/automations/addressed-rule', { body: row });
        const focused = await home.addHome({ name: 'Focused Home', serverUrl: 'https://trigger-read-focused.test', accountId: 'focused-owner' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ profileScope: { serverId: focused, accountId: 'focused-owner' }, workflowTriggerSetsById: {}, workflowTriggerSetIdsByQuery: {} });
        const hook = await renderHook(() => {
            const scopes = useServerCredentialAccountScopeStates(serverIds);
            const binding = scopes.get(resolveServerProfileScopeIdForIdentifier(targetId))?.binding ?? null;
            return useWorkflowTriggerSets({ scope: 'account_all' }, binding);
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        const recipe = AutomationStoredWorkflowDefinitionRecipeV2Schema.parse(row.executionRecipe);
        if (recipe.workflow.t !== 'plain') throw new Error('Expected plain fixture content');
        const context = AutomationStoredWorkflowDefinitionV2Schema.parse(recipe.workflow.v);
        expect(hook.getCurrent().sets).toMatchObject([{ automationId: row.id, revision: row.templateVersion, enabled: row.enabled,
            scopeSessionId: null, health: 'available', target: { kind: 'inline', definition: context.inlineDefinition }, context,
            placements: [{ machineId: 'machine-a', directory: '/repo' }], project: { machineId: 'machine-a', directory: '/repo' }, triggers: [] }]);
        const known = hook.getCurrent().sets;
        expect(home.requests.filter(request => request.path.startsWith('/v3/automations')).every(request => request.serverId === targetId)).toBe(true);
        expect(storage.getState().workflowTriggerSetsById).toEqual({});
        home.answer(targetId, '/v3/automations', { status: 503, body: { error: 'storage_unavailable' } });
        await act(async () => publishHomeAccountChange(targetId));
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('failed')); expect(hook.getCurrent().sets).toBe(known);
        const retry = createDeferred<void>();
        home.answer(targetId, '/v3/automations', { body: { automations: [listed(row)], nextCursor: null }, respondAfter: retry.promise });
        await act(async () => hook.getCurrent().retry()); expect(hook.getCurrent().sets).toBe(known);
        await act(async () => retry.resolve()); await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(storage.getState().profileScope?.accountId).toBe('focused-owner');
    });

    it('pages the shared Run window until a habit has its true latest result', async () => {
        // Unopened content is explicit here; the last-result consumer needs the
        // public index, not a fabricated private accepted snapshot.
        const route = '/v3/automations/runs/workflow-storage';
        const page = (id: string, automationId: string, nextCursor?: string) => ({ runs: [createWorkflowRunSummaryFixture({ id,
            ownerAccountId: 'account-one', state: 'failed', origin: { kind: 'automation', automationId } })],
            acceptedEnvelopesByRunId: {}, keyCensusByRunId: {}, ...(nextCursor ? { nextCursor } : {}) });
        let reads = 0;
        home.answer(serverId, route, { select: () => ({ body: ++reads === 1 ? page('other-run', 'other', 'next') : page('habit-run', 'habit') }) });
        const ids = ['habit']; const hook = await renderHook(() => useSessionTriggerLastRuns(ids));
        await waitForHomeGovernance(() => expect(hook.getCurrent().lastRunsByAutomationId.habit?.state).toBe('failed'));
        expect(home.requestsFor(route).map(request => request.input)).toEqual([
            expect.objectContaining({ request: {} }), expect.objectContaining({ request: { cursor: 'next' } }),
        ]);
    });

    it('shares one real HTTP read without letting a cancelled consumer abort another', async () => {
        const pending = createDeferred<void>();
        home.answer(serverId, '/v3/automations', { body: { automations: [], nextCursor: null }, respondAfter: pending.promise });
        const controller = new AbortController();
        const retired = listWorkflowTriggerSets({ scope: 'account_all' }, { signal: controller.signal }).catch(() => 'aborted');
        const live = listWorkflowTriggerSets({ scope: 'account_all' });
        await waitForHomeGovernance(() => expect(home.requests.filter(request => request.path.startsWith('/v3/automations'))).toHaveLength(1));
        controller.abort(); await act(async () => pending.resolve());
        expect(await retired).toBe('aborted'); expect(await live).toEqual([]);
    });

    it('does not rerender or refetch a Scheduled section for unrelated Run and invocation facts', async () => {
        home.answer(serverId, '/v3/automations', { body: { automations: [], nextCursor: null } });
        let renders = 0;
        const hook = await renderHook(() => { renders++; return useWorkflowTriggerSets({ scope: 'account_all' }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        const before = renders; const reads = home.requests.filter(request => request.path.startsWith('/v3/automations')).length;
        await act(async () => storage.setState({ workflowRunsById: {}, workflowRunInvocationsByRunId: {} }));
        expect(renders).toBe(before); expect(home.requests.filter(request => request.path.startsWith('/v3/automations'))).toHaveLength(reads);
    });
});
