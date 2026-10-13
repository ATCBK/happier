import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    WorkflowRunRecipientCensusResponseV1Schema,
    materializeWorkflowAcceptedSnapshotV1,
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1,
} from '@happier-dev/protocol';

import { createDeferred, createRootLayoutFeaturesResponse, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { getActiveServerSnapshot, setActiveServer } = await import('@/sync/domains/server/serverRuntime');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { useSessionManagedWorkflowRuns } = await import('./useSessionManagedWorkflowRuns');

const accountId = 'managed-home-account';
const run = createWorkflowRunSummaryFixture({
    id: 'same-run', ownerAccountId: accountId,
    origin: { kind: 'direct', originSessionId: 'session-1' },
});
const route = '/v3/automations/runs/workflow-storage';
let listResponse: unknown;
let homeA: string;
let homeB: string;
let previous = getStorage().getState();
let previousSnapshot = getActiveServerSnapshot();

async function activateHome(serverId: string): Promise<void> {
    publishAppliedActiveServerRuntimeAvailability(false);
    await setActiveServer({ serverId });
    getStorage().getState().activateProfileScope({ serverId, accountId });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
}

beforeEach(async () => {
    previous = getStorage().getState();
    previousSnapshot = getActiveServerSnapshot();
    await home.reset();
    resetServerFeaturesClientForTests();
    getStorage().getState().clearProfileScope();
    getStorage().setState({
        workflowRunsById: {}, workflowRunListWindows: {}, workflowRunInvocationsByRunId: {},
        settings: { ...getStorage().getState().settings, experiments: true, featureToggles: { automations: true } },
    });
    homeA = await home.addHome({ name: 'Managed Home A', serverUrl: 'https://managed-home-a.test', accountId });
    homeB = await home.addHome({ name: 'Managed Home B', serverUrl: 'https://managed-home-b.test', accountId, active: false });
    if (run.origin.kind !== 'direct') throw new Error('Managed Home fixture requires direct Run provenance');
    const materialized = await materializeWorkflowAcceptedSnapshotV1({
        definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait',
            document: { text: 'Continue', references: [], attachments: [] } }] }),
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: run.machineId,
            executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: run.origin, authorization: { principal: { kind: 'host' } } },
    });
    if (!materialized.ok) throw new Error(`fixture_materialization_failed:${materialized.error.code}`);
    const accepted = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: run.id }, acceptedSnapshot: materialized.snapshot }));
    const census = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: accountId,
        access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
        ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    listResponse = { runs: [run], acceptedEnvelopesByRunId: { [run.id]: accepted }, keyCensusByRunId: { [run.id]: census } };
    for (const serverId of [homeA, homeB]) {
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
        home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        home.answer(serverId, route, { body: listResponse });
    }
    await activateHome(homeA);
});

afterEach(async () => {
    await standardCleanup();
    await home.reset();
    getStorage().setState(previous, true);
    publishAppliedActiveServerSnapshot(previousSnapshot);
    resetServerFeaturesClientForTests();
});

describe('Session-managed Workflow exact Home reads through the real Account owner', () => {
    it.each(['other Home', 'missing Home'] as const)('fails closed for %s without reading or publishing active Home Runs', async (target) => {
        expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual({ serverId: homeA, accountId });
        const hook = await renderHook(() => useSessionManagedWorkflowRuns({
            sessionId: 'session-1', serverId: target === 'other Home' ? homeB : null,
        }));

        expect(hook.getCurrent().phase).toBe('failed');
        expect(hook.getCurrent().refreshFailed).toBe(true);
        expect(hook.getCurrent().runs).toEqual([]);
        expect(getStorage().getState().workflowRunsById).toEqual({});
        expect(home.requestsFor(route)).toEqual([]);
    });

    it('retires a loaded Home-qualified window when the real active Home changes', async () => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        const hook = await renderHook(() => useSessionManagedWorkflowRuns({ sessionId: 'session-1', serverId: homeA }));
        expect(hook.getCurrent().phase).toBe('loaded');
        expect(hook.getCurrent().runs.map((entry) => entry.id)).toEqual([run.id]);
        expect(getStorage().getState().workflowRunsById[run.id]?.summary).toEqual({
            ...run,
            startedBy: 'user',
            where: { machineId: run.machineId, directory: '/repo' },
            stepProgress: undefined,
            stepProgressCurrentness: undefined,
            heldStep: null,
        });
        expect(home.requestsFor(route)).toHaveLength(2);
        expect(home.requestsFor(route).every(request => request.serverId === homeA && request.input
            && typeof request.input === 'object' && 'operation' in request.input && request.input.operation === 'list')).toBe(true);
        home.requests.length = 0;

        await act(async () => { publishAppliedActiveServerRuntimeAvailability(false); });
        expect(hook.getCurrent().phase).toBe('failed');
        expect(hook.getCurrent().runs).toEqual([]);
        expect(home.requestsFor(route)).toEqual([]);
        await act(async () => { publishAppliedActiveServerRuntimeAvailability(true); });
        await flushHookEffects();
        expect(hook.getCurrent().phase).toBe('loaded');
        expect(hook.getCurrent().runs.map((entry) => entry.id)).toEqual([run.id]);
        expect(home.requestsFor(route)).toHaveLength(2);
        home.requests.length = 0;

        await act(async () => { await activateHome(homeB); });
        await flushHookEffects();

        expect(lifetime?.isCurrent()).toBe(false);
        expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual({ serverId: homeB, accountId });
        expect(hook.getCurrent().phase).toBe('failed');
        expect(hook.getCurrent().runs).toEqual([]);
        expect(home.requestsFor(route)).toEqual([]);
    });

    it('does not seed the active Run store with a response delivered after its Home lifetime retires', async () => {
        const response = createDeferred<void>();
        home.answer(homeA, route, { body: listResponse, respondAfter: response.promise });
        const lifetime = captureActiveServerAccountScopeLifetime();
        const hook = await renderHook(() => useSessionManagedWorkflowRuns({ sessionId: 'session-1', serverId: homeA }));
        expect(hook.getCurrent().phase).toBe('loading');
        expect(home.requestsFor(route)).toHaveLength(2);

        await act(async () => { await activateHome(homeB); });
        await act(async () => { response.resolve(); });
        await flushHookEffects();

        expect(lifetime?.isCurrent()).toBe(false);
        expect(hook.getCurrent().phase).toBe('failed');
        expect(hook.getCurrent().runs).toEqual([]);
        expect(getStorage().getState().workflowRunsById).toEqual({});
    });
});
