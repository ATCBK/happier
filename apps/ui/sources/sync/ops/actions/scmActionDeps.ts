import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ScmDiffSummaryResultClearInputSchema, ScmDiffSummaryResultClearResponseSchema, ScmDiffSummaryResultResponseSchema, type ScmDiffSummaryResultClearResponse } from '@happier-dev/protocol/scm/diffSummaryResult';
import { isScmCommitPlanApplicationLocked } from '@happier-dev/protocol/scm/diffSummaryCommitPlan';
import { ScmComparisonCaptureOutputSchema, ScmReviewedMarkInputSchema, buildScmReviewedMarksKey, createScmReviewedMarksRecordPort, buildScmComparisonSourceKey, buildScmReviewScopeId, buildReviewUnits, ScmStatusSnapshotResponseSchema, ScmDiffFileResponseSchema, type ScmReviewedMarksSource } from '@happier-dev/protocol/scm';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { runMachineScmRpcWithFallback } from '@/sync/ops/scm/machineScm';
import { runSessionScmRpc } from '@/sync/ops/sessionScm';
import type { LazyActionAccountContext } from './actionAccountContext';
import { createAccountKvJsonTransport } from '@/sync/ops/account/accountKvJsonTransport';
import { scmReviewComparisonMatchesSource } from '@/sync/domains/scm/diffSummary/selection';

/** Admission and schemas belong to Actions; repository policy belongs to SCM. */
export function createUiScmAction(
    account?: LazyActionAccountContext,
    options?: Readonly<{ onDispatched?: () => void }>,
): NonNullable<ActionExecutorDeps['scmActionExecute']> {
    return async ({ actionId, input, context }) => {
        context.signal?.throwIfAborted();
        account?.assertCurrent();
        const method = getActionSpec(actionId).bindings?.rpcMethod;
        if (!method) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };

        // The canonical Action owner has already parsed this family's request schema.
        const request = input as Readonly<{ cwd?: string; backendPreference?: unknown; destinationParentPath?: string }>;
        const serverId = account?.serverId ?? context.serverId;
        const accountId = account?.accountId ?? context.runtimeAccountId;
        const target = context.externalActionTarget;
        if (actionId === 'scm.diffSummary.reviewed.mark' || actionId === 'scm.diffSummary.reviewed.unmark') {
            if (!account) return { success: false, errorCode: 'reviewed_marks_unavailable', error: 'Captured Account credentials are required for personal reviewed marks.' };
            const selection = ScmReviewedMarkInputSchema.parse(input);
            const sessionId = target?.kind === 'session' ? target.sessionId : target?.kind === 'machine' ? undefined : context.defaultSessionId;
            if (!sessionId && target?.kind !== 'machine') return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
            if ('v' in selection && sessionId && selection.sessionId && selection.sessionId !== sessionId) {
                return { success: false, errorCode: 'reviewed_marks_unavailable', error: 'The captured comparison does not belong to the selected Session.' };
            }
            const read = <T extends Readonly<{ cwd: string }>>(readMethod: string, payload: T) => target?.kind === 'machine'
                ? runMachineScmRpcWithFallback(target.machineId, readMethod, payload, { serverId, accountId, signal: context.signal })
                : runSessionScmRpc(sessionId!, readMethod, { ...payload, cwd: undefined }, serverId, context.signal, accountId);
            const evidence = await (async () => {
                if ('changeKeys' in selection) {
                    if (selection.source.kind !== 'workingTree') return null;
                    const response = ScmStatusSnapshotResponseSchema.safeParse(await read(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: selection.cwd }));
                    account.assertCurrent();
                    if (!response.success || !response.data.success || response.data.snapshot?.repo.rootPath !== selection.cwd) return null;
                    const snapshot = response.data.snapshot;
                    const groups = await Promise.all(snapshot.entries.map(async entry => (await Promise.all(snapshot.capabilities.supportedDiffAreas.map(async area => {
                        const diff = ScmDiffFileResponseSchema.safeParse(await read(RPC_METHODS.SCM_DIFF_FILE, { cwd: selection.cwd, path: entry.path, area }));
                        account.assertCurrent();
                        if (!diff.success || !diff.data.success) throw new Error('Live change evidence is unavailable.');
                        const layer = area === 'both' ? 'combined' : area === 'included' ? 'staged' : entry.kind === 'untracked' ? 'untracked' : 'unstaged';
                        return buildReviewUnits(entry.path, layer, diff.data.diff ?? '').map(unit => unit.key);
                    }))).flat()));
                    return { repositoryRootPath: snapshot.repo.rootPath, source: selection.source, changeKeys: groups.flat() } satisfies ScmReviewedMarksSource;
                }
                if ('comparisonId' in selection) {
                    const captured = ScmComparisonCaptureOutputSchema.safeParse(await read(RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE, {
                        cwd: selection.cwd, comparisonId: selection.comparisonId, source: selection.source,
                        ...(sessionId ?? selection.sessionId ? { sessionId: sessionId ?? selection.sessionId } : {}),
                    }));
                    account.assertCurrent();
                    if (!captured.success || !captured.data.success || captured.data.comparison.id !== selection.comparisonId
                        || captured.data.comparison.repository.rootPath !== selection.cwd) return null;
                    const evidence = captured.data;
                    const retainedSelectors = { cwd: selection.cwd, turnId: evidence.metadata.turnId,
                        checkpointReceiptId: evidence.metadata.checkpointReceiptId, turnEvidenceMode: evidence.metadata.turnEvidenceMode };
                    const sourceMatches = selection.source.kind === 'turnCheckpoint'
                        ? buildScmComparisonSourceKey({ ...retainedSelectors, source: selection.source })
                            === buildScmComparisonSourceKey({ ...retainedSelectors, source: evidence.comparison.source })
                        : scmReviewComparisonMatchesSource(selection.source, evidence.comparison.source, evidence.comparison);
                    if (!sourceMatches) return null;
                    return captured.data.comparison;
                }
                const saved = ScmDiffSummaryResultResponseSchema.safeParse(await read(RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ,
                    { cwd: selection.cwd, resultId: selection.resultId }));
                account.assertCurrent();
                return saved.success && saved.data.success && saved.data.result.resultId === selection.resultId
                    && saved.data.result.output.comparison?.repository.rootPath === selection.cwd ? saved.data.result.output.comparison : null;
            })();
            if (!evidence) return { success: false, errorCode: 'reviewed_marks_unavailable', error: 'The selected change evidence is unavailable for this caller.' };
            const { encryption } = await account.resolveAccountEncryption();
            account.assertCurrent();
            const shouldContinue = () => { try { account.assertCurrent(); context.signal?.throwIfAborted(); return true; } catch { return false; } };
            const scope = 'id' in evidence ? { repositoryRootPath: evidence.repository.rootPath, source: evidence.source } : evidence;
            const transport = createAccountKvJsonTransport({ key: buildScmReviewedMarksKey(buildScmReviewScopeId(scope)), credentials: account.credentials,
                request: account.request, encryption, shouldContinue });
            const port = createScmReviewedMarksRecordPort('id' in evidence ? { comparison: evidence, transport } : { source: evidence, transport });
            const result = await ('changeKeys' in selection ? port.setReviewedKeys(selection.changeKeys, actionId === 'scm.diffSummary.reviewed.mark')
                : port.setReviewed(selection.changeRefs, actionId === 'scm.diffSummary.reviewed.mark'));
            account.assertResultCurrent(getActionSpec(actionId).sideEffectClass);
            return result;
        }
        const machineInventory = actionId === 'scm.diffSummary.result.list' || actionId === 'scm.diffSummary.result.clear'
            || actionId === 'scm.hostingRepository.resolveAddress';
        if (machineInventory && target?.kind !== 'machine') return { ok: false, errorCode: 'machine_not_selected', error: 'machine_not_selected' };
        if (target?.kind === 'machine') {
            const cwd = actionId === 'scm.repository.clone' ? request.destinationParentPath : request.cwd;
            if (!target.machineId.trim() || (!machineInventory && !cwd?.trim())) return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
            if (actionId === 'scm.diffSummary.result.clear') {
                const selection = ScmDiffSummaryResultClearInputSchema.parse(input);
                const deleted: Extract<ScmDiffSummaryResultClearResponse, { success: true }>['deleted'] = [];
                const failures: Extract<ScmDiffSummaryResultClearResponse, { success: true }>['failures'] = [];
                const current = () => { context.signal?.throwIfAborted(); account?.assertCurrent(); };
                for (const item of selection.results) {
                    try {
                        current();
                        const observed = ScmDiffSummaryResultResponseSchema.safeParse(await runMachineScmRpcWithFallback(target.machineId,
                            RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ, { cwd: item.cwd, resultId: item.resultId }, { serverId, accountId, signal: context.signal }));
                        current();
                        if (!observed.success) throw new Error('The current saved result could not be validated.');
                        if (!observed.data.success) { failures.push({ ...observed.data, resultId: item.resultId }); continue; }
                        const saved = observed.data.result;
                        if (saved.resultId !== item.resultId || saved.output.comparison?.id !== item.comparisonId) {
                            failures.push({ resultId: item.resultId, success: false, errorCode: 'invalid_edit', error: 'The listed comparison does not identify this saved result.' }); continue;
                        }
                        if (saved.revision !== item.expectedRevision) {
                            failures.push({ resultId: item.resultId, success: false, errorCode: 'revision_conflict', error: 'The saved result changed before Clear.', latestRevision: saved.revision }); continue;
                        }
                        if (isScmCommitPlanApplicationLocked(saved.application)) {
                            failures.push({ resultId: item.resultId, success: false, errorCode: 'application_locked', error: 'Resolve the accepted commit application before clearing its result.' }); continue;
                        }
                        // A concurrent edit/application may still win: the machine's existing
                        // locked revision/application check remains the deletion authority.
                        const cleared = ScmDiffSummaryResultClearResponseSchema.safeParse(await runMachineScmRpcWithFallback(target.machineId,
                            method, { results: [item] }, { serverId, accountId, signal: context.signal }));
                        account?.assertResultCurrent(getActionSpec(actionId).sideEffectClass);
                        if (!cleared.success) throw new Error('The saved-result Clear response could not be validated.');
                        if (!cleared.data.success) failures.push({ ...cleared.data, resultId: item.resultId });
                        else {
                            failures.push(...cleared.data.failures);
                            deleted.push(...cleared.data.deleted);
                        }
                    } catch (error) {
                        failures.push({ resultId: item.resultId, success: false, errorCode: 'result_unavailable',
                            error: error instanceof Error ? error.message : 'The saved result is unavailable.' });
                    }
                }
                return { success: true, deleted, failures };
            }
            options?.onDispatched?.();
            const result = await runMachineScmRpcWithFallback(target.machineId, method, request, {
                serverId, accountId, signal: context.signal,
            });
            account?.assertResultCurrent(getActionSpec(actionId).sideEffectClass);
            return result;
        }
        const sessionId = target?.kind === 'session' ? target.sessionId : context.defaultSessionId;
        if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
        // Like the CLI Action adapter, Session Actions cannot substitute another
        // repository. The general SCM facade still owns caller-relative paths.
        const sessionRequest = actionId === 'scm.repository.clone' ? request : { ...request, cwd: undefined };
        options?.onDispatched?.();
        const result = await runSessionScmRpc(sessionId, method, sessionRequest, serverId, context.signal, accountId,
            actionId === 'scm.pullRequest.prepareWorktree' ? (resolved) => ({ ...resolved, sourcePath: resolved.cwd }) : undefined);
        account?.assertResultCurrent(getActionSpec(actionId).sideEffectClass);
        return result;
    };
}
