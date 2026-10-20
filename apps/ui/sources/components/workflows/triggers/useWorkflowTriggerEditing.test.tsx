import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowTriggerSetV1Schema, AutomationDefinitionCreateRequestSchema, AutomationDefinitionDetailSchema,
    AutomationDefinitionListResponseSchema, AutomationDefinitionReconcileRequestSchema, AutomationStoredWorkflowDefinitionRecipeV2Schema,
    ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, WorkflowDefinitionArtifactHeaderV1Schema,
    WorkflowDefinitionArtifactBodyV1Schema, AutomationTriggerIdSchema, type AutomationDefinitionDetail,
    type AutomationTriggerDefinitionInput, type WorkflowTriggerSetV1 } from '@happier-dev/protocol';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

// Native confirmation is the user-input boundary; these Save/history cases accept it.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } =
    await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { useWorkflowTriggerEditing } = await import('./useWorkflowTriggerEditing');
const { editWorkflowTriggerDraft } = await import('./workflowTriggerDraft');
const { useWorkflowTriggerSets } = await import('./useWorkflowTriggerSets');

const definitionId = '00000000-0000-4000-8000-000000000001';
const projectTarget = { machineId: 'm1', directory: '/repo' };
const trigger = { kind: 'schedule', enabled: true, schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } } as const;
const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'set-1', revision: 1, enabled: true, health: 'available', project: projectTarget,
    target: { kind: 'workflow', ref: definitionId }, triggers: [{ ...trigger, id: 't1', revision: 1, createdAt: 1, updatedAt: 1,
        nextRunAt: null, triggerDefinitionEnvelope: null }] });
const definition = createWorkflowDefinitionFixture({
    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
    inputs: [{ name: 'name', valueType: 'string', required: false }],
});
let rows: AutomationDefinitionDetail[] = [];
let serverId: string;
let disposeLoader: (() => void) | undefined;
let listReply: (() => Promise<ReturnType<typeof AutomationDefinitionListResponseSchema.parse>>)| undefined;
let beforeWrite: (() => Promise<void>) | undefined;
const writes: Array<ReturnType<typeof AutomationDefinitionCreateRequestSchema.parse> | ReturnType<typeof AutomationDefinitionReconcileRequestSchema.parse>> = [];

// Only the Home's stored Automation rows/CAS are synthetic. The Action front door,
// registration, codecs, live-definition reader and hook acknowledgements run for real.
function seed(value: WorkflowTriggerSetV1) {
    const row = AutomationDefinitionDetailSchema.parse({ id: value.automationId, name: 'Workflow triggers', description: null,
        enabled: value.enabled, workflowDefinitionId: definitionId, scopeSessionId: null, targetType: null, existingSessionId: null,
        templateVersion: value.revision, lastRunAt: null, createdAt: 1, updatedAt: 1,
        assignments: [{ machineId: value.project?.machineId ?? projectTarget.machineId, enabled: true, priority: 0, updatedAt: 1 }],
        executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: value.revision,
            workflow: { t: 'plain', v: value.context ?? { workspace: { directory: projectTarget.directory }, executionTarget: { kind: 'session' } } },
            triggerEvidence: null }), triggers: value.triggers });
    rows = [row];
    installRow(row.id);
}
function listRows() {
    return AutomationDefinitionListResponseSchema.parse({ automations: rows.map(({ executionRecipe: _recipe, templateCiphertext: _template, ...row }) => ({
        ...row, triggers: row.triggers.map(({ triggerDefinitionEnvelope: _envelope, ...trigger }) => trigger),
    })), nextCursor: null });
}
function persistedTrigger(id: string, value: AutomationTriggerDefinitionInput, revision = 1): AutomationDefinitionDetail['triggers'][number] {
    if (value.kind !== 'schedule') throw new Error('Creation fixture supports schedules only');
    return { ...value, id: AutomationTriggerIdSchema.parse(id), revision, createdAt: 1, updatedAt: 1, nextRunAt: null, triggerDefinitionEnvelope: null };
}
function installRow(id: string) {
    const path = `/v3/automations/${id}`;
    home.answer(serverId, `GET ${path}`, { select: () => ({ body: rows.find(row => row.id === id) }) });
    home.answer(serverId, `PUT ${path}`, { select: async raw => {
        const input = AutomationDefinitionReconcileRequestSchema.parse(raw);
        writes.push(input);
        const current = rows.find(row => row.id === id);
        if (!current) return { status: 404, body: { error: 'not_found' } };
        if (input.expectedTemplateVersion !== current.templateVersion) return { status: 409, body: { error: 'template_version_conflict' } };
        if ([...input.triggers.filter(value => value.kind === 'existing'), ...input.removedTriggers]
            .some(value => current.triggers.find(trigger => trigger.id === value.triggerId)?.revision !== value.expectedRevision)) {
            return { status: 409, body: { error: 'trigger_revision_conflict' } };
        }
        await beforeWrite?.();
        const row = AutomationDefinitionDetailSchema.parse({ ...current, name: input.name, description: input.description, enabled: input.enabled,
            workflowDefinitionId: input.workflowDefinitionId ?? current.workflowDefinitionId,
            executionRecipe: input.executionRecipe ?? current.executionRecipe, templateVersion: current.templateVersion + 1,
            assignments: input.assignments.map(value => ({ ...value, enabled: value.enabled ?? true, priority: value.priority ?? 0, updatedAt: 1 })),
            triggers: input.triggers.map(value => {
                if (value.kind === 'new') return persistedTrigger(value.triggerId, value.trigger);
                const trigger = current.triggers.find(candidate => candidate.id === value.triggerId);
                if (!trigger) throw new Error('Missing retained trigger');
                return { ...trigger, ...(value.trigger ?? {}), ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
                    revision: trigger.revision + (value.trigger || value.enabled !== undefined ? 1 : 0) };
            }) });
        rows = rows.map(value => value.id === id ? row : value);
        return { body: row };
    } });
}
function listRequests() { return home.requests.filter(request => request.path.startsWith('/v3/automations?')); }
async function seedChannels() {
    const { PLUGIN_MANIFEST } = await import('@happier-dev/plugins-channels/manifest');
    const { normalizePluginAccountCollectionContractV1, PluginAccountCollectionContributionV1Schema } = await import('@happier-dev/protocol');
    const { replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    const contribution = PLUGIN_MANIFEST.contributes?.accountCollections?.find(entry => entry.id === 'channel-state');
    if (!contribution) throw new Error('Missing Channels producer contract');
    const contract = normalizePluginAccountCollectionContractV1({ pluginId: 'happier.channels',
        contribution: PluginAccountCollectionContributionV1Schema.parse(contribution) });
    const scope = storage.getState().profileScope;
    if (!scope) throw new Error('Active Account required');
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{
        pluginId: contract.pluginId, response: { availabilityCursor: 1, packageAssets: [],
            hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
            intent: { pluginId: contract.pluginId, desiredVersion: null, enabled: true, offlineUiHosting: 'enabled', revision: 'intent-1',
                writableCollections: [{ pluginId: contract.pluginId, collectionId: contract.collectionId, schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest }] },
            release: null, uiArtifacts: [] },
    }] } });
    home.answer(serverId, '/v1/plugins/data/contract', { body: { access: 'readOnly', contract } });
    home.answer(serverId, '/v1/plugins/data/query', { body: { rows: [], changeCursor: 1 } });
}
function resetTriggerSets() {
    const state = storage.getState();
    if (!('resetWorkflowTriggerSets' in state) || typeof state.resetWorkflowTriggerSets !== 'function') throw new Error('Real trigger store reset required');
    state.resetWorkflowTriggerSets();
}
let previous = storage.getState();
let previousAppliedSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
beforeEach(async () => {
    await loadSyncSingletonForTests();
    previous = storage.getState();
    previousAppliedSnapshot = getAppliedActiveServerSnapshot();
    previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
    await home.reset();
    disposeLoader = await installRealActionExecutorModuleLoader();
    serverId = await home.addHome({ name: 'Trigger history', serverUrl: `https://trigger-history-${crypto.randomUUID()}.test`, accountId: 'account-a' });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' },
        sessions: { 'session-a': createSessionFixture({ id: 'session-a', serverId, active: false, metadata: {
            machineId: projectTarget.machineId, path: projectTarget.directory, host: 'test', homeDir: '/home/test' } }) } });
    resetTriggerSets();
    rows = [];
    writes.length = 0;
    listReply = undefined;
    beforeWrite = undefined;
    home.answer(serverId, 'GET /v3/automations', { select: async () => ({ body: await listReply?.() ?? listRows() }) });
    home.answer(serverId, 'POST /v3/automations', { select: async raw => {
        const input = AutomationDefinitionCreateRequestSchema.parse(raw);
        writes.push(input);
        await beforeWrite?.();
        const row = AutomationDefinitionDetailSchema.parse({ id: input.automationId, name: input.name, description: input.description ?? null,
            enabled: input.enabled, workflowDefinitionId: input.workflowDefinitionId ?? null, scopeSessionId: input.scopeSessionId ?? null,
            targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
            executionRecipe: input.executionRecipe, assignments: input.assignments?.map(value => ({ ...value,
                enabled: value.enabled ?? true, priority: value.priority ?? 0, updatedAt: 1 })) ?? [],
            triggers: input.triggers.map(value => persistedTrigger(value.triggerId, value.trigger)) });
        rows = [...rows, row];
        installRow(row.id);
        return { body: row };
    } });
    await home.artifacts(serverId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: definitionId,
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encodePlainArtifactStoredContent(WorkflowDefinitionArtifactHeaderV1Schema.parse({ kind: 'workflow-definition.v1', definitionId,
            revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'History' }, previewSteps: [] })),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(WorkflowDefinitionArtifactBodyV1Schema.parse({ kind: 'workflow-definition.v1', definition })) }),
    }) });
    await seedChannels();
});
afterEach(async () => {
    await standardCleanup();
    resetTriggerSets();
    (await import('../library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    await home.reset();
    disposeLoader?.();
    storage.setState(previous);
    publishAppliedActiveServerSnapshot(previousAppliedSnapshot, previousRuntimeAvailable);
});

describe('workflow trigger editing lifetime', () => {
    it('renews a pending Session-trigger read after same-Account retirement', async () => {
        const { useSessionTriggers } = await import('./useSessionTriggers');
        const retired = createDeferred<void>();
        let first = true;
        listReply = async () => { if (first) { first = false; await retired.promise; } return listRows(); };
        const hook = await renderHook(() => useSessionTriggers('session-a'));
        expect(hook.getCurrent().status).toBe('loading');
        await act(async () => { (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime(); await seedChannels(); });
        expect(hook.getCurrent().status).toBe('ready');
        expect(hook.getCurrent().pullRequestLinks).toEqual([]);
        listReply = async () => { throw new Error('Replacement collection unavailable'); };
        await act(async () => (await import('@/sync/api/plugins/data/pluginCollectionChangeWatch')).resetActivePluginCollectionChanges());
        expect(hook.getCurrent().status).toBe('failed');
        retired.resolve();
    });

    it('renews a mounted Workflow-trigger collection after same-Account retirement', async () => {
        seed(set);
        const hook = await renderHook(() => useWorkflowTriggerSets({ workflow: definitionId }));
        expect(hook.getCurrent().status).toBe('ready');
        const loaded = hook.getCurrent().sets;
        expect(loaded).toMatchObject([set]);
        await act(async () => (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime());
        expect(hook.getCurrent().status).toBe('ready');
        expect(hook.getCurrent().sets).toEqual(loaded);
    });

    it('loads a new Account’s session triggers without claiming the previous Account’s settled status', async () => {
        const { useSessionTriggers } = await import('./useSessionTriggers');
        const hook = await renderHook(() => useSessionTriggers('session-a'));
        expect(hook.getCurrent().status).toBe('ready');
        const next = createDeferred<void>();
        listReply = async () => { await next.promise; return listRows(); };
        await act(async () => { await home.switchAccount(serverId, 'account-b'); storage.setState({ profileScope: { serverId, accountId: 'account-b' } }); await seedChannels(); });
        expect(hook.getCurrent().status).toBe('loading');
        expect(hook.getCurrent().pullRequestLinks).toEqual({ status: 'loading' });
        await act(async () => { next.resolve(); await next.promise; });
        expect(hook.getCurrent().status).toBe('ready');
    });
    it('does not reread an unchanged semantic query when its request object is replaced', async () => {
        const hook = await renderHook(useWorkflowTriggerSets, { initialProps: { workflow: definitionId } });
        expect(hook.getCurrent().status).toBe('ready');
        await hook.rerender({ workflow: definitionId });
        expect(listRequests()).toHaveLength(1);
        const otherId = '00000000-0000-4000-8000-000000000002';
        await hook.rerender({ workflow: otherId });
        expect(listRequests().map(request => new URL(request.path, 'https://home.test').searchParams.get('workflowDefinitionId')))
            .toEqual([definitionId, otherId]);
    });
    it('restores semantic history across addition acknowledgement without duplicating a saved trigger', async () => {
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'history', projectTarget } });
        const before = hook.getCurrent().captureSnapshot();
        const next = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'c1', trigger });
        const after = hook.getCurrent().captureSnapshot(next);
        await act(async () => hook.getCurrent().setDraft(next));
        await act(async () => { await hook.getCurrent().save(definitionId, () => true); });
        expect(hook.getCurrent().dirty).toBe(false);
        await act(async () => { await hook.getCurrent().restoreSnapshot(before); });
        expect(hook.getCurrent().draft.removes).toEqual([rows[0]!.triggers[0]!.id]);
        await act(async () => { await hook.getCurrent().restoreSnapshot(after); });
        expect(hook.getCurrent().dirty).toBe(false);
        expect(hook.getCurrent().draft.adds).toEqual([]);
    });

    it('can Undo the first trigger Save before the created definition id reaches the hook props', async () => {
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId: null, sourceKey: 'new-history', projectTarget } });
        const before = hook.getCurrent().captureSnapshot();
        await act(async () => { await hook.getCurrent().restoreSnapshot(before); });
        expect(hook.getCurrent().dirty).toBe(false);
        const next = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'c1', trigger });
        const after = hook.getCurrent().captureSnapshot(next);
        await act(async () => hook.getCurrent().setDraft(next));
        await act(async () => { await hook.getCurrent().save(definitionId, () => true); });
        await act(async () => { await hook.getCurrent().restoreSnapshot(before); });
        expect(hook.getCurrent().draft.removes).toEqual([rows[0]!.triggers[0]!.id]);
        await act(async () => { await hook.getCurrent().restoreSnapshot(after); });
        expect(hook.getCurrent().dirty).toBe(false);
    });

    it('refuses Undo of a private Event whose removal is already being saved without consuming the current draft', async () => {
        const first = set.triggers[0]!;
        if (first.kind !== 'schedule') throw new Error('schedule fixture required');
        const { schedule: _schedule, nextRunAt: _nextRunAt, ...base } = first;
        const eventSet = WorkflowTriggerSetV1Schema.parse({ ...set, triggers: [{ ...base, kind: 'pluginEvent',
            eventRef: { pluginId: 'plugin', localId: 'event' }, sourceSelectorId: 'source', sourceContractVersion: 1,
            observation: { kind: 'socket', watcher: null }, sourceStatus: null, sourceCatalogStatus: null, triggerDefinitionEnvelope: 'sealed-private' }] });
        seed(eventSet);
        const deferred = createDeferred<void>();
        beforeWrite = () => deferred.promise;
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'private-history', projectTarget } });
        const before = hook.getCurrent().captureSnapshot();
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'remove', triggerId: eventSet.triggers[0]!.id })));
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        await waitForHomeGovernance(() => expect(writes).toHaveLength(1));
        expect(() => hook.getCurrent().restoreSnapshot(before)).toThrowError(expect.objectContaining({ code: 'workflow_trigger_restore_requires_setup' }));
        expect(hook.getCurrent().draft.removes).toEqual(['t1']);
        await act(async () => { deferred.resolve(); await saving; });
        expect(hook.getCurrent().dirty).toBe(false);
    });

    it('keeps an Undo made while a removal is being saved after its acknowledgement', async () => {
        seed(set);
        const deferred = createDeferred<void>();
        beforeWrite = () => deferred.promise;
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'history', projectTarget } });
        const before = hook.getCurrent().captureSnapshot();
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'remove', triggerId: set.triggers[0]!.id })));
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        await waitForHomeGovernance(() => expect(writes).toHaveLength(1));
        await act(async () => { await hook.getCurrent().restoreSnapshot(before); });
        await act(async () => { deferred.resolve(); await saving; });
        expect(hook.getCurrent().draft.adds).toEqual([{ clientId: 'saved:t1', trigger }]);
        expect(hook.getCurrent().dirty).toBe(true);
    });

    it('restores deleted schedules and set context after Save, and reuses the replacement identity on redo', async () => {
        const original = WorkflowTriggerSetV1Schema.parse({ ...set, context: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inputs: { name: 'old' } } });
        seed(original);
        const removedProject = { machineId: 'm2', directory: '/other' };
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'history', projectTarget } });
        const before = hook.getCurrent().captureSnapshot();
        let next = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'remove', triggerId: set.triggers[0]!.id });
        next = editWorkflowTriggerDraft(next, { kind: 'setContext', context: { project: removedProject, inputs: { name: 'new' } } });
        const after = hook.getCurrent().captureSnapshot(next);
        await act(async () => hook.getCurrent().setDraft(next));
        await act(async () => { await hook.getCurrent().save(definitionId, () => true); });
        await act(async () => { await hook.getCurrent().restoreSnapshot(before); });
        expect(hook.getCurrent().draft.adds).toEqual([{ clientId: 'saved:t1', trigger }]);
        expect(hook.getCurrent().draft.context).toEqual({ project: projectTarget, inputs: { name: 'old' } });
        await act(async () => { await hook.getCurrent().save(definitionId, () => true); });
        const replacementId = rows[0]!.triggers[0]!.id;
        expect(replacementId).not.toBe('t1');
        await act(async () => { await hook.getCurrent().restoreSnapshot(after); });
        expect(hook.getCurrent().draft.removes).toEqual([replacementId]);
        expect(hook.getCurrent().draft.adds).toEqual([]);
    });

    it('resets pending edits across source, Account and server changes, including unsaved sources', async () => {
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId: null, sourceKey: 'new-a', projectTarget } });
        const add = async () => act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'c1', trigger })));
        await add();
        expect(hook.getCurrent().dirty).toBe(true);
        await hook.rerender({ definitionId: null, sourceKey: 'new-b', projectTarget });
        expect(hook.getCurrent().dirty).toBe(false);
        await add();
        await act(async () => { await home.switchAccount(serverId, 'account-b'); storage.setState({ profileScope: { serverId, accountId: 'account-b' } }); });
        expect(hook.getCurrent().dirty).toBe(false);
        await add();
        await act(async () => {
            const other = await home.addHome({ name: 'Other', serverUrl: 'https://trigger-other.test', accountId: 'account-b' });
            storage.setState({ profileScope: { serverId: other, accountId: 'account-b' } });
        });
        expect(hook.getCurrent().dirty).toBe(false);
    });

    it('subtracts acknowledged additions while keeping edits made during Save', async () => {
        const deferred = createDeferred<void>();
        beforeWrite = () => deferred.promise;
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'saved-a', projectTarget } });
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'captured', trigger })));
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'later', trigger })));
        await act(async () => { deferred.resolve(); await saving; });
        expect(hook.getCurrent().draft.adds.map((add) => add.clientId)).toEqual(['later']);
    });

    it.each(['change', 'discard'] as const)('keeps a %s made to an addition while Save is pending on its new saved identity', async (edit) => {
        const deferred = createDeferred<void>();
        beforeWrite = () => deferred.promise;
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'saved-a', projectTarget } });
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'c1', trigger })));
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        const changed = { ...trigger, enabled: false, schedule: { ...trigger.schedule, scheduleExpr: '0 8 * * *' } };
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft,
            edit === 'change' ? { kind: 'add', clientId: 'c1', trigger: changed } : { kind: 'discardAdd', clientId: 'c1' })));
        await act(async () => { deferred.resolve(); await saving; });
        expect(hook.getCurrent().draft.adds).toEqual([]);
        const savedId = rows[0]!.triggers[0]!.id;
        if (edit === 'change') expect(hook.getCurrent().draft.updates).toEqual({ [savedId]: { trigger: { kind: 'schedule', schedule: changed.schedule }, enabled: false } });
        else expect(hook.getCurrent().draft.removes).toEqual([savedId]);
    });

    it('keeps later trigger and context values while acknowledging the captured update batch', async () => {
        const original = WorkflowTriggerSetV1Schema.parse({ ...set, context: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inputs: { name: 'old' } } });
        const capturedTrigger = { kind: 'schedule', schedule: { ...trigger.schedule, scheduleExpr: '0 7 * * *' } } as const;
        seed(original);
        const deferred = createDeferred<void>();
        beforeWrite = () => deferred.promise;
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'saved-a', projectTarget } });
        await act(async () => {
            let draft = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'update', triggerId: original.triggers[0]!.id, trigger: capturedTrigger, enabled: false });
            draft = editWorkflowTriggerDraft(draft, { kind: 'setContext', context: { project: { machineId: 'm2', directory: '/captured' }, inputs: { name: 'captured' } } });
            hook.getCurrent().setDraft(draft);
        });
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        const changedTrigger = { kind: 'schedule', schedule: { ...trigger.schedule, scheduleExpr: '0 8 * * *' } } as const;
        const changedContext = { project: { machineId: 'm3', directory: '/later' }, inputs: { name: 'later' } };
        await act(async () => {
            let draft = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'update', triggerId: original.triggers[0]!.id, trigger: changedTrigger, enabled: true });
            draft = editWorkflowTriggerDraft(draft, { kind: 'setContext', context: changedContext });
            hook.getCurrent().setDraft(draft);
        });
        await act(async () => { deferred.resolve(); await saving; });
        expect(hook.getCurrent().draft.updates).toEqual({ t1: { trigger: changedTrigger, enabled: true } });
        expect(hook.getCurrent().draft.context).toEqual(changedContext);
    });

    it('stops the captured batch after navigation even when the caller fence stays true', async () => {
        const deferred = createDeferred<void>();
        beforeWrite = () => deferred.promise;
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'saved-a', projectTarget } });
        await act(async () => {
            let draft = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'first', trigger });
            draft = editWorkflowTriggerDraft(draft, { kind: 'add', clientId: 'second', trigger });
            hook.getCurrent().setDraft(draft);
        });
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        await waitForHomeGovernance(() => expect(writes).toHaveLength(1));
        await hook.rerender({ definitionId, sourceKey: 'saved-b', projectTarget });
        let outcome: string | undefined;
        await act(async () => { deferred.resolve(); outcome = await saving; });
        expect(outcome).toBe('stale');
        expect(writes).toHaveLength(1);
        expect(hook.getCurrent().dirty).toBe(false);
    });

    it('keeps the unsaved source draft when its first definition is saved', async () => {
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId: null as string | null, sourceKey: 'new-a', projectTarget } });
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'first', trigger })));
        await hook.rerender({ definitionId, sourceKey: 'new-a', projectTarget });
        expect(hook.getCurrent().draft.adds.map((add) => add.clientId)).toEqual(['first']);
    });

    it('reports cold Account reads as failed and recovers through its original query', async () => {
        // This failure is settled; reconnecting Homes retain their loading state.
        storage.setState({ endpointStatus: 'offline' });
        listReply = async () => { listReply = undefined; throw new Error('offline'); };
        const query = { scope: 'account_inline' } as const;
        const hook = await renderHook(() => useWorkflowTriggerSets(query));
        expect(hook.getCurrent().status).toBe('failed');
        expect(hook.getCurrent().sets).toEqual([]);
        await act(async () => hook.getCurrent().retry());
        expect(hook.getCurrent().status).toBe('ready');
        expect(listRequests().map(request => new URL(request.path, 'https://home.test').searchParams.get('scope'))).toEqual(['account_inline', 'account_inline']);
    });

    /** A refresh shows the last-known answer: a workflow with no triggers keeps reading Manual, not Loading. */
    it('stays ready while a settled read refreshes', async () => {
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'refresh', projectTarget } });
        expect(hook.getCurrent().status).toBe('ready');
        const manual = hook.getCurrent().summary;
        const refresh = createDeferred<void>();
        listReply = async () => { await refresh.promise; return listRows(); };
        await act(async () => hook.getCurrent().retry());
        expect(hook.getCurrent().status).toBe('ready');
        expect(hook.getCurrent().summary).toBe(manual);
        await act(async () => { refresh.resolve(); await refresh.promise; });
        expect(hook.getCurrent().status).toBe('ready');
    });

    it('reports failed reads, keeps known rows and retries the same owner', async () => {
        storage.setState({ endpointStatus: 'offline' });
        seed(set);
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'saved-a', projectTarget } });
        expect(hook.getCurrent().set?.automationId).toBe('set-1');
        listReply = async () => { throw new Error('offline'); };
        await act(async () => hook.getCurrent().retry());
        expect(hook.getCurrent().status).toBe('failed');
        expect(hook.getCurrent().set?.automationId).toBe('set-1');
        listReply = undefined;
        await act(async () => hook.getCurrent().retry());
        expect(hook.getCurrent().status).toBe('ready');
    });
});
