import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { readExecutionRunStartRunCreation } from '@happier-dev/protocol/execution/runs/responseSchemas';

import { configuration, reloadConfiguration } from '@/configuration';
import { createRunnerAgentSessionBootstrapAuthorization } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { createRunnerAgentSessionRuntimeBootstrap } from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import { readRunnerAgentSessionBootstrap } from '@/agent/runtime/session/process/runnerAgentSessionBootstrap';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { ScmDiffSummaryProfile } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/ScmDiffSummaryProfile';
import type { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { registerExecutionRunRpcHandlers } from './registerExecutionRunRpcHandlers';

const roots: string[] = [];
afterEach(async () => {
    vi.unstubAllEnvs();
    reloadConfiguration();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// Characterization for r12-snapshot: the real daemon bootstrap publishes an
// Agent declaration, not an in-process daemon registry. Do not adopt a fixture
// daemon into this singleton: doing so masks the child-process failure.
it('characterizes the missing Session runner snapshot through real bootstrap and Run registration', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-runner-run-snapshot-'));
    roots.push(happyHomeDir);
    vi.stubEnv('HAPPIER_HOME_DIR', happyHomeDir);
    reloadConfiguration();
    expect(configuration.happyHomeDir).toBe(happyHomeDir);
    expect(pluginReloadController.getState().activeRegistry).toBeNull();
    const descriptor = {
        v: 1 as const,
        pluginId: 'acme.snapshot', pluginVersion: '1.0.0',
        agentId: 'acme.snapshot/agent', backendId: 'acme.snapshot/agent',
        occurrenceId: 'snapshot-occurrence',
        sourceCustody: { kind: 'managed' as const, immutableGenerationId: 'snapshot-generation', installSource: 'localPath' as const },
        agentDeclaration: {
            provenance: 'external' as const, source: { kind: 'path' as const },
            definition: PluginAgentContributionV2Schema.parse({
                id: 'agent', title: { key: 'agent.title', fallback: 'Snapshot Agent' },
                runtime: { kind: 'custom' }, primary: 'sessions',
                capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
            }),
        },
    };
    const issued = await createRunnerAgentSessionBootstrapAuthorization({ happyHomeDir, publicReleaseRing: 'stable', descriptor });
    try {
        // Parse bytes from the actual producer with the exact runner reader.
        expect((await readRunnerAgentSessionBootstrap(issued.authorization.bootstrapFilePath)).descriptor).toEqual(descriptor);
        const source = await createRunnerAgentSessionRuntimeBootstrap({
            happyHomeDir, publicReleaseRing: 'stable',
            authorityFilePath: issued.authorization.authorityFilePath,
            bootstrapFilePath: issued.authorization.bootstrapFilePath,
        });
        expect(source?.agentContribution.identity).toEqual({ pluginId: 'acme.snapshot', localId: 'agent' });
        expect(pluginReloadController.getState().activeRegistry).toBeNull();
        expect(buildExecutionRunProfileCatalog().builtInProfilesByIntent.get('scm_diff_summary')).toBe(ScmDiffSummaryProfile);

        const composition: { manager?: ExecutionRunHostBridge } = {};
        const registeredMethods = new Set<string>();
        registerExecutionRunRpcHandlers({ registerHandler(method) { registeredMethods.add(method); } }, {
            sessionId: 'snapshot-session', cwd: happyHomeDir, parentProvider: descriptor.agentId,
            sendAcp: async () => undefined,
            onManagerCreated: manager => { composition.manager = manager; },
        });
        expect(registeredMethods.size).toBeGreaterThan(0);
        if (!composition.manager) throw new Error('Run registration did not compose its manager');
        let refusal: unknown;
        try {
            await composition.manager.start({
                sessionId: 'snapshot-session', intent: 'scm_diff_summary',
                backendTarget: { kind: 'backend', backendId: descriptor.backendId },
                instructions: 'Explain the captured comparison.', permissionMode: 'read_only',
                retentionPolicy: 'session_owned', runClass: 'long_lived', ioMode: 'streaming',
            });
        } catch (error) { refusal = error; }
        expect(refusal).toMatchObject({
            code: 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE',
            rpcErrorCode: 'execution_run_contribution_snapshot_unavailable',
        });
        if (!refusal || typeof refusal !== 'object' || !('details' in refusal)) throw new Error('Missing typed Run refusal');
        expect(readExecutionRunStartRunCreation(refusal.details)).toBe('noRunCreated');
        expect(composition.manager.listPublic()).toEqual([]);
        await composition.manager.dispose();
    } finally { await issued.cleanupBootstrapFile(); }
});
