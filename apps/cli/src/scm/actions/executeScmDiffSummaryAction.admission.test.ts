import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgentStaticModels } from '@happier-dev/agents';
import { getActionSpec, ExecutionRunStartRequestSchema, ExecutionRunStartResponseSchema, ExecutionRunScmDiffSummaryInputV1Schema, ScmComparisonSchema, PluginManifestV2Schema,
    type ActionExecuteResult, type BackendTargetRefV2, type ScmDiffSummaryGenerateInput } from '@happier-dev/protocol';

import { createLocalScmRepositoryFixture } from '@/scm/contracts/scmBackendContractFixtures';
import { gitCheckpointAdapter, resolveGitCheckpointBackendContext } from '@/scm/checkpoints/gitCheckpointAdapter';
import { buildRepositoryCheckpointRefs } from '@/scm/checkpoints/refs';
import { retainRepositoryCheckpointTurnEvidence } from '@/scm/checkpoints/sessionEvidence';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { ScmDiffSummaryProfile } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/ScmDiffSummaryProfile';
import { startExecutionRun } from '@/agent/runtime/bridges/executionRun/startExecutionRun';
import { stopExecutionRun } from '@/agent/runtime/bridges/executionRun/executionRunStop';
import { sendBackendLongLivedRun } from '@/agent/runtime/bridges/executionRun/send/backendLongLivedPrompt';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { executeScmDiffSummaryAction } from './executeScmDiffSummaryAction';
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';
import { createEncryptedRpcTestClient } from '@/rpc/handlers/encryptedRpc.testkit';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { PluginDaemonModuleNamespace } from '@/plugins/runtime/types';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { CLAUDE_PLUGIN } from '@happier-dev/plugins-claude/manifest';
import { createExecutionRunHostBackendFromConversationRuntime,
    type AgentRuntime, type AgentExecutionRunConversationEventV1, type AgentSessionSendRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { captureScmComparison } from '@/scm/comparisons/captureScmComparison';
import type { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import type { ExecutionRunAdmittedPendingInputV1 } from '@/api/session/client/transport/sessionClientInteractionApi';
import { UserMessageSchema } from '@/api/types';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { DurableProviderInputAcceptanceV1 } from '@/agent/runtime/session/input/providerInputOutcome';

// This Session's daemon is a separate process. Keep its admission parser real.
vi.mock('@/daemon/controlHttp', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/controlHttp')>();
    const { EXECUTION_RUN_ADMISSION_PATH } = await import('@/daemon/lifecycle/admissionDrain');
    return { ...actual, daemonPost: async (...args: Parameters<typeof actual.daemonPost>) =>
        args[0] === EXECUTION_RUN_ADMISSION_PATH ? { admitted: true } : actual.daemonPost(...args) };
});

// Model discovery's installation/filesystem boundary uses the canonical publication fixture.
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
    return createBundledPluginPublicationFsFixture(actual);
});

describe('SCM generation through real host admission', () => {
    const directories: string[] = [];
    beforeEach(() => {
        vi.stubEnv('HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED', '0');
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
    });

    describe('registered native Run', () => {
        let nativeRuntime: AgentRuntime | undefined;
        let admitted: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>;
        let realRegistrations: Awaited<ReturnType<typeof createPluginTestkit>>;
        let backendTarget: BackendTargetRefV2;

        // Source admission and physical fixture preparation have no independent
        // cutoff. The Run behavior below retains the normal test-body budget.
        beforeAll(async () => {
            const declaration = PluginManifestV2Schema.parse(JSON.parse(await readFile(
                new URL('../../../assets/bundled-plugin-manifests/claude.json', import.meta.url), 'utf8')));
            // Bundled first-party custody cannot be replaced by an authored callback.
            // Keep the real declaration closed under its own fixture occurrence.
            const fixturePluginId = 'acme.scm-generation';
            realRegistrations = await createPluginTestkit({ manifest: CLAUDE_PLUGIN.manifest,
                module: { activate: CLAUDE_PLUGIN.activate } });
            const realAgent = realRegistrations.registration('agents', 'claude');
            const subscription = realRegistrations.registration('connectedAccountDescriptors', 'claude-subscription');
            const anthropic = realRegistrations.registration('connectedAccountDescriptors', 'anthropic');
            if (!realAgent || !subscription || !anthropic) {
                throw new Error('Real Claude contribution registration fixture is incomplete');
            }
            // Admit real declarations and registrations; only native vendor
            // conversation/catalog I/O is supplied by the boundary fixture.
            admitted = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
                // Record I/O is the persistence boundary; scoped defaults and
                // validation remain the real settings owner.
                runtimeOptions: { accountSettingsRecordAdapter: {
                    async bindOperation() { return {
                        async readRecord() { return { status: 'absent' as const }; },
                        async writeRecord() { throw new Error('Read-only generation must not write Account settings'); },
                    }; },
                } }, plugins: [{
                    manifest: createPluginManifestV2Fixture({ id: fixturePluginId, contributes: {
                        agents: declaration.contributes?.agents,
                        connectedAccountDescriptors: declaration.contributes?.connectedAccountDescriptors,
                        settings: declaration.contributes?.settings,
                        systemTools: declaration.contributes?.systemTools,
                    } }),
                    files: {
                        'agent-runtime.mjs': `export let nativeFixture;
                            export let externalSessions;
                            export function configure(factory, companion) { nativeFixture = factory; externalSessions = companion; }`,
                        'daemon.mjs': `import * as leaf from './agent-runtime.mjs';
                            export function activate() {}
                            export function createActivationUnitModule(factory, agent, accounts, models) {
                                leaf.configure(factory, agent.externalSessions);
                                return { activate(api) {
                                    api.agents.register('claude', leaf.nativeFixture, {
                                        cliAuth: agent.cliAuth,
                                        preflightSessionControls: { probeModels: models },
                                        sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'nativeFixture',
                                            runtimeApiVersion: 1, externalSessionsExport: 'externalSessions' }
                                    });
                                    api.agents.registerTerminal('claude', agent.terminal);
                                    api.agents.registerExternalSessions('claude', leaf.externalSessions);
                                    api.connectedAccounts.register('claude-subscription', accounts.subscription);
                                    api.connectedAccounts.register('anthropic', accounts.anthropic);
                                } };
                            }`,
                    },
                    instantiateCommittedModule: module => {
                        const configure = module.createActivationUnitModule;
                        if (typeof configure !== 'function') throw new Error('Authored activation unit factory is unavailable');
                        const configured: unknown = configure(() => {
                            if (!nativeRuntime) throw new Error('Native runtime may open only in the behavior test');
                            return nativeRuntime;
                        }, realAgent, { subscription, anthropic }, () => getAgentStaticModels('claude', { catalogOnly: true }));
                        if (!configured || typeof configured !== 'object' || !('activate' in configured)) {
                            throw new Error('Authored activation unit did not return its module');
                        }
                        // Physical module boundary, not callback byte-integrity evidence.
                        return configured as PluginDaemonModuleNamespace;
                    },
                }] });
            const agent = [...admitted.registry.contributes.agentDefinitionsById.values()]
                .find(candidate => candidate.identity?.pluginId === fixturePluginId && candidate.identity.localId === 'claude');
            if (!agent) throw new Error('Admitted native Agent declaration is missing');
            // Match the Action producer's retained routing shape from Q10B-GEN.
            backendTarget = { kind: 'backend', backendId: agent.id, sourceKind: 'built_in' };
        }, 0);
        afterAll(async () => {
            try { await admitted?.dispose(); } finally { await realRegistrations?.dispose(); }
        }, 0);

        it('admits session-bound pending generation through the registered Run RPC and publishes all requested outputs', async () => {
            const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-session-rpc-' });
            directories.push(fixture.rootPath);
            await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Pending change\n');
            const sessionId = 'session-rpc-generation';
            const modelId = getAgentStaticModels('claude', { catalogOnly: true }).find(model => model.id.includes('haiku'))?.id;
            if (!modelId) throw new Error('Native structured model fixture is unavailable');
            let manager: ExecutionRunHostBridge | undefined;
            let observedModel: string | undefined;
            const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' }, sessionId });
            const aliases = captured.comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.alias));
            const createNativeConversation = () => {
                const listeners = new Set<(event: AgentExecutionRunConversationEventV1) => void>();
                const emit = (event: AgentExecutionRunConversationEventV1) => {
                    for (const listener of listeners) listener(event);
                };
                return {
                    watch(listener: (event: AgentExecutionRunConversationEventV1) => void) {
                        listeners.add(listener); emit({ kind: 'provider-session-id', providerSessionId: 'native-model-fixture' });
                        return { dispose() { listeners.delete(listener); } }; },
                    async send(input: AgentSessionSendRequest) {
                        const turnId = input.delivery.turnId;
                        emit({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
                        emit({ kind: 'turn-start', turnId, startedBy: 'host' });
                        emit({ kind: 'message-delta', turnId, channel: 'assistant', text: JSON.stringify({
                            summaryMarkdown: 'Pending summary.', walkthrough: { title: 'Pending changes', intro: '',
                                stops: [{ id: 'stop', title: 'Change', explanationMarkdown: 'Pending edit.', changeRefs: aliases }], otherChangeRefs: [] },
                            commitPlan: { groups: [{ id: 'group', message: 'fix: pending edit', rationale: 'Pending change.', changeRefs: aliases }], leftOutChangeRefs: [] },
                        }) });
                        emit({ kind: 'turn-complete', turnId });
                        return { status: 'admitted' as const };
                    },
                    async cancel({ turnId }: { turnId: string }) { emit({ kind: 'turn-cancelled', turnId, cause: 'user' }); return { status: 'requested' as const, turnId }; },
                    async dispose() { listeners.clear(); },
                };
            };
            nativeRuntime = { sessions: {
                async open(request) {
                    // Attached Runs retain the actual parent Session's identity.
                    expect(request.sessionId).toBe(sessionId);
                    observedModel = request.configuration?.model.value ?? undefined;
                    const conversation = createNativeConversation();
                    let sequence = 0;
                    return { ...conversation,
                        async updateConfiguration() { throw new Error('Generation must retain its admitted model configuration'); },
                        watch(listener) {
                            return conversation.watch(event => listener({ ...event, sequence: ++sequence,
                                sessionId: request.sessionId, emittedAtMs: event.emittedAtMs ?? Date.now() }));
                        } };
                },
                executionRunContextV1: { async open(request) {
                    if (request.kind === 'fork') throw new Error('Unexpected fork');
                    return await createExecutionRunHostBackendFromConversationRuntime({ request,
                        openConversation: async () => createNativeConversation() });
                } },
            } };
            const pendingInputs = new Map<string, ExecutionRunAdmittedPendingInputV1[]>();
            const durableAcceptance = new Map<string, DurableProviderInputAcceptanceV1>();
            // Pending custody is the parent Session's network/persistence boundary.
            // Its real retained consumer, delivery, native codec and publisher run below.
            const session = createMutableApiSessionClientFixture({ sessionId, overrides: {
                enqueueSessionUserMessageWithDisposition: async input => {
                    if (input.recipient?.kind !== 'execution_run') throw new Error('Expected exact Run recipient');
                    const inputs = pendingInputs.get(input.recipient.runId) ?? [];
                    inputs.push({ ...UserMessageSchema.parse({ role: 'user', content: { type: 'text', text: input.text }, localId: input.localId }),
                        authorAccountId: null, inputAdmissionReceipt: null, pendingProviderAction: 'send' });
                    pendingInputs.set(input.recipient.runId, inputs);
                    session.updateMetadata(previous => previous);
                    return { status: 'accepted', localId: input.localId };
                },
                bindExecutionRunPendingInput: binding => {
                    const onPendingUpdate = () => binding.wake?.();
                    session.on('metadata-updated', onPendingUpdate);
                    return {
                        getMetadataSnapshot: session.getMetadataSnapshot,
                        waitForMetadataUpdate: session.waitForMetadataUpdate,
                        shouldAttemptPendingMaterialization: () => (pendingInputs.get(binding.recipient.runId)?.length ?? 0) > 0,
                        reconcilePendingProviderInputCustodyBeforeMaterialization: async () => true,
                        materializeNextPendingMessageSafely: async () => {
                            const input = pendingInputs.get(binding.recipient.runId)?.shift();
                            if (!input) return { type: 'no_pending' };
                            durableAcceptance.set(input.localId!, 'unknown');
                            if (!binding.consume(input)) throw new Error('Retained Run refused its admitted input');
                            return { type: 'materialized', localId: input.localId!, seq: null, content: null };
                        },
                        observeProviderInputSettlement: async outcome => {
                            if (outcome.kind === 'accepted') durableAcceptance.set(outcome.localId, 'accepted');
                            if (outcome.kind === 'rejected_before_effect') durableAcceptance.set(outcome.localId, 'not_accepted');
                            return true;
                        },
                        readDurableProviderInputAcceptanceV1: async localId => durableAcceptance.get(localId) ?? 'unknown',
                        dispose: () => { session.off('metadata-updated', onPendingUpdate); },
                    };
                },
            } });
            const client = createEncryptedRpcTestClient({ scopePrefix: sessionId,
                registerHandlers: rpc => registerExecutionRunHandlers(rpc, { sessionId, cwd: fixture.rootPath,
                    parentProvider: 'claude', sendAcp: async () => {},
                    sessionInteractionHost: { machineId: 'fixture-machine',
                        readAppliedChildSelection: () => ({ status: 'applied', backendTarget,
                            modelId, connectedServices: null }),
                        session,
                        permissionHandler: new ProviderEnforcedPermissionHandler(session, { logPrefix: '[SCM generation seam]' }) },
                    onManagerCreated: created => { manager = created; } }) });
            const responses: unknown[] = [];
            try {
                const output = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath, source: { kind: 'workingTree' }, comparisonId: captured.comparison.id,
                    modelSelector: { modelId }, outputs: ['summary', 'walkthrough', 'commitPlan'] }, sessionId,
                    backendTarget, executeCanonicalAction: async (actionId, input) => {
                        const method = getActionSpec(actionId).bindings?.rpcMethod;
                        if (!method) throw new Error('Canonical Run Action RPC binding is unavailable');
                        const response = await client.call<unknown, unknown>(method,
                            ExecutionRunStartRequestSchema.parse(input));
                        responses.push(response);
                        const parsed = ExecutionRunStartResponseSchema.safeParse(response);
                        return parsed.success ? { ok: true, result: parsed.data } : { ok: false, error: JSON.stringify(response) };
                    } });
                expect(output, JSON.stringify(responses)).toMatchObject({ success: true, runId: expect.any(String) });
                if (!output.success || !output.runId || !output.inputId || !output.resultId || !manager) {
                    throw new Error('Generation did not return exact retained Run input custody');
                }
                const turn = await manager.waitForInputTurn(output.runId, output.inputId);
                expect(turn, JSON.stringify({ run: manager.getPublic(output.runId), observedModel })).toMatchObject({ turn: { state: 'completed' } });
                // Exact input completion precedes the host's asynchronous saved-result publication.
                await vi.waitFor(async () => expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, sessionId,
                    resultId: output.resultId })).toMatchObject({ success: true, result: { output: { outputs: {
                        summary: { state: 'complete' }, walkthrough: { state: 'complete' }, commitPlan: { state: 'complete' },
                    } } } }));
                expect(observedModel).toBe(modelId);
            } finally { await manager?.dispose(); await session.close(); }
        });
    });

    it('joins concurrent clients for one checkpoint and reuses its completed saved output', async () => {
        const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-admission-' });
        directories.push(fixture.rootPath);
        const sessionId = 'same-checkpoint-session';
        const turnId = 'turn-1';
        const scopeId = `${sessionId}:${fixture.rootPath}`;
        const refs = buildRepositoryCheckpointRefs({ scopeId, turnId });
        const context = await resolveGitCheckpointBackendContext({ cwd: fixture.rootPath });
        if (!context || !refs.turnStart || !refs.turnFinal) throw new Error('Checkpoint fixture is unavailable');
        const start = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnStart });
        await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Checkpoint change\n');
        const final = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnFinal });
        if (!start.success || !final.success) throw new Error('Checkpoint fixture capture failed');
        await retainRepositoryCheckpointTurnEvidence({ cwd: fixture.rootPath, scopeId, turnChangeSet: {
            sessionId, turnId, provider: 'claude', derivedAt: 1, status: 'completed', files: [],
            seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
            repositoryCheckpoint: { version: 1, scopeId, startRef: refs.turnStart.ref, finalRef: refs.turnFinal.ref,
                baseRefSource: 'turn_start', contentConfidence: 'exact', attributionScope: 'shared_worktree',
                receipts: [...start.receipts, ...final.receipts] },
        } });
        const modelId = getAgentStaticModels('claude', { catalogOnly: true }).find(model => model.id.includes('haiku'))?.id;
        if (!modelId) throw new Error('Native structured model fixture is unavailable');
        const runs = new Map<string, ExecutionRunState>();
        const controllers = new Map<string, ExecutionRunController>();
        const delivered = new Set<string>();
        const deliveredModels = new Map<string, string | undefined>();
        let failProvision = false;
        let releaseModel = () => {};
        let modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
        const createRuntime: Parameters<typeof startExecutionRun>[0]['createRuntime'] = (options) => {
            const runtime = createTestExecutionRunHostRuntime({
                resumeSupported: true,
                onProvisionRuntime: async () => { if (failProvision) throw new Error('Native model provisioning failed'); },
                onSendPrompt: async () => {
                    deliveredModels.set(options.runId!, options.start?.modelId);
                    delivered.add(options.runId!);
                    await modelGate;
                    const input = ExecutionRunScmDiffSummaryInputV1Schema.parse(options.start?.intentInput);
                    const comparison = ScmComparisonSchema.parse(input.comparison);
                    runtime.emitMessage({ type: 'model-output', fullText: JSON.stringify(input.outputs?.includes('walkthrough')
                        ? { walkthrough: { title: 'Checkpoint', intro: 'Captured change', stops: [{ id: 'stop', title: 'Changed file',
                            explanationMarkdown: 'The captured file changed.', changeRefs: comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.alias)) }],
                            otherChangeRefs: [] } } : { summaryMarkdown: 'Checkpoint summary.' }) });
                },
                onWaitForTurnCompletion: async () => {},
            });
            return runtime;
        };
        const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('Unused Voice runtime'); } });
        const finishRun: Parameters<typeof startExecutionRun>[0]['finishRun'] = async (runId, next) => {
            const current = runs.get(runId);
            if (current) runs.set(runId, { ...current, ...next });
        };
        const send: Parameters<typeof startExecutionRun>[0]['send'] = (runId, params) => sendBackendLongLivedRun({
            runId, params, runs, controllers, budgetRegistry: null, createRuntime, maxTurns: null,
            getNowMs: Date.now, finishRun, sendAcp: async () => {}, parentProvider: 'claude',
            streamedTranscriptSession: null, writeActivityMarker: async () => {},
        });
        const execute = (client: string) => async (_action: 'execution.run.start', input: unknown): Promise<ActionExecuteResult> => {
            const request = ExecutionRunStartRequestSchema.parse(input);
            const prepared = await ScmDiffSummaryProfile.prepareStartParams!({ request, cwd: fixture.rootPath, sessionId });
            const result = await startExecutionRun({
                params: { ...request, ...prepared, sessionId, cwd: fixture.rootPath,
                    backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, actionRequestId: `client-${client}` },
                parentProvider: 'claude', sendAcp: async () => {}, streamedTranscriptSession: null,
                createRuntime, getNowMs: Date.now, budgetRegistry: null, runs, controllers,
                enqueueMarkerWrite: async (_id, write) => write(), writeActivityMarker: async () => {},
                finishRun, executeBoundedRun: async () => { throw new Error('Unexpected bounded dispatch'); }, send, voiceAgentManager,
            });
            return { ok: true, result };
        };
        const request = { cwd: fixture.rootPath, source: { kind: 'turnCheckpoint' as const }, turnId,
            checkpointReceiptId: 'checkpoint.finalized', modelSelector: { modelId } };
        const generate = (client: string, override: Partial<ScmDiffSummaryGenerateInput> = {}) => executeScmDiffSummaryAction({ request: { ...request, ...override }, sessionId,
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, executeCanonicalAction: execute(client) });
        try {
            const [left, right] = await Promise.all([generate('a'), generate('b')]);
            expect(right.comparison?.id).toBe(left.comparison?.id);
            await vi.waitFor(() => expect(delivered.size).toBeGreaterThan(0));
            expect({ admittedRuns: runs.size, modelRuns: delivered.size, resultIds: new Set([left.resultId, right.resultId]).size })
                .toEqual({ admittedRuns: 1, modelRuns: 1, resultIds: 1 });
            expect(right.runId).toBe(left.runId);
            expect(deliveredModels.get(left.runId!)).toBe(modelId);
            releaseModel();
            await vi.waitFor(async () => expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, sessionId, resultId: left.resultId! }))
                .toMatchObject({ success: true, result: { output: { outputs: { summary: { state: 'complete' } } } } }));
            const cached = await generate('c');
            expect(cached).toMatchObject({ resultId: left.resultId, runId: left.runId, outputs: { summary: { state: 'complete' } } });
            expect(runs.size).toBe(1);
            expect(delivered.size).toBe(1);
            const regenerated = await generate('explicit-regeneration', { cachePolicy: { mode: 'bypass' } });
            expect(regenerated.resultId).not.toBe(left.resultId);
            await vi.waitFor(() => expect(delivered.size).toBe(2));
            const differentModelId = getAgentStaticModels('claude', { catalogOnly: true }).find(model => model.id !== modelId)?.id;
            if (!differentModelId) throw new Error('Second offered structured model fixture is unavailable');
            const differentModel = await generate('new-model', { modelSelector: { modelId: differentModelId } });
            expect(differentModel.resultId).not.toBe(left.resultId);
            await vi.waitFor(() => expect(delivered.size).toBe(3));
            expect(deliveredModels.get(differentModel.runId!)).toBe(differentModelId);
            const differentOutput = await generate('new-output', { outputs: ['walkthrough'] });
            expect(differentOutput.resultId).not.toBe(left.resultId);
            await vi.waitFor(() => expect(delivered.size).toBe(4));
            failProvision = true;
            const failed = await generate('failed-provision', { cachePolicy: { mode: 'bypass' } });
            await vi.waitFor(() => expect(runs.get(failed.runId!)?.status).toBe('failed'));
            const retainedFailure = await generate('observe-failure');
            expect(retainedFailure).toMatchObject({ resultId: failed.resultId, runId: failed.runId });
            expect(delivered.size).toBe(4);
            failProvision = false;
            const retried = await generate('explicit-retry', { cachePolicy: { mode: 'bypass' } });
            expect(retried.runId).not.toBe(failed.runId);
            await vi.waitFor(() => expect(delivered.size).toBe(5));
            modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
            const cancelled = await generate('cancelled-run', { cachePolicy: { mode: 'bypass' } });
            await vi.waitFor(() => expect(delivered.size).toBe(6));
            expect(await stopExecutionRun({ runId: cancelled.runId!, runs, controllers, voiceAgentManager,
                getNowMs: Date.now, finishRun })).toEqual({ ok: true });
            expect(runs.get(cancelled.runId!)?.status).toBe('cancelled');
            const retainedCancellation = await generate('observe-cancellation');
            expect(retainedCancellation).toMatchObject({ resultId: cancelled.resultId, runId: cancelled.runId });
            expect(delivered.size).toBe(6);
            releaseModel();
            const cancellationRetry = await generate('explicit-cancellation-retry', { cachePolicy: { mode: 'bypass' } });
            expect(cancellationRetry.runId).not.toBe(cancelled.runId);
            await vi.waitFor(() => expect(delivered.size).toBe(7));
        } finally {
            releaseModel();
            await Promise.all([...controllers.values()].map(async controller => {
                if (controller.kind === 'backend') { await controller.provisioningPromise; await controller.backend.dispose(); }
            }));
            await voiceAgentManager.dispose();
        }
    });
});
