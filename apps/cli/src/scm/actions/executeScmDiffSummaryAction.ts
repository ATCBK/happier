import { EXECUTION_RUN_KIND_BY_INTENT } from '@happier-dev/protocol/execution/runs/startRequest';
import { ExecutionRunStartResponseSchema, readExecutionRunStartRunCreation } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { randomUUID } from 'node:crypto';
import { ScmDiffSummaryGenerateOutputSchema, buildScmDiffSummaryCacheKey, SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION } from '@happier-dev/protocol/scm/diffSummary';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ActionExecuteResult, BackendTargetRefV2, ScmDiffSummaryGenerateInput, ScmDiffSummaryGenerateOutput, ScmDiffSummaryOutputKind, ScmDiffSummaryOutputs } from '@happier-dev/protocol';

import { captureScmComparison, readCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import type { ReadRepositoryCheckpointTranscriptPage } from '@/scm/checkpoints/readRepositoryCheckpointTranscriptPage';
import type { ReadPullRequestComparisonPage } from '@/scm/comparisons/readPullRequestComparisonPage';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { createCliSettingsCatalogServices } from '@/session/actions/settingsCatalogServices';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resolveScmDiffSummaryModelSelection, resolveScmDiffSummarySettings, SCM_DIFF_SUMMARY_SETTING_KEYS } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { ProviderDefaultModelSelectionsByAgentTargetKeyV1StoredSchema } from '@happier-dev/protocol/providers/selection/v1';
import type { StoredCredentials } from '@/persistence';

type ExecuteCanonicalAction = (
    actionId: 'execution.run.start',
    input: unknown,
) => Promise<ActionExecuteResult>;

/** Capture once at the host, then admit the canonical retained analysis run. */
export async function executeScmDiffSummaryAction(params: Readonly<{
    request: ScmDiffSummaryGenerateInput;
    sessionId?: string;
    machineId?: string;
    readTranscriptPage?: ReadRepositoryCheckpointTranscriptPage;
    readPullRequestComparisonPage?: ReadPullRequestComparisonPage;
    backendTarget: BackendTargetRefV2 | null;
    executeCanonicalAction: ExecuteCanonicalAction;
    signal?: AbortSignal;
    credentials?: StoredCredentials;
}>): Promise<ScmDiffSummaryGenerateOutput> {
    const settings = getActiveAccountSettingsSnapshot()?.settings ?? accountSettingsParse({});
    const resolvedSettings = resolveScmDiffSummarySettings({ storedSettings: settings, catalogProfiles: [] });
    if (!resolvedSettings.enabled) {
        return ScmDiffSummaryGenerateOutputSchema.parse({ success: false, errorCode: 'SCM_DIFF_SUMMARY_DISABLED',
            error: 'SCM diff summary generation is disabled' });
    }
    const sessionId = params.sessionId ?? params.request.sessionId;
    const captured = params.request.comparisonId ? await readCapturedScmComparison({
        cwd: params.request.cwd, comparisonId: params.request.comparisonId, source: params.request.source,
        ...(sessionId ? { sessionId } : {}),
        turnId: params.request.turnId, checkpointReceiptId: params.request.checkpointReceiptId,
        turnEvidenceMode: params.request.turnEvidenceMode,
    }) : await captureScmComparison({
        ...params.request,
        ...(sessionId ? { sessionId } : {}),
        ...(params.readTranscriptPage ? { readTranscriptPage: params.readTranscriptPage } : {}),
        ...(params.readPullRequestComparisonPage ? { readPullRequestComparisonPage: params.readPullRequestComparisonPage } : {}),
    });
    const requestedOutputs: readonly ScmDiffSummaryOutputKind[] = params.request.outputs ?? ['summary'];
    const outputLanguage = params.request.outputLanguage ?? resolvedSettings.outputLanguage;
    const investigateSurroundingFiles = params.request.investigateSurroundingFiles ?? resolvedSettings.investigateSurroundingFiles;
    let selector = params.request.modelSelector;
    let backendTarget = params.backendTarget;
    if (!selector?.modelId && !selector?.profileId) {
        const storedValue = selector?.backendTargetKey ? '' : settings[SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride];
        const catalog = await createCliSettingsCatalogServices({ signal: params.signal, credentials: params.credentials }).readScmDiffSummaryCatalog?.(settings, storedValue);
        const profiles = selector?.backendTargetKey
            ? catalog?.profiles.filter(profile => profile.modelSelector?.backendTargetKey === selector?.backendTargetKey)
            : catalog?.profiles;
        const selection = resolveScmDiffSummaryModelSelection({ storedValue, defaultBackendTarget: backendTarget,
            catalogProfiles: profiles ?? [] });
        const defaultAvailable = selection.success && catalog?.isCurrent(getActiveAccountSettingsSnapshot()?.settings ?? settings);
        if (!defaultAvailable && (!sessionId || !backendTarget)) {
            const outputs: ScmDiffSummaryOutputs = {};
            for (const kind of requestedOutputs) outputs[kind] = { state: 'failed', reason: 'Diff-summary model is unavailable' };
            return ScmDiffSummaryGenerateOutputSchema.parse({ success: false, errorCode: 'MODEL_UNAVAILABLE',
                nextAction: 'chooseModel',
                error: 'Diff-summary model is unavailable', sourceKey: captured.metadata.sourceKey,
                metadata: captured.metadata, comparison: captured.comparison, requestedOutputs, outputs,
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs:
                    captured.comparison.inventory.files.flatMap(file => file.occurrences.map(occurrence => occurrence.id)) } });
        }
        if (defaultAvailable && selection.success) {
            backendTarget = selection.backendTarget;
            selector = selection.modelSelector;
        }
    }
    const key = buildScmDiffSummaryCacheKey({ source: { kind: 'comparison', comparisonId: captured.comparison.id },
        summarySchemaVersion: SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION, outputs: requestedOutputs, scopeKey: sessionId,
        investigateSurroundingFiles,
        ...(outputLanguage ? { outputLanguage } : {}),
        resolvedSelector: { catalogId: JSON.stringify({ backendTargetKey: backendTarget ? buildBackendTargetKeyV2(backendTarget) : null,
            modelId: selector?.modelId ?? 'default', ...(selector?.profileId ? { profileId: selector.profileId } : {}) }) },
    });
    return scmDiffSummaryResultStore.admitGeneration({ cwd: params.request.cwd, ...(sessionId ? { sessionId } : {}), key, outputs: requestedOutputs,
        bypass: params.request.cachePolicy?.mode === 'bypass', ...(params.signal ? { signal: params.signal } : {}) }, async () => {
        const remainingChangeRefs = captured.comparison.inventory.files.flatMap(file => file.occurrences.map(occurrence => occurrence.id));
        const envelope = (state: 'pending' | 'failed', reason?: string, runId?: string): ScmDiffSummaryGenerateOutput => {
            const outputs: ScmDiffSummaryOutputs = {};
            for (const kind of requestedOutputs) outputs[kind] = { state, ...(reason ? { reason } : {}) };
            return ScmDiffSummaryGenerateOutputSchema.parse({
                success: true,
                sourceKey: captured.metadata.sourceKey,
                metadata: captured.metadata,
                comparison: captured.comparison,
                requestedOutputs,
                outputs,
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs },
                ...(captured.metadata.checkpointReceiptId ? { checkpointReceiptId: captured.metadata.checkpointReceiptId } : {}),
                ...(runId ? { runId } : {}),
            });
        };
        const saved = await scmDiffSummaryResultStore.create({ cwd: params.request.cwd,
            ...(sessionId ? { sessionId } : {}), output: envelope('pending'),
            ...(backendTarget ? { generator: { backendTarget,
                ...(investigateSurroundingFiles ? { investigateSurroundingFiles: true } : {}),
                ...(selector?.profileId ? { profileId: selector.profileId } : {}),
                ...(selector?.modelId ? { modelId: selector.modelId } : {}) } } : {}),
        });
        const scope = { cwd: params.request.cwd, resultId: saved.resultId, ...(sessionId ? { sessionId } : {}) };
        const latestOutput = async (runId?: string, inputId?: string): Promise<ScmDiffSummaryGenerateOutput> => {
            const latest = await scmDiffSummaryResultStore.read(scope);
            const output = latest.success ? latest.result.output : saved.output;
            return ScmDiffSummaryGenerateOutputSchema.parse({ ...output, ...(runId ? { runId } : {}),
                ...(output.success && inputId ? { inputId } : {}) });
        };
        const failed = async (reason: string, errorCode?: 'DIFF_UNAVAILABLE' | 'MODEL_UNAVAILABLE'): Promise<ScmDiffSummaryGenerateOutput> => {
            // A concurrent manual edit or started/terminal publication owns the newer revision.
            const output = errorCode ? ScmDiffSummaryGenerateOutputSchema.parse({ ...envelope('failed', reason),
                success: false, errorCode, error: reason, ...(errorCode === 'MODEL_UNAVAILABLE' ? { nextAction: 'chooseModel' } : {}) }) : envelope('failed', reason);
            await scmDiffSummaryResultStore.publishProgress({ ...scope, expectedRevision: saved.revision, output });
            return latestOutput();
        };
        if (!backendTarget) return failed('Diff-summary model target is unavailable');
        if (!sessionId && !params.machineId) return failed('Diff-summary generation requires an admitted execution target');
        const inputId = randomUUID();
        const startInput = {
            sessionId: sessionId ?? null,
            ...(!sessionId ? { machineId: params.machineId, cwd: params.request.cwd } : {}),
            kind: EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary,
            intent: 'scm_diff_summary',
            localInputId: inputId,
            backendTarget: sessionId && !params.request.modelSelector?.modelId && !params.request.modelSelector?.profileId
                ? params.backendTarget ?? backendTarget : backendTarget,
            permissionMode: 'read_only',
            retentionPolicy: 'resumable',
            runClass: 'long_lived',
            ioMode: 'streaming',
            ...(selector?.profileId ? { profileId: selector.profileId } : {}),
            // Automatic summary defaults are fallback input. A known attached
            // parent supplies its applied model at the runner admission owner.
            ...(selector?.modelId && (!sessionId || params.request.modelSelector?.modelId) ? { modelId: selector.modelId } : {}),
            // Only a host-owned saved evidence id crosses admission, never client diff bytes.
            intentInput: { ...params.request, investigateSurroundingFiles, ...(outputLanguage ? { outputLanguage } : {}), ...(selector ? { modelSelector: selector } : {}), ...(sessionId ? { sessionId } : {}), comparisonId: captured.comparison.id,
                resultId: saved.resultId, expectedRevision: saved.revision },
            waitForCompletion: false,
        };
        let startResult = await params.executeCanonicalAction('execution.run.start', startInput).catch(() => null);
        if (!startResult) return failed('Diff-summary execution run start outcome is unknown');
        if (!startResult.ok && startResult.errorCode === 'execution_run_parent_selection_unavailable'
            && readExecutionRunStartRunCreation(startResult.details) === 'noRunCreated'
            && !params.request.modelSelector?.modelId && !params.request.modelSelector?.profileId && selector?.modelId) {
            // A different default Agent must pass the canonical Action gate itself.
            // Only a proven empty admission permits this fallback; an unknown
            // outcome must never create another Run for the captured comparison.
            const defaults = ProviderDefaultModelSelectionsByAgentTargetKeyV1StoredSchema.safeParse(
                settings.providerDefaultModelSelectionsByAgentTargetKeyV1 ?? {},
            );
            if (!defaults.success) return failed('Diff-summary model is unavailable');
            const agentTargetKey = buildBackendTargetKeyV2(backendTarget);
            startResult = await params.executeCanonicalAction('execution.run.start', {
                ...startInput,
                backendTarget,
                modelId: selector.modelId,
                modelSelection: {
                    ...(defaults.data[agentTargetKey]?.ref ?? { agentTargetKey, providerConnectionId: null }),
                    modelId: selector.modelId,
                },
            }).catch(() => null);
            if (!startResult) return failed('Diff-summary execution run start outcome is unknown');
        }
        if (!startResult.ok) {
            const noRunCreated = readExecutionRunStartRunCreation(startResult.details) === 'noRunCreated';
            if (noRunCreated && startResult.errorCode === 'execution_run_parent_selection_unavailable'
                && !params.request.modelSelector?.modelId && !params.request.modelSelector?.profileId) {
                return failed('Diff-summary model is unavailable', 'MODEL_UNAVAILABLE');
            }
            // The typed refusal and its reason travel together; the code alone is not a reason.
            const refusal = startResult.error.includes(startResult.errorCode) ? startResult.error
                : `${startResult.errorCode}: ${startResult.error}`;
            return failed(noRunCreated ? refusal : 'Diff-summary execution run start outcome is unknown',
                noRunCreated && startResult.errorCode === 'DIFF_UNAVAILABLE' ? 'DIFF_UNAVAILABLE' : undefined);
        }
        const started = ExecutionRunStartResponseSchema.safeParse(startResult.result);
        return started.success
            ? latestOutput(started.data.runId, inputId)
            : failed('Diff-summary execution run did not return a run id');
    });
}
