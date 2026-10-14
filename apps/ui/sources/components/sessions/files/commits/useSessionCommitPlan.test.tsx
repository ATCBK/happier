import * as React from 'react';
import '@/dev/testkit/harness/syncSingletonLoader';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScmDiffSummaryResultSchema, ScmDiffSummaryResultListResponseSchema, ScmDiffSummaryGenerateOutputSchema, type ScmDiffSummaryResult } from '@happier-dev/protocol/scm';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { SCM_DIFF_SUMMARY_SETTING_KEYS } from '@/settings/scmDiffSummary/settings';
import { AgentModelsProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';

const boundary = vi.hoisted(() => ({
    saved: null as ScmDiffSummaryResult | null,
    sessionId: '',
    read: null as (() => Promise<unknown>) | null,
    recover: null as (() => Promise<unknown>) | null,
    generate: null as (() => Promise<unknown>) | null,
    listSaved: true,
    requests: [] as Array<Readonly<{ method: string; machineId?: string; sessionId?: string; payload?: unknown }>>,
}));

// Credential custody, Home HTTP and remote RPC transports are genuine system boundaries;
// result operations, Account lifetime, storage and proposal projection stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
const OFFERED_MODELS = [{ id: 'commit-plan-fixture-model', name: 'Offered fixture model',
    capabilities: { structuredOutput: 'supported' as const } }];
const MODEL_OBSERVATION = AgentModelsProbeObservationSchema.parse({ availableModels: OFFERED_MODELS,
    supportsFreeform: false, source: 'dynamic' });
async function remote(method: string): Promise<unknown> {
    if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
        'tool.executionRuns': { ok: true, checkedAt: 1,
            data: { backends: { codex: { available: true, intents: ['scm_diff_summary'] } } } },
    } };
    if (method === RPC_METHODS.CAPABILITIES_INVOKE) return { ok: true, result: MODEL_OBSERVATION };
    if (method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return { runs: [] };
    if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) return ExecutionRunGetResponseSchema.parse({
        run: { runId: boundary.saved?.output.runId, callId: 'generator-call', sidechainId: 'generator-sidechain',
            intent: 'scm_diff_summary', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
            retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1 },
        latestToolResult: boundary.saved?.output,
    });
    if (method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST) {
        const saved = boundary.saved!;
        return ScmDiffSummaryResultListResponseSchema.parse({ success: true, results: boundary.listSaved ? [{ cwd: '/repo/exact',
            ...(boundary.sessionId ? { sessionId: boundary.sessionId } : {}),
            resultId: saved.resultId, revision: saved.revision, comparisonId: saved.output.comparison!.id,
            source: saved.output.comparison!.source, bytes: 100, updatedAtMs: 1 }] : [], count: boundary.listSaved ? 1 : 0, bytes: boundary.listSaved ? 100 : 0,
            sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 } });
    }
    if (method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ) return boundary.read ? boundary.read() : { success: true, result: boundary.saved };
    if (method === 'scm.diffSummary.commitPlan.recover') return boundary.recover!();
    if (method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE) return boundary.generate ? boundary.generate() : ScmDiffSummaryGenerateOutputSchema.parse({ success: false,
        errorCode: 'SUMMARY_FAILED', error: 'The generation boundary was reached.' });
    throw new Error(`Unexpected remote method: ${method}`);
}
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const rpc = async (request: { method: string; machineId?: string; payload?: unknown }) => { boundary.requests.push(request); return remote(request.method); };
    // Method-specific external wire fixtures cannot express the transport's arbitrary R.
    return createServerScopedMachineRpcBoundaryMock(rpc as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope);
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async (importOriginal) => {
    const { createServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const rpc = async <R,>(request: { method: string; sessionId?: string; payload?: unknown }): Promise<R> => { boundary.requests.push(request); return await remote(request.method) as R; };
    return createServerScopedSessionRpcModuleMock({ importOriginal, overrides: {
        sessionRpcWithServerScope: rpc, sessionRpcWithServerAccountScope: rpc,
    } });
});

const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { standardCleanup } = await import('@/dev/testkit/cleanup/standardCleanup');
const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
const { getStorage } = await import('@/sync/domains/state/storage');
const { buildDynamicModelProbeCacheKey } = await import('@/sync/domains/models/dynamicModelProbeCacheKey');
const { resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');
const { discoverMachineModels } = await import('@/sync/ops/modelDiscovery');
const { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } = await import('@happier-dev/protocol/acp/catalog/catalogRowsV1');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
const disposeActionLoader = await installRealActionExecutorModuleLoader();
afterAll(disposeActionLoader);
const { useSessionCommitPlan } = await import('./useSessionCommitPlan');
const { useScmCommitPlan } = await import('./useScmCommitPlan');
const { useWorkspaceScmDiffSummaryBinding } = await import('@/components/projects/scm/useWorkspaceScmDiffSummaryBinding');
const { ScmCommitsView } = await import('./ScmCommitsView');
const { RunWorkNotifications } = await import('@/components/sessions/work/RunWorkNotifications');
const { applySavedScmDiffSummaryResult } = await import('@/sync/ops/scmDiffSummary/generate');
const { WorkflowTriggerSetV1Schema } = await import('@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1');
const { buildTriggerTarget } = await import('@/components/workflows/triggers/sessionTriggerForm');
const { SPECIMEN_COMPARISON } = await import('@/components/dev/changes/walkthroughSpecimenFixture');
const initialStorage = getStorage().getState();

beforeEach(async () => { await homes.reset(); resetDynamicModelProbeCacheForTests(); });
afterEach(async () => {
    standardCleanup();
    vi.useRealTimers();
    getStorage().setState(initialStorage, true);
    boundary.saved = null; boundary.read = null; boundary.recover = null;
    boundary.generate = null; boundary.listSaved = true;
    boundary.requests = [];
    await homes.reset();
});

async function addHome(name: string) {
    const id = await homes.addHome({ name, serverUrl: `https://${name}.example.test`,
        accountId: 'commit-plan-account', accountEncryptionMode: 'plain', currentAccount: true });
    homes.answer(id, ACP_CATALOG_ROWS_ROUTE_V1, { body: AcpCatalogRowReadResponseV1Schema.parse({ status: 'absent' }) });
    return { id };
}

function proposalDiagnostic(plan: ReturnType<typeof useScmCommitPlan> | null) {
    const bound = plan?.binding;
    return JSON.stringify({ phase: plan?.phase, supportedComparison: plan?.supportedComparison,
        binding: bound ? { host: bound.host, scope: bound.scope, cwd: bound.cwd, machine: bound.machine,
            current: bound.isCurrent(), machineReachable: bound.machineReachable, canControl: bound.canControl,
            canSend: bound.canSend, launch: bound.launch, comparison: bound.comparison, selected: bound.selected,
            modelAvailable: bound.modelAvailable, error: bound.error,
            resultId: bound.viewModel?.resultId, revision: bound.viewModel?.revision,
            outputState: bound.viewModel?.outputs?.commitPlan?.state,
            captured: bound.capturedComparison ? { id: bound.capturedComparison.id,
                root: bound.capturedComparison.repository.rootPath, source: bound.capturedComparison.source } : null,
        } : null,
        rpc: boundary.requests, homePaths: homes.requests.map(request => request.path),
    });
}

function savedResult(revision: number, status: 'unknown' | 'applying' | 'complete') {
    const head = 'a'.repeat(40);
    const comparisonId = 'c'.repeat(64);
    const plan = { groups: [{ id: 'g1', message: 'One commit', rationale: '', changeRefs: [] }], leftOutChangeRefs: [] };
    return ScmDiffSummaryResultSchema.parse({ resultId: 'poll-result', revision, canUndo: false,
        application: { acceptedRevision: 1, acceptance: { comparisonId, repositoryRootPath: '/repo/exact',
            expectedHeadOid: head, expectedRef: 'refs/heads/main', ...plan }, status,
            steps: [{ groupId: 'g1', state: status === 'complete' ? 'published' : status === 'applying' ? 'writing' : 'unknown',
                ...(status === 'complete' ? { commitSha: 'b'.repeat(40) } : {}) }],
            nextGroupIndex: status === 'complete' ? 1 : 0, stopAfterCurrent: false },
        output: { success: true, resultId: 'poll-result', revision, sourceKey: comparisonId,
            metadata: { sourceKey: comparisonId, source: { kind: 'workingTree' } }, requestedOutputs: ['commitPlan'],
            comparison: { id: comparisonId, source: { kind: 'workingTree' }, repository: { rootPath: '/repo/exact' },
                endpoints: { before: head }, commitTarget: { headOid: head, ref: 'refs/heads/main' },
                inventory: { state: 'complete', files: [], reasons: [] } },
            outputs: { commitPlan: { state: 'complete', value: plan } },
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
        } });
}

async function mountProposal(sessionId: string, saved = savedResult(1, 'unknown')) {
    boundary.sessionId = sessionId;
    boundary.saved = saved;
    const home = await addHome(sessionId);
    const machine = createMachineFixture({ id: 'machine:commit-progress', activeAt: Date.now() });
    const session = createSessionFixture({ id: boundary.sessionId, serverId: home.id, active: true,
        metadata: { path: '/repo/exact', host: 'tester.local', machineId: machine.id, flavor: 'codex' } });
    getStorage().setState({ sessions: { [session.id]: session }, machines: { [machine.id]: machine },
        machineListByServerId: { [home.id]: [machine] }, settings: { ...initialStorage.settings,
            experiments: true, featureToggles: { 'execution.runs': true } } });
    const latest: { current: ReturnType<typeof useSessionCommitPlan> | null } = { current: null };
    const visibility: { setEnabled: React.Dispatch<React.SetStateAction<boolean>> | null } = { setEnabled: null };
    function Probe() {
        const [enabled, setEnabled] = React.useState(true);
        visibility.setEnabled = setEnabled;
        latest.current = useSessionCommitPlan({ sessionId: session.id, serverId: home.id, enabled, branch: 'main' });
        return null;
    }
    const screen = await renderScreen(<Probe />);
    await vi.waitFor(() => expect(latest.current?.proposal?.application?.status, proposalDiagnostic(latest.current)).toBe(saved.application?.status));
    return { latest, screen, visibility };
}

async function mountWorkspaceProposal(saved = savedResult(1, 'unknown'), renderProposal = false, renderWhilePending = false) {
    boundary.sessionId = '';
    boundary.saved = saved;
    const home = await addHome('workspace-commit-plan');
    const machine = createMachineFixture({ id: 'machine:workspace-commit-plan', activeAt: Date.now() });
    const backendTarget = { kind: 'backend', backendId: 'codex' } as const;
    const profile = buildScmDiffSummaryModelProfiles({ backendTarget, models: OFFERED_MODELS })[0];
    const targetKey = profile?.modelSelector?.backendTargetKey;
    if (!profile || !targetKey) throw new Error('The offered fixture model must name its backend target.');
    getStorage().setState({ profileScope: { serverId: home.id, accountId: 'commit-plan-account' },
        sessions: {}, machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] },
        settings: { ...initialStorage.settings, experiments: true, featureToggles: { 'execution.runs': true },
            [SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]: profile.catalogId } });
    if (renderProposal) {
        // Observe the remote catalog through the real discovery/cache owner before reopening the saved view.
        const cacheKey = buildDynamicModelProbeCacheKey({ machineId: machine.id, targetKey,
            serverId: home.id, providerConnectionId: null });
        if (!cacheKey) throw new Error('The fixture Machine must have a model discovery key.');
        const observed = await discoverMachineModels({ cacheKey, machineId: machine.id, serverId: home.id,
            agentType: 'codex', backendTarget, capabilityParams: {} });
        expect(observed?.kind, JSON.stringify({ observed,
            rpcMethods: boundary.requests.map(request => request.method),
            homePaths: homes.requests.map(request => request.path),
        })).toBe('success');
    }
    const latest: { current: ReturnType<typeof useSessionCommitPlan> | null } = { current: null };
    const target: {
        setRoot: React.Dispatch<React.SetStateAction<string>> | null;
        setComparison: React.Dispatch<React.SetStateAction<SessionScmReviewComparison>> | null;
    } = { setRoot: null, setComparison: null };
    function Probe() {
        const [rootPath, setRoot] = React.useState('/repo/exact');
        const [comparison, setComparison] = React.useState<SessionScmReviewComparison>(() => ({ kind: 'workingTree', comparisonId: saved.output.comparison!.id }));
        target.setRoot = setRoot;
        target.setComparison = setComparison;
        const bound = useWorkspaceScmDiffSummaryBinding({ serverId: home.id, machineId: machine.id, rootPath, comparison, output: 'commitPlan' });
        latest.current = useScmCommitPlan({ bound });
        // Reopening an already-restored proposal never visits the empty-state model picker.
        return renderProposal && (renderWhilePending || latest.current.phase === 'ready')
            ? <ScmCommitsView plan={latest.current} branch="main" layout="wide" renderBar={() => null} /> : null;
    }
    const screen = await renderScreen(<Probe />);
    return { latest, screen, machine, home, target };
}

describe('exact workspace commit plans', () => {
    it('keeps a previous saved proposal readable without treating its refresh as completion of a new admission', async () => {
        const initial = savedResult(1, 'complete');
        const saved = ScmDiffSummaryResultSchema.parse({ ...initial, application: undefined,
            output: { ...initial.output, runId: 'original-generator' } });
        boundary.listSaved = false;
        const admission = createDeferred<unknown>();
        let generations = 0;
        boundary.generate = () => ++generations === 1 ? Promise.resolve(saved.output) : admission.promise;
        const { latest, screen } = await mountWorkspaceProposal(saved, true, true);
        await vi.waitFor(() => expect(latest.current?.binding.modelAvailable, proposalDiagnostic(latest.current)).toBe(true));
        await vi.waitFor(() => expect(latest.current?.binding.launch.canLaunchExecutionRuns).toBe(true));
        await act(async () => { await latest.current!.binding.onStart(['commitPlan']); });
        await vi.waitFor(() => expect(latest.current?.binding.viewModel?.savedResult?.resultId).toBe(saved.resultId));
        let start!: Promise<void>;
        await act(async () => { start = latest.current!.binding.onStart(['commitPlan']); });
        await vi.waitFor(() => expect(generations).toBe(2));
        expect(latest.current?.binding.viewModel?.status, proposalDiagnostic(latest.current)).toBe('starting');
        expect(latest.current?.phase).toBe('ready');
        expect(latest.current?.isGenerating).toBe(true);
        expect(screen.findByTestId('commit-group:g1')).toBeTruthy();
        await act(async () => {
            admission.resolve(ScmDiffSummaryGenerateOutputSchema.parse({ success: false, errorCode: 'SUMMARY_FAILED', error: 'Retry failed.' }));
            await start;
        });
        expect(latest.current?.binding.generationFailure).toMatchObject({ reason: 'generationFailed', messageKey: 'walkthrough.notice.failedGeneric' });
        expect(latest.current?.error).toBeNull();
        expect(latest.current?.isGenerating).toBe(false);
        expect(screen.findByTestId('commit-group:g1')).toBeTruthy();
    });

    it('shows a generation failure retained in a successfully admitted saved result', async () => {
        const failed = ScmDiffSummaryResultSchema.parse({ ...savedResult(1, 'complete'), application: undefined,
            output: { ...savedResult(1, 'complete').output, outputs: { commitPlan: { state: 'failed', reason: 'Native model provisioning failed' } } } });
        boundary.listSaved = false;
        boundary.generate = async () => failed.output;
        const { latest, screen } = await mountWorkspaceProposal(failed, true, true);
        await vi.waitFor(() => expect(latest.current?.binding.modelAvailable, proposalDiagnostic(latest.current)).toBe(true));
        await vi.waitFor(() => expect(latest.current?.binding.launch.canLaunchExecutionRuns).toBe(true));
        await act(async () => { await latest.current!.binding.onStart(['commitPlan']); });
        await vi.waitFor(() => expect(latest.current?.binding.viewModel?.status).toBe('failed'));
        expect(latest.current?.binding.generationFailure, proposalDiagnostic(latest.current)).toMatchObject({ reason: 'generationFailed' });
        expect(latest.current?.isGenerating).toBe(false);
        expect(screen.findByTestId('commit-proposal-writing')).toBeNull();
        expect(screen.findByTestId('commit-proposal-start-options-refusal')).toBeTruthy();
        expect(screen.findByTestId('commit-proposal-start')?.props.disabled).toBe(false);
        expect(screen.getTextContent()).toContain('Writing stopped');
        expect(screen.getTextContent()).not.toContain('Native model provisioning failed');
    });

    it('shows admission progress for exact captured evidence and retains its failure through the real Action transport', async () => {
        boundary.listSaved = false;
        const admission = createDeferred<unknown>();
        boundary.generate = () => admission.promise;
        const { latest, screen, machine } = await mountWorkspaceProposal(savedResult(1, 'complete'), true, true);
        await vi.waitFor(() => expect(latest.current?.binding.modelAvailable, proposalDiagnostic(latest.current)).toBe(true));
        await vi.waitFor(() => expect(latest.current?.binding.launch.canLaunchExecutionRuns).toBe(true));
        expect(latest.current?.phase).toBe('none');
        let start!: Promise<void>;
        await act(async () => { start = latest.current!.binding.onStart(['commitPlan']); });
        await vi.waitFor(() => expect(boundary.requests.some(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE)).toBe(true));
        expect(latest.current?.binding.viewModel?.status, proposalDiagnostic(latest.current)).toBe('starting');
        expect(screen.findByTestId('commit-proposal-writing')).toBeTruthy();
        expect(boundary.requests.find(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE)).toMatchObject({
            machineId: machine.id, payload: { comparisonId: 'c'.repeat(64), cwd: '/repo/exact', outputs: ['commitPlan'] },
        });
        await act(async () => {
            admission.resolve(ScmDiffSummaryGenerateOutputSchema.parse({ success: false, errorCode: 'SUMMARY_FAILED', error: 'Generation failed.' }));
            await start;
        });
        expect(latest.current?.binding.viewModel?.status).toBe('failed');
        expect(latest.current?.binding.generationFailure).toMatchObject({ reason: 'generationFailed' });
        expect(latest.current?.phase).toBe('none');
        expect(screen.findByTestId('commit-proposal-writing')).toBeNull();
        expect(screen.getTextContent()).toContain('Writing stopped');
        expect(screen.getTextContent()).not.toContain('SUMMARY_FAILED');
    });

    it('keeps the exact Run notification and its cancellation available as partial groups arrive, until output completion', async () => {
        const initial = savedResult(1, 'complete');
        const occurrence = SPECIMEN_COMPARISON.inventory.files[0]!.occurrences[0]!;
        const allRefs = SPECIMEN_COMPARISON.inventory.files.flatMap(file => file.occurrences.map(change => change.id));
        const plan = { groups: [{ id: 'g1', message: 'One commit', rationale: '', changeRefs: [occurrence.id] }],
            leftOutChangeRefs: allRefs.filter(id => id !== occurrence.id) };
        const outputAt = (revision: number, state: 'pending' | 'writing' | 'complete') => ScmDiffSummaryResultSchema.parse({
            ...initial, application: undefined, revision, output: { ...initial.output, revision, runId: 'commit-plan-generator',
                comparison: { ...initial.output.comparison, inventory: SPECIMEN_COMPARISON.inventory },
                analysis: state === 'complete' ? { suppliedChangeRefs: allRefs, analysedChangeRefs: allRefs, remainingChangeRefs: [] }
                    : { suppliedChangeRefs: state === 'pending' ? [] : [occurrence.id],
                        analysedChangeRefs: state === 'pending' ? [] : [occurrence.id],
                        remainingChangeRefs: state === 'pending' ? allRefs : plan.leftOutChangeRefs },
                outputs: { commitPlan: { state, ...(state === 'pending' ? {} : { value: plan }) } } },
        });
        const pending = outputAt(1, 'pending');
        const { latest, screen, machine } = await mountWorkspaceProposal(pending, true, true);
        await vi.waitFor(() => expect(screen.findByTestId('commit-proposal-notify'), proposalDiagnostic(latest.current)).toBeTruthy());
        const notification = screen.root.findByType(RunWorkNotifications);
        const sourceIdentity = notification.props.source;
        const outputIdentity = notification.props.selectedOutput;
        expect(notification.props.source).toEqual({ kind: 'execution_run', machineId: machine.id, runId: 'commit-plan-generator' });
        expect(notification.props.selectedOutput).toMatchObject({ output: 'commitPlan',
            comparisonId: pending.output.comparison!.id, resultId: pending.resultId });
        expect(screen.findByTestId('commit-group:g1')).toBeNull();
        const requestKey = latest.current!.binding.viewModel!.requestKey;
        const armed = WorkflowTriggerSetV1Schema.parse({ automationId: 'proposal-notification', revision: 1,
            enabled: true, health: 'available', project: { machineId: machine.id, directory: '/repo/exact' },
            target: buildTriggerTarget({ kind: 'notifyMe', message: 'Proposal update', title: '', channels: [] }, 'account'),
            triggers: [{ id: 'proposal-trigger', revision: 0, createdAt: 1, updatedAt: 1, enabled: true,
                kind: 'runLifecycle', condition: 'terminal', remainingOccurrences: 1, status: { state: 'waiting', runId: null },
                triggerDefinitionEnvelope: null,
                source: { ...sourceIdentity, observation: { kind: 'scm_diff_summary', output: 'commitPlan',
                    comparisonId: pending.output.comparison!.id, resultId: pending.resultId, afterRevision: 1 } } }],
        });
        // External persisted trigger snapshot, parsed by the strict consumer; real store matching and control stay mounted.
        await act(async () => getStorage().getState().upsertWorkflowTriggerSet({ set: armed, queryKey: 'account_inline' }));
        expect(screen.findByTestId('notify-run-terminal-cancel:commit-plan-generator')).toBeTruthy();
        const writing = outputAt(2, 'writing');
        boundary.saved = writing;
        await act(async () => applySavedScmDiffSummaryResult(requestKey, writing));
        expect(latest.current?.phase).toBe('ready');
        expect(screen.findByTestId('commit-group:g1')).toBeTruthy();
        expect(latest.current?.proposal?.groups[0]?.changes[0]?.changeRefs).toEqual([occurrence.id]);
        expect(screen.findByTestId('commit-proposal-writing')).toBeNull();
        expect(screen.findByTestId('commit-proposal-notify')).toBeTruthy();
        expect(screen.findByTestId('notify-run-terminal-cancel:commit-plan-generator')).toBeTruthy();
        expect(screen.root.findByType(RunWorkNotifications)).toBe(notification);
        expect(screen.root.findByType(RunWorkNotifications).props.source).toEqual(sourceIdentity);
        expect(screen.root.findByType(RunWorkNotifications).props.selectedOutput).toEqual(outputIdentity);
        const complete = outputAt(3, 'complete');
        boundary.saved = complete;
        await act(async () => applySavedScmDiffSummaryResult(requestKey, complete));
        expect(screen.findByTestId('commit-group:g1')).toBeTruthy();
        expect(screen.findByTestId('commit-proposal-notify')).toBeNull();
    });

    it('regenerates a restored proposal with its actually offered model without visiting the empty-state picker', async () => {
        const saved = ScmDiffSummaryResultSchema.parse({ ...savedResult(1, 'complete'), application: undefined });
        const { latest, machine } = await mountWorkspaceProposal(saved, true);
        await vi.waitFor(() => expect(latest.current?.phase, proposalDiagnostic(latest.current)).toBe('ready'));
        await vi.waitFor(() => expect(latest.current?.binding.launch.canLaunchExecutionRuns).toBe(true));
        expect(latest.current?.binding.selected.success).toBe(true);
        expect(latest.current?.actions.onRegenerate).toBeDefined();
        await act(async () => latest.current?.actions.onRegenerate?.());
        await vi.waitFor(() => expect(latest.current?.binding.generationFailure).toMatchObject({ reason: 'generationFailed' }));
        expect(boundary.requests.find(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE)).toMatchObject({
            machineId: machine.id, payload: { cwd: '/repo/exact', outputs: ['commitPlan'] },
        });
        expect(boundary.requests.every(request => !request.sessionId)).toBe(true);
    }, 120_000);

    it('restores and recovers the saved application without selecting or creating a Session', async () => {
        const { latest, machine } = await mountWorkspaceProposal();
        await vi.waitFor(() => expect(latest.current?.proposal?.outcome?.kind).toBe('unknown'));
        boundary.recover = async () => ({ success: true, result: savedResult(2, 'complete') });
        await act(async () => latest.current?.actions.onRecover?.());
        await vi.waitFor(() => expect(latest.current?.proposal?.groups[0]?.state).toBe('landed'));
        const recovery = boundary.requests.find(request => request.method === 'scm.diffSummary.commitPlan.recover');
        expect(recovery).toMatchObject({ machineId: machine.id, payload: { cwd: '/repo/exact', resultId: 'poll-result', expectedRevision: 1 } });
        expect(boundary.requests.every(request => !request.sessionId)).toBe(true);
        expect(getStorage().getState().sessions).toEqual({});
    }, 120_000);

    it('retires application observation when the selected checkout changes without cancelling the old application', async () => {
        const { latest, target } = await mountWorkspaceProposal();
        await vi.waitFor(() => expect(latest.current?.proposal?.outcome?.kind).toBe('unknown'));
        const recovery = createDeferred<unknown>();
        boundary.recover = () => recovery.promise;
        await act(async () => latest.current?.actions.onRecover?.());
        expect(latest.current?.busy).toBe(true);
        await act(async () => target.setRoot?.('/repo/other'));
        expect(latest.current?.proposal).toBeNull();
        expect(latest.current?.busy).toBe(false);
        await act(async () => recovery.resolve({ success: true, result: savedResult(2, 'complete') }));
        expect(latest.current?.proposal).toBeNull();
        expect(boundary.requests.some(request => request.method === 'scm.diffSummary.commitPlan.cancel')).toBe(false);
    }, 120_000);

    it('does not substitute pending changes or their application controls after selecting committed evidence', async () => {
        const { latest, target } = await mountWorkspaceProposal();
        await vi.waitFor(() => expect(latest.current?.proposal?.outcome?.kind).toBe('unknown'));
        await act(async () => target.setComparison?.({ kind: 'commit', commit: 'b'.repeat(40) }));
        expect(latest.current?.supportedComparison).toBe(false);
        expect(latest.current?.proposal).toBeNull();
        expect(latest.current?.actions.onCreate).toBeUndefined();
        expect(latest.current?.actions.onRecover).toBeUndefined();
        expect(latest.current?.addToSaved).toBeNull();
    }, 120_000);
});

describe('useSessionCommitPlan application progress', () => {
    it('keeps at most one slow progress read in flight and preserves progress and final publication', async () => {
        const { latest } = await mountProposal('slow-commit-progress');
        const slowRead = createDeferred<unknown>();
        const recovery = createDeferred<unknown>();
        let outstanding = 0;
        let maxOutstanding = 0;
        let reads = 0;
        boundary.read = async () => {
            reads += 1; outstanding += 1; maxOutstanding = Math.max(maxOutstanding, outstanding);
            try { return await slowRead.promise; } finally { outstanding -= 1; }
        };
        boundary.recover = () => recovery.promise;
        vi.useFakeTimers();
        await act(async () => latest.current?.actions.onRecover?.());
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
        expect(maxOutstanding).toBe(1);
        await act(async () => slowRead.resolve({ success: true, result: savedResult(2, 'applying') }));
        expect(latest.current?.proposal?.groups[0]?.state).toBe('writing');
        await act(async () => recovery.resolve({ success: true, result: savedResult(3, 'complete') }));
        expect(latest.current?.proposal?.groups[0]?.state).toBe('landed');
        expect(latest.current?.busy).toBe(false);
        const completedReads = reads;
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
        expect(reads).toBe(completedReads);
    }, 120_000);

    it('stops reading progress after the proposal view unmounts without cancelling its application', async () => {
        const { latest, screen } = await mountProposal('unmounted-commit-progress');
        const recovery = createDeferred<unknown>();
        boundary.recover = () => recovery.promise;
        let reads = 0;
        boundary.read = async () => { reads += 1; return { success: true, result: boundary.saved }; };
        vi.useFakeTimers();
        const idleTimers = vi.getTimerCount();
        await act(async () => latest.current?.actions.onRecover?.());
        expect(vi.getTimerCount()).toBe(idleTimers + 1);
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect(reads).toBe(1);
        await act(async () => screen.unmount());
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
        expect(reads).toBe(1);
        expect(vi.getTimerCount()).toBe(idleTimers);
        const complete = savedResult(3, 'complete');
        boundary.saved = complete;
        await act(async () => recovery.resolve({ success: true, result: complete }));
        vi.useRealTimers();
        const reopened = await mountProposal('unmounted-commit-progress', complete);
        expect(reopened.latest.current?.proposal?.groups[0]?.state).toBe('landed');
    }, 120_000);

    it('retires progress polling when a retained Git view is hidden and preserves the final current-Account result', async () => {
        const { latest, visibility } = await mountProposal('hidden-commit-progress');
        const recovery = createDeferred<unknown>();
        boundary.recover = () => recovery.promise;
        let reads = 0;
        boundary.read = async () => { reads += 1; return { success: true, result: boundary.saved }; };
        vi.useFakeTimers();
        const idleTimers = vi.getTimerCount();
        await act(async () => latest.current?.actions.onRecover?.());
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect(reads).toBe(1);
        await act(async () => visibility.setEnabled?.(false));
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
        expect(reads).toBe(1);
        expect(vi.getTimerCount()).toBe(idleTimers);
        boundary.saved = savedResult(3, 'complete');
        await act(async () => recovery.resolve({ success: true, result: boundary.saved }));
        await act(async () => visibility.setEnabled?.(true));
        expect(latest.current?.proposal?.groups[0]?.state).toBe('landed');
    }, 120_000);
});
