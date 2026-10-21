import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowTriggerSetV1Schema, AutomationDefinitionCreateRequestSchema, AutomationDefinitionDetailSchema,
    AutomationDefinitionListResponseSchema, AutomationDefinitionReconcileRequestSchema, AutomationStoredWorkflowDefinitionRecipeV2Schema,
    AutomationStoredWorkflowDefinitionV2Schema,
    ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, WorkflowDefinitionArtifactHeaderV1Schema,
    WorkflowDefinitionArtifactBodyV1Schema, AutomationTriggerIdSchema, AutomationTriggerDetailSchema, type AutomationDefinitionDetail,
    type AutomationTriggerDefinitionInput, type WorkflowTriggerSetV1 } from '@happier-dev/protocol';
import { createDeferred, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { WORKFLOW_STARTER_EXAMPLES_V1, materializeWorkflowStarterExample } from '@happier-dev/protocol/workflows/builtins/examples';

// Native confirmation is the user-input boundary; these Save/history cases accept it.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
// Locale presentation is outside these read/Action contracts; use the shared translation boundary.
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Native portal and vendor Markdown are platform boundaries; the editor and Actions stay real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal, { maxHeight: 640, maxWidth: 280, placement: 'bottom' }));
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

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
const { SessionTriggersSection } = await import('./SessionTriggersSection');

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
    const base = { ...value, id: AutomationTriggerIdSchema.parse(id), revision, createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null };
    if (value.kind === 'schedule') return AutomationTriggerDetailSchema.parse({ ...base, nextRunAt: null });
    if (value.kind === 'sessionLifecycle') return AutomationTriggerDetailSchema.parse({ ...base,
        remainingOccurrences: value.policy.kind === 'everyMatch' ? null : value.policy.kind === 'nextMatches' ? value.policy.count : 1,
        status: { state: 'waiting', runId: null } });
    throw new Error('Creation fixture supports schedules and Session lifecycle only');
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
                const updated = value.trigger ? persistedTrigger(trigger.id,
                    { ...value.trigger, enabled: value.enabled ?? trigger.enabled }, trigger.revision + 1) : trigger;
                return { ...updated, ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
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
    it('keeps an addressed saved workflow trigger acknowledgement visible without a socket wake', async () => {
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected the real Account lifetime');
        const hook = await renderHook(() => useWorkflowTriggerEditing({ definitionId, sourceKey: 'saved', projectTarget,
            accountLifetime: lifetime }));
        expect(hook.getCurrent().captureSnapshot().rows).toEqual([]);
        await act(async () => { hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft,
            { kind: 'add', clientId: 'new-trigger', trigger })); });
        await act(async () => { expect(await hook.getCurrent().save(definitionId, () => true)).toBe('saved'); });
        const acknowledged = hook.getCurrent().captureSnapshot();
        expect(acknowledged.rows).toMatchObject([{ identity: { clientId: 'new-trigger', triggerId: expect.any(String) }, trigger }]);
        expect(hook.getCurrent().dirty).toBe(false);
        await act(async () => { hook.getCurrent().restoreSnapshot({ ...acknowledged, rows: [] }); });
        expect(hook.getCurrent().captureSnapshot().rows).toEqual([]);
        await act(async () => { hook.getCurrent().restoreSnapshot(acknowledged); });
        expect(hook.getCurrent().captureSnapshot()).toEqual(acknowledged);
        expect(hook.getCurrent().dirty).toBe(false);
        expect(writes).toHaveLength(1);
        await act(async () => { await home.switchAccount(serverId, 'account-b'); });
        expect(lifetime.isCurrent()).toBe(false);
        expect(hook.getCurrent().captureSnapshot().rows).toEqual([]);
        await act(async () => { expect(await hook.getCurrent().save(definitionId, () => true)).toBe('stale'); });
        expect(writes).toHaveLength(1);
    });
    it.each([
        { unfocusedBeforeSave: false, delayedRead: false },
        { unfocusedBeforeSave: true, delayedRead: false },
        { unfocusedBeforeSave: true, delayedRead: true },
        { unfocusedBeforeSave: false, delayedRead: true },
    ])('retains an acknowledged trigger across an addressed Home focus change (unfocused: $unfocusedBeforeSave, delayed read: $delayedRead)', async ({ unfocusedBeforeSave, delayedRead }) => {
        const otherServerId = await home.addHome({ name: 'Other triggers', serverUrl: 'https://acknowledged-trigger-other-home.test',
            accountId: 'account-b', active: false });
        const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const hook = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(serverId);
            return { binding, ...useWorkflowTriggerEditing({ definitionId, sourceKey: 'saved', projectTarget,
                accountLifetime: binding ?? null }) };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        const binding = hook.getCurrent().binding;
        const focusOtherHome = async () => {
            await act(async () => {
                await setActiveServerId(otherServerId, { scope: 'tab' });
                publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
                storage.setState({ profileScope: { serverId: otherServerId, accountId: 'account-b' },
                    settingsScope: { serverId: otherServerId, accountId: 'account-b' } });
                resetTriggerSets();
                storage.getState().upsertWorkflowTriggerSet({ set: { ...set, automationId: 'other-account-set' },
                    queryKey: `workflow:${definitionId}` });
            });
        };
        if (unfocusedBeforeSave) await focusOtherHome();
        const pendingRead = createDeferred<void>();
        if (delayedRead) {
            let holdNextList = true;
            listReply = async () => {
                const page = listRows();
                if (holdNextList) { holdNextList = false; await pendingRead.promise; }
                return page;
            };
            await act(async () => hook.getCurrent().retry());
            await waitForHomeGovernance(() => expect(holdNextList).toBe(false));
        }
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft,
            { kind: 'add', clientId: 'new-trigger', trigger })));
        await act(async () => { expect(await hook.getCurrent().save(definitionId, () => true)).toBe('saved'); });
        const acknowledged = hook.getCurrent().captureSnapshot();
        expect(acknowledged.rows).toMatchObject([{ trigger }]);
        if (delayedRead) {
            await act(async () => { pendingRead.resolve(); await pendingRead.promise; });
            expect(hook.getCurrent().captureSnapshot()).toEqual(acknowledged);
        }
        if (!unfocusedBeforeSave) await focusOtherHome();
        expect(hook.getCurrent().binding).toBe(binding);
        expect(binding?.isCurrent()).toBe(true);
        expect(hook.getCurrent().captureSnapshot()).toEqual(acknowledged);
        expect(hook.getCurrent().dirty).toBe(false);
        if (unfocusedBeforeSave && delayedRead) {
            const saved = rows[0]!;
            const releaseOldList = createDeferred<void>();
            let oldListRequested = false;
            listReply = async () => {
                const page = listRows();
                oldListRequested = true;
                await releaseOldList.promise;
                return page;
            };
            await act(async () => hook.getCurrent().retry());
            await waitForHomeGovernance(() => expect(oldListRequested).toBe(true));
            listReply = undefined;
            await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft,
                { kind: 'remove', triggerId: saved.triggers[0]!.id })));
            await act(async () => { expect(await hook.getCurrent().save(definitionId, () => true)).toBe('saved'); });
            expect(hook.getCurrent().captureSnapshot().rows).toEqual([]);
            expect(hook.getCurrent().dirty).toBe(false);
            await act(async () => { releaseOldList.resolve(); await releaseOldList.promise; });
            expect(hook.getCurrent().captureSnapshot().rows).toEqual([]);
        }
        const staleSave = hook.getCurrent().save;
        await act(async () => {
            // The replacement Account owns a different Automation collection.
            rows = [];
            await home.switchAccount(serverId, 'replacement-account');
        });
        expect(binding?.isCurrent()).toBe(false);
        expect(hook.getCurrent().captureSnapshot().rows).toEqual([]);
        await act(async () => { expect(await staleSave(definitionId, () => true)).toBe('stale'); });
        expect(writes).toHaveLength(unfocusedBeforeSave && delayedRead ? 2 : 1);
    });
    it('keeps reads started during Save from replacing its receipt across default and addressed lifetimes', async () => {
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { listWorkflowTriggerSets } = await import('@/sync/domains/workflows/workflowTriggerActions');
        const hook = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(serverId);
            return { binding, ...useWorkflowTriggerEditing({ definitionId, sourceKey: 'saved', projectTarget,
                accountLifetime: binding ?? null }) };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        const binding = hook.getCurrent().binding;
        if (!binding) throw new Error('Expected the real addressed Account binding');
        const releaseWrite = createDeferred<void>();
        beforeWrite = () => releaseWrite.promise;
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft,
            { kind: 'add', clientId: 'new-trigger', trigger })));
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        await waitForHomeGovernance(() => expect(writes).toHaveLength(1));
        const releaseReads = createDeferred<void>();
        let readsStarted = 0;
        listReply = async () => {
            const page = listRows();
            readsStarted += 1;
            await releaseReads.promise;
            return page;
        };
        const ordinary = listWorkflowTriggerSets({ workflow: definitionId });
        const addressed = listWorkflowTriggerSets({ workflow: definitionId }, { accountLifetime: binding });
        await waitForHomeGovernance(() => expect(readsStarted).toBe(2));
        await act(async () => { releaseWrite.resolve(); expect(await saving).toBe('saved'); });
        const acknowledged = hook.getCurrent().captureSnapshot();
        expect(acknowledged.rows).toMatchObject([{ trigger }]);
        await act(async () => {
            releaseReads.resolve();
            expect(await ordinary).toEqual([]);
            expect(await addressed).toEqual([]);
        });
        expect(hook.getCurrent().captureSnapshot()).toEqual(acknowledged);
        // A new read after acknowledgement still has authority to observe deletion.
        rows = [];
        listReply = undefined;
        await act(async () => { expect(await listWorkflowTriggerSets({ workflow: definitionId })).toEqual([]); });
        expect(hook.getCurrent().captureSnapshot().rows).toEqual([]);
    });
    it('keeps an unfocused addressed Home independent of the focused Account trigger projection', async () => {
        seed(set);
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const hook = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(serverId);
            return { binding, ...useWorkflowTriggerSets({ workflow: definitionId }, binding ?? null) };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sets).toMatchObject([{ automationId: set.automationId }]));
        await act(async () => {
            const otherServerId = await home.addHome({ name: 'Other triggers', serverUrl: 'https://other-trigger-home.test', accountId: 'account-b' });
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
            storage.setState({ profileScope: { serverId: otherServerId, accountId: 'account-b' },
                settingsScope: { serverId: otherServerId, accountId: 'account-b' } });
            resetTriggerSets();
            storage.getState().upsertWorkflowTriggerSet({ set: { ...set, automationId: 'other-account-set' },
                queryKey: `workflow:${definitionId}` });
        });
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().binding?.isCurrent()).toBe(true);
            expect(hook.getCurrent().sets.map(value => value.automationId)).toEqual([set.automationId]);
        });
    });
    it.each([null, 'session-b'])('edits a bound Habit schedule through its real form and Action without changing scope or admission (scope %s)', async (scopeSessionId) => {
        const example = WORKFLOW_STARTER_EXAMPLES_V1.find(value => value.key === 'daily-summary-in-session')!;
        const selection = materializeWorkflowStarterExample(example, { session: { sessionId: 'session-a', machineId: 'm1' } });
        if (selection.status !== 'ready') throw new Error('Session-bound example required');
        seed(set);
        if (scopeSessionId) storage.setState(state => ({ sessions: { ...state.sessions,
            [scopeSessionId]: createSessionFixture({ id: scopeSessionId, serverId, metadata: {
                machineId: 'm1', path: '/repo', host: 'test' } }) } }));
        rows = rows.map(row => AutomationDefinitionDetailSchema.parse({ ...row, workflowDefinitionId: null, scopeSessionId,
            executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null, workflow: { t: 'plain', v: {
                workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition: selection.example.definition,
            } } } }));
        home.answer(serverId, '/v1/plugins/data/query', { status: 503, body: { error: 'unavailable' } });
        const { useSessionTriggers } = await import('./useSessionTriggers');
        const hook = await renderHook(() => useSessionTriggers('session-a'));
        expect(hook.getCurrent().status).toBe('ready');
        expect(hook.getCurrent().sets.map(value => value.automationId)).toEqual([set.automationId]);
        expect(hook.getCurrent().sets[0]?.scopeSessionId).toBe(scopeSessionId);
        expect(hook.getCurrent().sets[0]?.destinations?.targetSessionIds).toEqual(['session-a']);
        expect(hook.getCurrent().pullRequestLinks).toMatchObject({ status: 'unavailable' });
        const originalTarget = hook.getCurrent().sets[0]!.target;
        const screen = await renderScreen(<SessionTriggersSection sessionId="session-a" serverId={serverId} />);
        expect(screen.findByTestId('session-work-trigger:set-1:t1-switch')?.props.disabled).not.toBe(true);
        await screen.pressByTestIdAsync('session-work-trigger:set-1:t1');
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-work-trigger-popover-submit')).not.toBeNull());
        expect.soft(screen.findByTestId('session-work-trigger-popover-runs-in') !== null).toBe(scopeSessionId === null);
        const clock = screen.findAll(node => typeof node.props.onCommit === 'function' && node.props.testID === 'session-work-trigger-popover-at')[0];
        expect(clock).toBeDefined();
        await act(async () => { clock!.props.onCommit('10:30'); });
        expect(screen.findByTestId('session-work-trigger-popover-submit')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('session-work-trigger-popover-submit');
        await waitForHomeGovernance(() => expect(rows[0]?.triggers[0]).toMatchObject({ schedule: { scheduleExpr: '30 10 * * *' } }));
        expect(rows[0]?.scopeSessionId).toBe(scopeSessionId);
        expect.soft(hook.getCurrent().sets[0]?.target).toEqual(originalTarget);
        const recipe = rows[0]!.executionRecipe;
        if (recipe?.v !== 2 || recipe.workflow.t !== 'plain') throw new Error('Expected saved plain recipe');
        const savedWorkflow = AutomationStoredWorkflowDefinitionV2Schema.parse(recipe.workflow.v);
        if (!savedWorkflow.inlineDefinition) throw new Error('Expected saved inline definition');
        const { materializeWorkflowAcceptedSnapshotV1 } = await import('@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1');
        const admission = await materializeWorkflowAcceptedSnapshotV1({ definition: savedWorkflow.inlineDefinition,
            context: { source: { kind: 'inline' }, inputs: {}, machineId: 'm1', executionTarget: { kind: 'session' },
                workspaceTarget: { project: { machineId: 'm1', directory: '/repo', checkoutRootPath: '/repo' } },
                origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
            admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
        expect(admission).toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ selection: {
            conversation: { kind: 'existing_session', sessionId: 'session-a', machineId: 'm1' },
        } }] } });
        if (scopeSessionId === null) {
            await screen.pressByTestIdAsync('session-work-trigger:set-1:t1');
            const whenPicker = screen.findAll(node => node.props.testID === 'session-work-trigger-popover-when'
                && typeof node.props.onSelect === 'function')[0];
            expect(whenPicker).toBeDefined();
            await act(async () => { whenPicker!.props.onSelect('turnEnds'); });
            expect(screen.findByTestId('session-work-trigger-popover-submit')?.props.disabled).toBe(false);
            await screen.pressByTestIdAsync('session-work-trigger-popover-submit');
            await waitForHomeGovernance(() => expect(rows[0]?.triggers[0]).toMatchObject({
                kind: 'sessionLifecycle', sourceSessionId: 'session-a',
            }));
            expect(rows[0]?.scopeSessionId).toBeNull();
            expect(hook.getCurrent().sets[0]?.target).toEqual(originalTarget);
        }
        await act(async () => { await hook.getCurrent().update({ triggerId: AutomationTriggerIdSchema.parse('t1'),
            expectedRevision: rows[0]!.templateVersion, patch: { enabled: false } }); });
        expect(hook.getCurrent().sets[0]?.triggers[0]?.enabled).toBe(false);
        expect(rows[0]?.scopeSessionId).toBe(scopeSessionId);
        await act(async () => { await hook.getCurrent().remove('t1'); });
        expect(hook.getCurrent().sets).toEqual([]);
        expect(rows[0]?.triggers).toEqual([]);
    });
    it('keeps ordinary Habits usable without a section-level band when the real pull-request read is unavailable', async () => {
        seed(set);
        home.answer(serverId, '/v1/plugins/data/query', { status: 503, body: { error: 'unavailable' } });
        const { useSessionTriggers } = await import('./useSessionTriggers');
        const hook = await renderHook(() => useSessionTriggers('session-a'));
        expect(hook.getCurrent().pullRequestLinks).toMatchObject({ status: 'unavailable' });
        // This saved Workflow is an Account set; bind it here through its actual scope.
        rows = rows.map(row => AutomationDefinitionDetailSchema.parse({ ...row, scopeSessionId: 'session-a' }));
        await act(async () => hook.getCurrent().retry());
        const screen = await renderScreen(<SessionTriggersSection sessionId="session-a" serverId={serverId} />);
        expect(screen.findHostByTestId('session-work-trigger-links-unavailable')).toBeNull();
        expect(screen.findByTestId('session-work-trigger:set-1:t1-switch')?.props.disabled).not.toBe(true);
        await screen.pressByTestIdAsync('session-work-trigger:set-1:t1');
        expect(screen.findByTestId('session-work-trigger-popover-submit')?.props.disabled).toBe(false);
    });
    it('keeps a Session trigger receipt when its pre-Save reads finish after the replacement read', async () => {
        const { useSessionTriggers } = await import('./useSessionTriggers');
        const hook = await renderHook(() => useSessionTriggers('session-a'));
        expect(hook.getCurrent().status).toBe('ready');
        const releaseReads = createDeferred<void>();
        let pendingReads = 0;
        listReply = async () => {
            const page = listRows();
            if (pendingReads < 2) { pendingReads += 1; await releaseReads.promise; }
            return page;
        };
        await act(async () => hook.getCurrent().retry());
        await waitForHomeGovernance(() => expect(pendingReads).toBe(2));
        await act(async () => { await hook.getCurrent().add({ target: { kind: 'inline',
            definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait',
                document: { text: 'Continue', references: [], attachments: [] } }] }) },
            executionTarget: { kind: 'session' }, trigger }); });
        expect(hook.getCurrent().sets).toMatchObject([{ scopeSessionId: 'session-a', triggers: [{ kind: 'schedule' }] }]);
        const acknowledged = hook.getCurrent().sets;
        await act(async () => { releaseReads.resolve(); await releaseReads.promise; });
        expect(hook.getCurrent().sets).toBe(acknowledged);
        expect(hook.getCurrent().status).toBe('ready');
    });
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

    it('reports a settled Account read failure while its Home reconnects and recovers through the original query', async () => {
        storage.setState({ endpointStatus: 'connecting', socketStatus: 'connecting' });
        listReply = async () => { listReply = undefined; throw new Error('offline'); };
        const query = { scope: 'account_inline' } as const;
        const hook = await renderHook(() => useWorkflowTriggerSets(query));
        expect(hook.getCurrent().status).toBe('failed');
        expect(hook.getCurrent().sets).toEqual([]);
        await act(async () => hook.getCurrent().retry());
        expect(hook.getCurrent().status).toBe('ready');
        expect(listRequests().map(request => new URL(request.path, 'https://home.test').searchParams.get('scope'))).toEqual(['account_inline', 'account_inline']);
    });

    it('shows a failed Account census in Session Habits while the Session query is pending, then retries into its targeted Account row', async () => {
        const example = WORKFLOW_STARTER_EXAMPLES_V1.find(value => value.key === 'daily-summary-in-session')!;
        const selection = materializeWorkflowStarterExample(example, { session: { sessionId: 'session-a', machineId: 'm1' } });
        if (selection.status !== 'ready') throw new Error('Session-bound example required');
        seed(set);
        rows = rows.map(row => AutomationDefinitionDetailSchema.parse({ ...row, workflowDefinitionId: null,
            executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null, workflow: { t: 'plain', v: {
                workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition: selection.example.definition,
            } } } }));
        const sessionRead = createDeferred<void>();
        let failAccountRead = true;
        home.answer(serverId, 'GET /v3/automations', { select: async (_input, request) => {
            if (new URL(request.url).searchParams.has('scopeSessionId')) {
                await sessionRead.promise;
                return { body: AutomationDefinitionListResponseSchema.parse({ automations: [], nextCursor: null }) };
            }
            return failAccountRead ? { status: 503, body: { error: 'storage_unavailable' } } : { body: listRows() };
        } });
        storage.setState({ endpointStatus: 'connecting', socketStatus: 'connecting' });
        const screen = await renderScreen(<SessionTriggersSection sessionId="session-a" serverId={serverId} />);
        try {
            await flushHookEffects();
            expect(screen.findByTestId('session-work-triggers-failed')).not.toBeNull();
            expect(screen.findByTestId('session-work-triggers-loading')).toBeNull();
            expect(screen.findByTestId('session-work-triggers-empty')).toBeNull();
            failAccountRead = false;
            const retry = screen.findAll(node => node.props.testID === 'session-work-triggers-failed'
                && typeof node.props.action?.onPress === 'function')[0];
            expect(retry).toBeDefined();
            await act(async () => { retry!.props.action.onPress(); sessionRead.resolve(); });
            await waitForHomeGovernance(() => expect(screen.findByTestId('session-work-trigger:set-1:t1')).not.toBeNull());
            expect(screen.findByTestId('session-work-triggers-failed')).toBeNull();
            expect(storage.getState().workflowTriggerSetIdsByQuery).toMatchObject({ account_all: ['set-1'], 'session:session-a': [] });
        } finally { await act(async () => sessionRead.resolve()); }
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
