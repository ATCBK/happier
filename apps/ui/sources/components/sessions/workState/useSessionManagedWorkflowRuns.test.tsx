import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    WorkflowRunListRequestV1Schema,
    WorkflowRunRecipientCensusResponseV1Schema,
    materializeWorkflowAcceptedSnapshotV1,
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1,
} from '@happier-dev/protocol';

import { createDeferred, createRootLayoutFeaturesResponse, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { WorkflowRunListPage } from '@/sync/domains/workflows/workflowRunListActions';
import type { SessionManagedWorkflowRunsState } from './useSessionManagedWorkflowRuns';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
const { useSessionManagedWorkflowRuns } = await import('./useSessionManagedWorkflowRuns');

const accountId = 'account-a';
const route = '/v3/automations/runs/workflow-storage';
// Supplies only the HTTP Home's answer; list parsing, Action admission, Account scope and store stay real.
const readPage = vi.fn<(params: { filter?: Record<string, unknown> }) => Promise<WorkflowRunListPage>>();
let serverId: string;
let previousState = storage.getState();
let previousSnapshot = getActiveServerSnapshot();

beforeEach(async () => {
    previousState = storage.getState();
    previousSnapshot = getActiveServerSnapshot();
    await home.reset();
    serverId = await home.addHome({ name: 'Managed runs Home', serverUrl: 'https://session-managed-runs.test', accountId });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    readPage.mockReset();
    storage.setState({ workflowRunsById: {}, workflowRunListWindows: {}, workflowRunInvocationsByRunId: {},
        settings: { ...storage.getState().settings, experiments: true, featureToggles: { automations: true } } });
    storage.getState().activateProfileScope({ serverId, accountId });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
    home.answer(serverId, route, { select: async (input) => {
        if (!input || typeof input !== 'object' || !('operation' in input) || input.operation !== 'list' || !('request' in input)) {
            throw new Error('Unexpected Workflow storage operation');
        }
        const request = WorkflowRunListRequestV1Schema.parse(input.request);
        const page = await readPage({ filter: request });
        const acceptedEnvelopesByRunId: Record<string, string> = {};
        const keyCensusByRunId: Record<string, ReturnType<typeof WorkflowRunRecipientCensusResponseV1Schema.parse>> = {};
        for (const run of page.runs) {
            if (run.origin.kind !== 'direct') throw new Error('Managed Session fixture requires direct Run provenance');
            const metadata = page.metadataByRunId[run.id];
            const materialized = await materializeWorkflowAcceptedSnapshotV1({
                definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait',
                    document: { text: 'Continue', references: [], attachments: [] } }] }),
                admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
                context: { source: { kind: 'inline' }, inputs: {}, machineId: run.machineId,
                    executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                    origin: run.origin, authorization: { principal: { kind: 'host' } },
                    ...(metadata?.kind === 'available' ? { metadata: metadata.value } : {}) },
            });
            if (!materialized.ok) throw new Error(`fixture_materialization_failed:${materialized.error.code}`);
            acceptedEnvelopesByRunId[run.id] = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'accepted_snapshot', accountId: run.ownerAccountId, runId: run.id }, acceptedSnapshot: materialized.snapshot }));
            keyCensusByRunId[run.id] = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: run.ownerAccountId,
                access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
                ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
        }
        return { body: { runs: page.runs, acceptedEnvelopesByRunId, keyCensusByRunId,
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) } };
    } });
    latest = null;
    probeRenders = 0;
});

afterEach(async () => {
    await standardCleanup();
    await home.reset();
    storage.setState(previousState, true);
    publishAppliedActiveServerSnapshot(previousSnapshot);
    resetServerFeaturesClientForTests();
});

let latest: SessionManagedWorkflowRunsState | null = null;
let probeRenders = 0;

async function renderHook(sessionId: string | null = 'session-1', targetServerId: string | null = serverId) {
    const { useSessionManagedWorkflowRuns } = await import('./useSessionManagedWorkflowRuns');
    function Probe(): null {
        probeRenders += 1;
        latest = useSessionManagedWorkflowRuns({ sessionId, serverId: targetServerId });
        return null;
    }
    const screen = await renderScreen(React.createElement(Probe));
    await flushHookEffects({ cycles: 40 });
    return screen;
}

describe('useSessionManagedWorkflowRuns', () => {
    it('reflects a control settled through the shared Run row owner without asking the server again', async () => {
        const running = createWorkflowRunSummaryFixture({
            ownerAccountId: accountId,
            id: 'run-1', state: 'running', revision: 1, origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        readPage.mockImplementation(async (params): Promise<WorkflowRunListPage> => (
            params.filter?.attention === 'required'
                ? { runs: [], metadataByRunId: {}, nextCursor: undefined }
                : { runs: [running], metadataByRunId: { 'run-1': { kind: 'available', value: { title: 'Nightly review' } } }, nextCursor: undefined }
        ));
        await renderHook();

        expect(latest?.phase).toBe('loaded');
        expect(latest?.runs.map((run) => [run.id, run.state])).toEqual([['run-1', 'running']]);
        expect(latest?.metadataByRunId?.['run-1']).toEqual({ kind: 'available', value: { title: 'Nightly review' } });
        expect(readPage).toHaveBeenCalledTimes(2);

        // The Run screen settles Pause into the one shared row owner.
        const { getStorage } = await import('@/sync/domains/state/storage');
        await act(async () => {
            getStorage().getState().upsertWorkflowRuns([
                workflowRunRowFromSummary({ ...running, state: 'paused', revision: 2 }),
            ]);
        });

        expect(latest?.runs.map((run) => [run.id, run.state])).toEqual([['run-1', 'paused']]);
        expect(latest?.metadataByRunId?.['run-1']).toEqual({ kind: 'available', value: { title: 'Nightly review' } });
        expect(readPage).toHaveBeenCalledTimes(2);
    });

    /**
     * A contextual Session surface is not a second place the feature can be
     * on. It answers the same canonical decision the dedicated Workflow routes
     * do and fails closed while that decision is unresolved, so a Home without
     * Workflows neither reads managed Runs nor links to them — while the
     * Session's ordinary one-shot Automations are untouched.
     */
    it.each([
        ['disabled', { status: 'ready', features: createRootLayoutFeaturesResponse({ features: { workflows: { enabled: false } } }) }],
        ['unknown', { status: 'unsupported', reason: 'invalid_payload' }],
        ['unresolved', { status: 'error', reason: 'network' }],
    ] as const)('reads no managed Run on a %s Workflows decision', async (_label, decision) => {
        primeServerFeaturesSnapshot({ serverId, snapshot: decision });
        readPage.mockResolvedValue({ runs: [], metadataByRunId: {}, nextCursor: undefined });

        await renderHook();

        expect(readPage).not.toHaveBeenCalled();
        expect(latest?.runs).toEqual([]);
    });

    /**
     * Every Run this Account has read shares one map. A Session section that
     * read the map rerendered for every other Run's exact refresh — including
     * the ones a Run screen settles controls on while this transcript is open.
     */
    it('keeps an unrelated Account Run refresh out of this mounted Session section', async () => {
        const running = createWorkflowRunSummaryFixture({
            ownerAccountId: accountId,
            id: 'run-1', state: 'running', revision: 1, origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        readPage.mockImplementation(async (params): Promise<WorkflowRunListPage> => (
            params.filter?.attention === 'required'
                ? { runs: [], metadataByRunId: {}, nextCursor: undefined }
                : {
                    runs: [running],
                    metadataByRunId: { 'run-1': { kind: 'available', value: { title: 'Nightly review' } } },
                    nextCursor: undefined,
                }
        ));
        await renderHook();
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-1']);
        const rendersAfterLoad = probeRenders;

        const { getStorage } = await import('@/sync/domains/state/storage');
        // Another Session's Run refreshing in the one Account-scoped row owner.
        await act(async () => {
            getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(
                createWorkflowRunSummaryFixture({ id: 'run-elsewhere', state: 'succeeded', revision: 3 }),
            )]);
        });

        expect(probeRenders).toBe(rendersAfterLoad);
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-1']);

        await act(async () => {
            getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(
                { ...running, state: 'paused', revision: 2 },
                { kind: 'available', value: { title: 'Nightly review (renamed)' } },
            )]);
        });

        expect(probeRenders).toBe(rendersAfterLoad + 1);
        expect(latest?.runs.map((run) => [run.id, run.state])).toEqual([['run-1', 'paused']]);
        expect(latest?.metadataByRunId?.['run-1'])
            .toEqual({ kind: 'available', value: { title: 'Nightly review (renamed)' } });
    });

    it('re-reads membership and attention on the Account-change wake the collection also observes', async () => {
        const running = createWorkflowRunSummaryFixture({
            ownerAccountId: accountId,
            id: 'run-1', state: 'running', revision: 1, origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        readPage.mockImplementation(async (params): Promise<WorkflowRunListPage> => (
            params.filter?.attention === 'required'
                ? { runs: [], metadataByRunId: {}, nextCursor: undefined }
                : { runs: [running], metadataByRunId: {}, nextCursor: undefined }
        ));
        await renderHook();
        expect(latest?.attentionRunIds.has('run-1')).toBe(false);
        expect(readPage).toHaveBeenCalledTimes(2);

        // A later approval on an off-page invocation: the server's attention
        // predicate is the only owner of that fact, and the wake is how the
        // client learns to ask again.
        readPage.mockImplementation(async (params): Promise<WorkflowRunListPage> => (
            params.filter?.attention === 'required'
                ? { runs: [running], metadataByRunId: {}, nextCursor: undefined }
                : { runs: [running], metadataByRunId: {}, nextCursor: undefined }
        ));
        await act(async () => {
            publishHomeAccountChange(serverId, ['workflow-run:run-1']);
        });
        await flushHookEffects({ cycles: 40 });

        expect(readPage).toHaveBeenCalledTimes(4);
        expect(latest?.phase).toBe('loaded');
        expect(latest?.attentionRunIds.has('run-1')).toBe(true);

        // Wakes about other Homes or unrelated entities do not refetch.
        await act(async () => {
            publishHomeAccountChange('server-b', ['workflow-run:run-1']);
            publishHomeAccountChange(serverId, ['session:other']);
        });
        await flushHookEffects({ cycles: 40 });
        expect(readPage).toHaveBeenCalledTimes(4);
    });

    /**
     * The attention page is the only owner of "this needs the person", and it
     * is a different keyset from the general page. Reading it for the Review
     * label while taking membership from the general page alone meant an
     * actionable Run that fell outside that page was fetched, acknowledged and
     * then dropped — the one case the server predicate exists for.
     */
    it('renders an actionable Run the general page did not contain', async () => {
        const onPage = createWorkflowRunSummaryFixture({
            ownerAccountId: accountId,
            id: 'run-on-page', state: 'running', revision: 1,
            origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        const offPage = createWorkflowRunSummaryFixture({
            ownerAccountId: accountId,
            id: 'run-off-page', state: 'interrupted', revision: 4,
            origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        readPage.mockImplementation(async (params): Promise<WorkflowRunListPage> => (
            params.filter?.attention === 'required'
                ? {
                    runs: [offPage],
                    metadataByRunId: { 'run-off-page': { kind: 'available', value: { title: 'Release check' } } },
                    nextCursor: undefined,
                }
                : {
                    runs: [onPage],
                    metadataByRunId: { 'run-on-page': { kind: 'available', value: { title: 'Nightly review' } } },
                    nextCursor: undefined,
                }
        ));

        await renderHook();

        // Deterministic order: the general page keeps its server order, then the
        // attention-only ids follow in theirs. Nothing is re-sorted locally.
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-on-page', 'run-off-page']);
        expect(latest?.attentionRunIds.has('run-off-page')).toBe(true);
        expect(latest?.metadataByRunId?.['run-off-page'])
            .toEqual({ kind: 'available', value: { title: 'Release check' } });

        // The attention body landed in the one Account-scoped row owner, so the
        // exact Run route resolves the same body without another read.
        expect(Object.keys(storage.getState().workflowRunsById).sort())
            .toEqual(['run-off-page', 'run-on-page']);
    });

    it('does not duplicate a Run that both pages returned', async () => {
        const shared = createWorkflowRunSummaryFixture({
            ownerAccountId: accountId,
            id: 'run-1', state: 'interrupted', revision: 2,
            origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        readPage.mockImplementation(async () => ({
            runs: [shared], metadataByRunId: {}, nextCursor: undefined,
        }));

        await renderHook();

        expect(latest?.runs.map((run) => run.id)).toEqual(['run-1']);
        expect(latest?.attentionRunIds.has('run-1')).toBe(true);
    });

    /**
     * A refresh that fails is not evidence the Session started nothing. The
     * window keeps the membership it already proved and reports the failure
     * separately, which is the package rule for hydrated content.
     */
    it('keeps last-known-good membership when a refresh fails and surfaces the failure separately', async () => {
        const running = createWorkflowRunSummaryFixture({
            ownerAccountId: accountId,
            id: 'run-1', state: 'running', revision: 1,
            origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        readPage.mockImplementation(async (params) => (
            params.filter?.attention === 'required'
                ? { runs: [], metadataByRunId: {}, nextCursor: undefined }
                : { runs: [running], metadataByRunId: {}, nextCursor: undefined }
        ));
        await renderHook();
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-1']);
        expect(latest?.refreshFailed).toBe(false);

        readPage.mockImplementation(async () => { throw new Error('offline'); });
        await act(async () => {
            publishHomeAccountChange(serverId, ['workflow-run:run-1']);
        });
        await flushHookEffects({ cycles: 40 });

        expect(latest?.phase).toBe('loaded');
        expect(latest?.refreshFailed).toBe(true);
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-1']);
    });

    it('reports a first read that failed as failed, because nothing is known yet', async () => {
        readPage.mockImplementation(async () => { throw new Error('offline'); });

        await renderHook();

        expect(latest?.phase).toBe('failed');
        expect(latest?.refreshFailed).toBe(true);
        expect(latest?.runs).toEqual([]);
    });

    it("retires rows and refetches when the Account changes rather than showing another Account's Runs", async () => {
        const accountARun = createWorkflowRunSummaryFixture({
            ownerAccountId: accountId,
            id: 'run-a', state: 'running', revision: 1, origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        readPage.mockImplementation(async () => ({ runs: [accountARun], metadataByRunId: {}, nextCursor: undefined }));
        await renderHook();
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-a']);

        const accountBRun = createWorkflowRunSummaryFixture({
            ownerAccountId: 'account-b',
            id: 'run-b', state: 'succeeded', revision: 1, origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        const accountB = createDeferred<WorkflowRunListPage>();
        readPage.mockImplementation(() => accountB.promise);
        await act(async () => {
            await home.switchAccount(serverId, 'account-b');
            storage.getState().activateProfileScope({ serverId, accountId: 'account-b' });
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        });
        // Nothing of Account A survives the switch, before B has answered.
        expect(latest?.runs).toEqual([]);
        accountB.resolve({ runs: [accountBRun], metadataByRunId: {}, nextCursor: undefined });
        await flushHookEffects({ cycles: 40 });
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-b']);
    });
});
