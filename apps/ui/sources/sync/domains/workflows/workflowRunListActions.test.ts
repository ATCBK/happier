import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { buildWorkflowRunListFilter, listWorkflowRuns } = await import('./workflowRunListActions');
const { WorkflowActionError } = await import('./workflowActionError');
const route = '/v3/automations/runs/workflow-storage';
const accountId = 'run-list-owner';
const run = createWorkflowRunSummaryFixture({ id: 'run-1', ownerAccountId: accountId });
let serverId: string;
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();

beforeEach(async () => {
    previous = storage.getState();
    applied = getAppliedActiveServerSnapshot();
    available = isAppliedActiveServerRuntimeAvailable();
    await home.reset();
    serverId = await home.addHome({ name: 'Run Home', serverUrl: 'https://workflow-run-list.test', accountId });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId, accountId } });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    home.answer(serverId, route, { body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } });
});
afterEach(async () => { await home.reset(); storage.setState(previous); publishAppliedActiveServerSnapshot(applied, available); });

async function runPage(metadata?: { title: string }) {
    const materialized = await materializeWorkflowAcceptedSnapshotV1({
        definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Continue', references: [], attachments: [] } }] }),
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
        context: { source: { kind: 'automation', automationId: 'automation-1' }, inputs: {}, machineId: run.machineId, executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
            actionCaller: { kind: 'automationRun', runId: run.id, automationId: 'automation-1', cause: { kind: 'manual', invokedAt: 1 } },
            authorization: { principal: { kind: 'host' } }, ...(metadata ? { metadata } : {}) },
    });
    if (!materialized.ok) throw new Error(`fixture_materialization_failed:${materialized.error.code}`);
    const envelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: run.id }, acceptedSnapshot: materialized.snapshot }));
    const census = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: accountId,
        access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
        ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    return { runs: [run], acceptedEnvelopesByRunId: { [run.id]: envelope }, keyCensusByRunId: { [run.id]: census } };
}

function requests() {
    return home.requestsFor(route).map(({ input }) => input && typeof input === 'object' && 'request' in input ? input.request : null);
}

describe('workflow Run list Action client through the Account storage transport', () => {
    it('uses Automation history and active Session destinations in the paged reader', async () => {
        await listWorkflowRuns({ filter: buildWorkflowRunListFilter('automation:habit') });
        await listWorkflowRuns({ filter: buildWorkflowRunListFilter('destination:session-one') });
        expect(requests()).toEqual([{ automationId: 'habit' }, { targetSessionId: 'session-one',
            states: ['queued', 'claimed', 'running', 'pause_requested', 'paused', 'interrupted'] }]);
    });

    it('reads a requested page and preserves the producer continuation', async () => {
        home.answer(serverId, route, { body: { ...await runPage(), nextCursor: 'cursor-2' } });
        const page = await listWorkflowRuns({ cursor: 'cursor-1', limit: 20 });
        expect(requests()).toEqual([{ cursor: 'cursor-1', limit: 20 }]);
        expect(page.runs[0]?.id).toBe(run.id);
        expect(page.nextCursor).toBe('cursor-2');
    });

    it('projects readable authored metadata and leaves unnamed opened content readable', async () => {
        home.answer(serverId, route, { body: await runPage({ title: 'Review 500 files' }) });
        expect((await listWorkflowRuns()).metadataByRunId).toEqual({ [run.id]: { kind: 'available', value: { title: 'Review 500 files' } } });
        home.answer(serverId, route, { body: await runPage() });
        expect((await listWorkflowRuns()).metadataByRunId).toEqual({ [run.id]: null });
    });

    it('keeps unopened accepted content unavailable with a typed reason', async () => {
        const page = await runPage();
        home.answer(serverId, route, { body: { ...page, acceptedEnvelopesByRunId: {} } });
        expect((await listWorkflowRuns()).metadataByRunId).toEqual({ [run.id]: { kind: 'unavailable', reason: 'content_unavailable' } });
    });

    it('rejects an incomplete storage response without its accepted-content map', async () => {
        home.answer(serverId, route, { body: { runs: [run] } });
        await expect(listWorkflowRuns()).rejects.toThrow();
    });

    it('asks the authoritative storage owner for attention rather than scanning a cached page', async () => {
        await listWorkflowRuns({ filter: buildWorkflowRunListFilter('attention') });
        expect(requests()).toEqual([{ attention: 'required' }]);
    });

    it('preserves the closed access-denied code as the canonical WorkflowActionError', async () => {
        home.answer(serverId, route, { status: 403, body: { error: 'run_access_denied' } });
        const failure = await listWorkflowRuns().then(() => null, (error: unknown) => error);
        expect(failure).toBeInstanceOf(WorkflowActionError);
        expect((failure as InstanceType<typeof WorkflowActionError>).code).toBe('run_access_denied');
        expect((failure as Error).message).toBe('run_access_denied');
    });

    it('keeps a front-door policy refusal outside the closed workflow error vocabulary', async () => {
        const actionsSettingsV1 = normalizeActionsSettingsV1({ v: 1, actions: { 'workflow.run.list': { enabled: false } } });
        home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1 } }, version: 1 } });
        const failure = await listWorkflowRuns().then(() => null, (error: unknown) => error);
        expect(failure).toBeInstanceOf(WorkflowActionError);
        expect((failure as InstanceType<typeof WorkflowActionError>).code).toBeNull();
        expect((failure as InstanceType<typeof WorkflowActionError>).rawCode).toBe('action_disabled');
        expect(home.requestsFor(route)).toEqual([]);
    });

    it('rejects malformed Run summaries before handing them to a screen', async () => {
        home.answer(serverId, route, { body: { runs: [{ id: run.id }], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } });
        await expect(listWorkflowRuns()).rejects.toThrow();
    });

    it('maps Active onto canonical nonterminal states only', () => {
        const active = buildWorkflowRunListFilter('active');
        expect(active.states).toBeDefined();
        expect(active.states).not.toContain('succeeded');
        expect(active.states).not.toContain('cancelled');
        expect(buildWorkflowRunListFilter('all')).toEqual({});
        expect(buildWorkflowRunListFilter('under:lead')).toEqual({ underSessionId: 'lead' });
    });
});
