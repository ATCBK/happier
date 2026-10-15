import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ExecutionRunStartRequestSchema, ExecutionRunScmDiffSummaryInputV1Schema, accountSettingsParse, buildBackendTargetKeyV2, type ScmComparisonSource } from '@happier-dev/protocol';
import { getAgentStaticModels } from '@happier-dev/agents';

import { createLocalScmRepositoryFixture } from '@/scm/contracts/scmBackendContractFixtures';
import { gitCheckpointAdapter, resolveGitCheckpointBackendContext } from '@/scm/checkpoints/gitCheckpointAdapter';
import { buildRepositoryCheckpointRefs } from '@/scm/checkpoints/refs';
import { retainRepositoryCheckpointTurnEvidence } from '@/scm/checkpoints/sessionEvidence';
import { executeScmDiffSummaryAction } from './executeScmDiffSummaryAction';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { captureScmComparison } from '@/scm/comparisons/captureScmComparison';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { withExecutionRunStartFailureDetails } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { createTempDirSync } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';

const BACKEND_TARGET = { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const };

describe('executeScmDiffSummaryAction', () => {
    const directories: string[] = [];
    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
    });
    async function changedRepository() {
        // Native CLI execution/auth are the boundary; automatic model resolution stays real.
        const home = createTempDirSync('summary-action-native-auth-');
        directories.push(home);
        const fileName = process.platform === 'win32' ? 'claude.cmd' : 'claude';
        writeExecutableShimSync({ dir: home, fileName, contents: process.platform === 'win32'
            ? '@echo off\r\nif defined ANTHROPIC_API_KEY (echo {"loggedIn":true}& exit /b 0)\r\necho {"loggedIn":false}\r\nexit /b 1\r\n'
            : '#!/bin/sh\nif [ -n "$ANTHROPIC_API_KEY" ]; then printf \'{"loggedIn":true}\'; exit 0; fi\nprintf \'{"loggedIn":false}\'\nexit 1\n' });
        for (const key of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR']) vi.stubEnv(key, home);
        vi.stubEnv('HAPPIER_CLAUDE_PATH', join(home, fileName));
        vi.stubEnv('PATH', `${home}${delimiter}${process.env.PATH ?? ''}`);
        vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-api-key');
        const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-summary-action-' });
        directories.push(fixture.rootPath);
        await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Changed before admission\n');
        return fixture;
    }

    it.each([
        { sessionId: undefined, comparisonId: undefined },
        { sessionId: 'summary-session', comparisonId: undefined },
        { sessionId: undefined, comparisonId: 'missing-disabled-comparison' },
        { sessionId: 'summary-session', comparisonId: 'missing-disabled-comparison' },
    ])('refuses Explain-off before capture/read, saved output or Run admission in scope $sessionId, comparison $comparisonId', async ({ sessionId, comparisonId }) => {
        const previous = getActiveAccountSettingsSnapshot();
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({ 'scm.diffSummary.enabled': false }),
            settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'disabled-account' });
        try {
            const executeCanonicalAction = vi.fn(async () => { throw new Error('Disabled generation must not admit a Run'); });
            const output = await executeScmDiffSummaryAction({ request: { cwd: '/missing-disabled-summary-repository',
                source: { kind: 'workingTree' }, ...(comparisonId ? { comparisonId } : {}),
                outputs: ['walkthrough', 'commitPlan'], cachePolicy: { mode: 'bypass' } },
                ...(sessionId ? { sessionId } : {}), machineId: 'machine', backendTarget: BACKEND_TARGET, executeCanonicalAction });
            expect(output).toEqual({ success: false, errorCode: 'SCM_DIFF_SUMMARY_DISABLED', error: expect.any(String) });
            expect(executeCanonicalAction).not.toHaveBeenCalled();
        } finally {
            if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
        }
    });

    it('uses the shared Account prose preference for headless admission while preserving explicit language selection', async () => {
        const previous = getActiveAccountSettingsSnapshot();
        const fixture = await changedRepository();
        const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } });
        const languages: (string | undefined)[] = [];
        const executeCanonicalAction = async (_actionId: string, input: unknown) => {
            const start = ExecutionRunStartRequestSchema.parse(input);
            languages.push(ExecutionRunScmDiffSummaryInputV1Schema.parse(start.intentInput).outputLanguage);
            return { ok: true as const, result: { runId: `language-run-${languages.length}`, callId: 'call', sidechainId: 'sidechain' } };
        };
        const request = { cwd: fixture.rootPath, source: { kind: 'workingTree' as const }, comparisonId: captured.comparison.id,
            modelSelector: { modelId: 'explicit-model' } };
        let settingsVersion = 0;
        const selectLanguage = (language: string) => setActiveAccountSettingsSnapshot({ source: 'network',
            settings: accountSettingsParse({ 'scm.diffSummary.outputLanguage': language, preferredLanguage: 'nl' }),
            settingsVersion: ++settingsVersion, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'language-account' });
        try {
            selectLanguage('fr');
            const french = await executeScmDiffSummaryAction({ request, machineId: 'machine', backendTarget: BACKEND_TARGET, executeCanonicalAction });
            expect(languages).toEqual(['fr']);
            selectLanguage('de');
            const german = await executeScmDiffSummaryAction({ request, machineId: 'machine', backendTarget: BACKEND_TARGET, executeCanonicalAction });
            expect(german.resultId).not.toBe(french.resultId);
            await executeScmDiffSummaryAction({ request: { ...request, outputLanguage: 'it' }, machineId: 'machine', backendTarget: BACKEND_TARGET, executeCanonicalAction });
            expect(languages).toEqual(['fr', 'de', 'it']);
        } finally {
            if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
        }
    });

    it('preserves typed unavailable investigation admission and captured inventory when no Run was created', async () => {
        const fixture = await changedRepository();
        const output = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath,
            source: { kind: 'workingTree' }, modelSelector: { modelId: 'explicit' }, investigateSurroundingFiles: true },
            machineId: 'machine', backendTarget: BACKEND_TARGET,
            executeCanonicalAction: async () => ({ ok: false, errorCode: 'DIFF_UNAVAILABLE', error: 'Captured endpoint objects unavailable',
                details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } }),
        });
        expect(output).toMatchObject({ success: false, errorCode: 'DIFF_UNAVAILABLE', resultId: expect.any(String),
            comparison: { inventory: { state: 'complete', files: [expect.objectContaining({ path: fixture.trackedPath })] } },
            outputs: { summary: { state: 'failed' } } });
    });

    it('generates a workspace-native saved result through the existing detached Run without a Session', async () => {
        const fixture = await changedRepository();
        const executeCanonicalAction = vi.fn(async (_actionId: string, _input: unknown) => ({ ok: true as const,
            result: { runId: 'detached-summary', callId: 'call', sidechainId: 'sidechain' } }));
        const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } });
        const generated = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath,
            source: { kind: 'workingTree' }, comparisonId: captured.comparison.id, outputs: ['walkthrough'] },
            machineId: 'machine', backendTarget: BACKEND_TARGET, executeCanonicalAction });
        expect(generated).toMatchObject({ success: true, runId: 'detached-summary', inputId: expect.any(String),
            comparison: captured.comparison, outputs: { walkthrough: { state: 'pending' } } });
        expect(executeCanonicalAction).toHaveBeenCalledWith('execution.run.start', expect.objectContaining({
            sessionId: null, machineId: 'machine', cwd: fixture.rootPath,
            localInputId: generated.success ? generated.inputId : undefined,
            intentInput: expect.objectContaining({ resultId: generated.resultId, comparisonId: captured.comparison.id }),
        }));
        const admitted = ExecutionRunStartRequestSchema.parse(executeCanonicalAction.mock.calls[0]?.[1]);
        expect(admitted.modelId).toEqual(expect.any(String));
        expect(admitted.modelId).not.toBe('default');
        expect(getAgentStaticModels(admitted.backendTarget?.backendId ?? '', { catalogOnly: true })
            .find(model => model.id === admitted.modelId)?.costTier).toBe('low');
        expect(await scmDiffSummaryResultStore.readStoredScope({ cwd: fixture.rootPath, resultId: generated.resultId! }))
            .toEqual({ cwd: fixture.rootPath });
        expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, resultId: generated.resultId! }))
            .toMatchObject({ success: true, result: { output: { inputId: generated.success ? generated.inputId : undefined } } });
    });

    it('sends the configured automatic model as fallback input so attached admission can inherit the applied parent', async () => {
        const fixture = await changedRepository();
        let admitted: ReturnType<typeof ExecutionRunStartRequestSchema.parse> | undefined;
        const generated = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath,
            source: { kind: 'workingTree' }, outputs: ['commitPlan'] }, sessionId: 'attached-summary',
            backendTarget: BACKEND_TARGET, executeCanonicalAction: async (_actionId, input) => {
                admitted = ExecutionRunStartRequestSchema.parse(input);
                return { ok: true, result: { runId: 'attached-summary-run', callId: 'call', sidechainId: 'sidechain' } };
            },
        });
        expect(generated).toMatchObject({ success: true, runId: 'attached-summary-run' });
        expect(admitted?.modelId).toBeUndefined();
        expect(admitted?.backendTarget).toEqual(BACKEND_TARGET);
        const fallback = ExecutionRunScmDiffSummaryInputV1Schema.parse(admitted?.intentInput).modelSelector;
        expect(fallback?.modelId).toEqual(expect.any(String));
    });

    it('delegates to the applied parent when its Agent has no inexpensive summary default', async () => {
        const fixture = await changedRepository();
        let admitted: ReturnType<typeof ExecutionRunStartRequestSchema.parse> | undefined;
        const generated = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath,
            source: { kind: 'workingTree' }, outputs: ['commitPlan'],
            modelSelector: { backendTargetKey: buildBackendTargetKeyV2(BACKEND_TARGET) } }, sessionId: 'parent-without-cost-tag',
            backendTarget: BACKEND_TARGET, executeCanonicalAction: async (_actionId, input) => {
                admitted = ExecutionRunStartRequestSchema.parse(input);
                return { ok: true, result: { runId: 'inherited-parent-run', callId: 'call', sidechainId: 'sidechain' } };
            },
        });
        expect(generated).toMatchObject({ success: true, runId: 'inherited-parent-run' });
        expect(admitted?.modelId).toBeUndefined();
        expect(admitted?.backendTarget).toEqual(BACKEND_TARGET);
    });

    it.each(['noRunCreated', 'outcomeUnknown'] as const)('uses a different configured default Agent only after %s admission evidence', async runCreation => {
        const fixture = await changedRepository();
        const inputs: ReturnType<typeof ExecutionRunStartRequestSchema.parse>[] = [];
        const generated = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath,
            source: { kind: 'workingTree' }, outputs: ['commitPlan'] }, sessionId: 'summary-default-admission',
            backendTarget: BACKEND_TARGET, executeCanonicalAction: async (_actionId, input) => {
                inputs.push(ExecutionRunStartRequestSchema.parse(input));
                return inputs.length === 1 ? { ok: false, errorCode: 'execution_run_parent_selection_unavailable',
                    error: 'Parent unavailable', details: withExecutionRunStartFailureDetails(undefined, runCreation) }
                    : { ok: true, result: { runId: 'configured-default-run', callId: 'call', sidechainId: 'sidechain' } };
            },
        });
        if (runCreation === 'outcomeUnknown') {
            expect(inputs).toHaveLength(1);
            expect(generated).toMatchObject({ outputs: { commitPlan: { state: 'failed' } } });
            expect(generated.runId).toBeUndefined();
        } else {
            expect(generated).toMatchObject({ success: true, runId: 'configured-default-run' });
            expect(inputs).toHaveLength(2);
            expect(inputs[0]?.backendTarget).toEqual(BACKEND_TARGET);
            const selector = ExecutionRunScmDiffSummaryInputV1Schema.parse(inputs[0]?.intentInput).modelSelector;
            expect(buildBackendTargetKeyV2(inputs[1]!.backendTarget!)).toBe(selector?.backendTargetKey);
            expect(inputs[1]?.modelSelection).toMatchObject({ modelId: selector?.modelId, providerConnectionId: null });
            expect(inputs[1]?.localInputId).toBe(inputs[0]?.localInputId);
        }
    });

    it.each(['branch', 'commit', 'pullRequest'] as const)('generates the first walkthrough from retained %s endpoints after the source moves', async (kind) => {
        const fixture = await changedRepository();
        const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture.rootPath, encoding: 'utf8' }).trim();
        const head = git('rev-parse', 'HEAD');
        const source: ScmComparisonSource = kind === 'branch' ? { kind, head: 'HEAD', base: head }
            : kind === 'commit' ? { kind, commit: 'HEAD' }
                : { kind, locator: { providerId: 'github', repository: 'owner/repo', number: 42,
                    baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40),
                    sourceAction: { action: { pluginId: 'happier.scm.forge.github', localId: 'triage/list-github-changed-files' } } } };
        const readPullRequestComparisonPage = vi.fn(async () => ({ kind: 'changedFiles', rows: [], omittedRowCount: 0, projectionTruncated: false,
            comparison: { locator: { providerId: 'github', repository: 'owner/repo', number: 42 }, beforeOid: 'c'.repeat(40), baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40),
                totalFileCount: 0, enumeratedFileCount: 0, freshness: 'current', inventory: 'complete', content: 'complete', reasons: [] } }));
        const captured = await captureScmComparison({ cwd: fixture.rootPath, source, sessionId: 'pinned-first', readPullRequestComparisonPage });
        if (kind === 'pullRequest') expect(captured.comparison).toMatchObject({
            endpoints: { before: 'c'.repeat(40), after: 'b'.repeat(40) }, pullRequest: { baseOid: 'a'.repeat(40) },
        });
        await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Moved source\n');
        git('add', fixture.trackedPath);
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Move source');
        readPullRequestComparisonPage.mockRejectedValue(new Error('The source must not be fetched after Files captured it'));
        const executeCanonicalAction = vi.fn(async () => ({ ok: true as const, result: { runId: 'first-walkthrough', callId: 'call', sidechainId: 'sidechain' } }));
        const output = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath, source, comparisonId: captured.comparison.id, outputs: ['walkthrough'] },
            sessionId: 'pinned-first', backendTarget: BACKEND_TARGET, readPullRequestComparisonPage, executeCanonicalAction });
        expect(output).toMatchObject({ success: true, comparison: captured.comparison, outputs: { walkthrough: { state: 'pending' } } });
        expect(executeCanonicalAction).toHaveBeenCalledWith('execution.run.start', expect.objectContaining({
            intentInput: expect.objectContaining({ comparisonId: captured.comparison.id }) }));
        expect(readPullRequestComparisonPage).toHaveBeenCalledTimes(kind === 'pullRequest' ? 1 : 0);
    });

    it('returns captured inventory and a retained run before terminal prose is available', async () => {
        const fixture = await changedRepository();
        // Dispatch crosses the runtime admission boundary; capture and schemas stay real.
        const executeCanonicalAction = vi.fn(async (actionId: string, _input: unknown) => {
            if (actionId !== 'execution.run.start') throw new Error(`Unexpected terminal observation: ${actionId}`);
            const request = _input as { intentInput: { resultId: string; expectedRevision: number } };
            expect(request.intentInput.resultId).toEqual(expect.any(String));
            expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, sessionId: 'session-1', resultId: request.intentInput.resultId }))
                .toMatchObject({ success: true, result: { revision: request.intentInput.expectedRevision,
                    output: { outputs: { summary: { state: 'pending' }, walkthrough: { state: 'pending' } } } } });
            return { ok: true as const, result: { runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1' } };
        });
        const output = await executeScmDiffSummaryAction({
            request: { cwd: fixture.rootPath, source: { kind: 'workingTree' }, outputs: ['summary', 'walkthrough'] },
            sessionId: 'session-1', backendTarget: BACKEND_TARGET, executeCanonicalAction,
        });
        expect(output).toMatchObject({
            success: true, runId: 'run-1',
            resultId: expect.any(String), revision: expect.any(Number),
            comparison: { inventory: { state: 'complete', files: [expect.objectContaining({ path: fixture.trackedPath })] } },
            requestedOutputs: ['summary', 'walkthrough'],
            outputs: { summary: { state: 'pending' }, walkthrough: { state: 'pending' } },
        });
        expect(output).not.toHaveProperty('summaryMarkdown');
        expect(executeCanonicalAction).toHaveBeenCalledWith('execution.run.start', expect.objectContaining({
            kind: 'scm_diff_summary.v1', intent: 'scm_diff_summary', permissionMode: 'read_only',
            retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', waitForCompletion: false,
            intentInput: expect.objectContaining({ comparisonId: expect.any(String) }),
        }));
        expect(executeCanonicalAction.mock.calls[0]?.[1]).not.toHaveProperty('intentInput.comparison');
    });

    it('preserves complete inventory when no model target is available', async () => {
        const fixture = await changedRepository();
        const executeCanonicalAction = vi.fn();
        await expect(executeScmDiffSummaryAction({
            request: { cwd: fixture.rootPath, source: { kind: 'workingTree' }, modelSelector: { modelId: 'explicit' } },
            sessionId: 'session-1', backendTarget: null, executeCanonicalAction,
        })).resolves.toMatchObject({
            success: true,
            comparison: { inventory: { state: 'complete', files: [expect.objectContaining({ path: fixture.trackedPath })] } },
            outputs: { summary: { state: 'failed', reason: expect.any(String) } },
        });
        expect(executeCanonicalAction).not.toHaveBeenCalled();
    });

    it('refuses detached generation without an admitted low-cost model while retaining its captured inventory', async () => {
        const fixture = await changedRepository();
        for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) vi.stubEnv(key, undefined);
        const executeCanonicalAction = vi.fn();
        const output = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath, source: { kind: 'workingTree' },
            modelSelector: { backendTargetKey: 'agent:happier.agent.claude/claude' } },
            machineId: 'machine-low-tier-unavailable', backendTarget: BACKEND_TARGET, executeCanonicalAction });
        expect(output).toMatchObject({ success: false, errorCode: 'MODEL_UNAVAILABLE',
            comparison: { inventory: { files: [expect.objectContaining({ path: fixture.trackedPath })] } } });
        expect(executeCanonicalAction).not.toHaveBeenCalled();
    });

    it('reports an unavailable automatic model when attached admission proves no applied parent or executable fallback', async () => {
        const fixture = await changedRepository();
        for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) vi.stubEnv(key, undefined);
        const executeCanonicalAction = vi.fn(async () => ({ ok: false as const,
            errorCode: 'execution_run_parent_selection_unavailable', error: 'Parent unavailable',
            details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') }));
        const output = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath, source: { kind: 'workingTree' },
            modelSelector: { backendTargetKey: 'agent:happier.agent.claude/claude' } },
            sessionId: 'parent-unavailable', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            executeCanonicalAction });
        expect(output).toMatchObject({ success: false, errorCode: 'MODEL_UNAVAILABLE', resultId: expect.any(String),
            comparison: { inventory: { files: [expect.objectContaining({ path: fixture.trackedPath })] } },
            outputs: { summary: { state: 'failed' } } });
        expect(executeCanonicalAction).toHaveBeenCalledTimes(1);
        expect(output.runId).toBeUndefined();
    });

    it('resolves canonical checkpoint receipts and keeps later pending changes out of turn evidence', async () => {
        const fixture = await changedRepository();
        const sessionId = 'checkpoint-action-session';
        const turnId = 'turn-1';
        const scopeId = `${sessionId}:${fixture.rootPath}`;
        const refs = buildRepositoryCheckpointRefs({ scopeId, turnId });
        const context = await resolveGitCheckpointBackendContext({ cwd: fixture.rootPath });
        if (!context || !refs.turnStart || !refs.turnFinal) throw new Error('Fixture checkpoint context is unavailable');
        const start = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnStart });
        await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Canonical turn output\n');
        const final = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnFinal });
        if (!start.success || !final.success) throw new Error('Fixture checkpoint capture failed');
        await retainRepositoryCheckpointTurnEvidence({ cwd: fixture.rootPath, scopeId, turnChangeSet: {
            sessionId, turnId, provider: 'codex', derivedAt: 1, status: 'completed', files: [],
            seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
            repositoryCheckpoint: { version: 1, scopeId, startRef: refs.turnStart.ref, finalRef: refs.turnFinal.ref,
                baseRefSource: 'turn_start', contentConfidence: 'exact', attributionScope: 'shared_worktree',
                receipts: [...start.receipts, ...final.receipts],
            },
        } });
        await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Later pending changes\n');
        const output = await executeScmDiffSummaryAction({
            request: { cwd: fixture.rootPath, source: { kind: 'turnCheckpoint' }, turnId, checkpointReceiptId: 'checkpoint.finalized' },
            sessionId, backendTarget: BACKEND_TARGET,
            executeCanonicalAction: async () => ({ ok: true, result: { runId: 'checkpoint-run', callId: 'call', sidechainId: 'sidechain' } }),
        });
        expect(output).toMatchObject({ success: true, runId: 'checkpoint-run', comparison: {
            inventory: { state: 'complete', files: [expect.objectContaining({ evidence: {
                state: 'available', unifiedDiff: expect.stringContaining('+Canonical turn output'),
            } })] },
        } });
        expect(JSON.stringify(output)).not.toContain('+Later pending changes');
    });

    it('preserves captured evidence and unknown admission without retrying', async () => {
        const fixture = await changedRepository();
        const executeCanonicalAction = vi.fn(async () => ({
            ok: false as const, errorCode: 'execution_run_target_unavailable', error: 'target unavailable',
            details: { executionRunStart: { v: 1 as const, runCreation: 'outcomeUnknown' as const } },
        }));
        const output = await executeScmDiffSummaryAction({
            request: { cwd: fixture.rootPath, source: { kind: 'workingTree' } },
            sessionId: 'session-1', backendTarget: BACKEND_TARGET, executeCanonicalAction,
        });
        expect(output).toMatchObject({ success: true, comparison: { inventory: { state: 'complete' } },
            outputs: { summary: { state: 'failed', reason: 'Diff-summary execution run start outcome is unknown' } } });
        expect(executeCanonicalAction).toHaveBeenCalledTimes(1);
    });

    it('preserves captured inventory when admission throws without a creation receipt', async () => {
        const fixture = await changedRepository();
        await expect(executeScmDiffSummaryAction({
            request: { cwd: fixture.rootPath, source: { kind: 'workingTree' } },
            sessionId: 'session-1', backendTarget: BACKEND_TARGET,
            executeCanonicalAction: async () => { throw new Error('Admission transport disconnected'); },
        })).resolves.toMatchObject({ success: true, comparison: { inventory: { state: 'complete' } },
            outputs: { summary: { state: 'failed', reason: 'Diff-summary execution run start outcome is unknown' } },
        });
    });
});
