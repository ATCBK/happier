import * as React from 'react';
import type { ScmDiffSummaryOutputKind, ScmDiffSummaryResult } from '@happier-dev/protocol/scm';

import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import type { ScmDiffSummaryEntry, ScmDiffSummaryViewModel } from '@/sync/domains/scm/diffSummary/state';
import { selectScmWalkthroughKey, scmReviewComparisonMatchesSource, scmDiffSummaryOutputNeedsPublishedFallback } from '@/sync/domains/scm/diffSummary/selection';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
    getScmDiffSummaryOperationState,
    getScmDiffSummaryState,
    subscribeScmDiffSummaryState,
    retireScmDiffSummaryScope,
    loadSavedScmDiffSummaryResult,
} from '@/sync/ops/scmDiffSummary/generate';
import { createScmDiffSummaryResultOperations } from '@/sync/ops/scmDiffSummary/results';
import { createScmDiffSummarySavedResultOperations } from '@/sync/ops/scmDiffSummary/savedResultOperations';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { subscribeExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { scmComparisonKey } from '@/components/sessions/files/comparison/filesComparison';

/**
 * The walkthrough analysis behind a comparison view: the existing diff-summary request state (its
 * captured comparison, per-output progress, analysis coverage and result identity), read through the
 * one store, including saved results published before this view opened. Null when no matching
 * walkthrough is available for the admitted host and comparison.
 */
export function useSessionScmWalkthrough(sessionId: string, comparison: SessionScmReviewComparison | null, output: ScmDiffSummaryOutputKind = 'walkthrough', serverId?: string | null): ScmDiffSummaryViewModel | null {
    return useScmWalkthrough({ sessionId }, comparison, output, serverId);
}

export function useScmWalkthrough(host: Readonly<{ sessionId: string }> | Readonly<{ machineId: string; cwd: string }>,
    comparison: SessionScmReviewComparison | null, output: ScmDiffSummaryOutputKind = 'walkthrough', serverId?: string | null): ScmDiffSummaryViewModel | null {
    const binding = useServerCredentialAccountScopeBinding(serverId).binding;
    const scopeKey = binding?.isCurrent() ? serverAccountScopeKeySuffix(binding.scope) : null;
    React.useEffect(() => {
        if (!binding) return;
        const retirement = binding.onRetire(() => retireScmDiffSummaryScope(binding.scope));
        return () => retirement.dispose();
    }, [binding]);
    const getSnapshot = React.useMemo(() => {
        let previousEntry: ScmDiffSummaryEntry | undefined;
        let projection: ScmDiffSummaryViewModel | null = null;
        return () => {
            if (!scopeKey || !binding?.isCurrent()) return null;
            const state = getScmDiffSummaryState();
            const key = selectScmWalkthroughKey(state, host, comparison, output, scopeKey);
            const entry = key ? state.entriesByKey[key] : undefined;
            if (entry === previousEntry) return projection;
            previousEntry = entry;
            projection = key ? getScmDiffSummaryOperationState(state, key) : null;
            return projection;
        };
    }, ['sessionId' in host ? host.sessionId : null, 'machineId' in host ? host.machineId : null,
        'cwd' in host ? host.cwd : null, comparison, output, scopeKey, binding]);
    const viewModel = React.useSyncExternalStore(subscribeScmDiffSummaryState, getSnapshot, getSnapshot);
    const sessionId = 'sessionId' in host ? host.sessionId : null;
    const sessionMachine = useSessionMachineTarget(sessionId, serverId);
    const machineId = 'machineId' in host ? host.machineId : sessionMachine?.machineId;
    const cwd = 'cwd' in host ? host.cwd : sessionMachine?.basePath;
    const presence = useMachinePresenceSummary(binding?.scope.serverId, machineId);
    const comparisonKey = comparison ? scmComparisonKey(comparison) : null;
    const needsPublishedFallback = Boolean(viewModel?.savedResult && scmDiffSummaryOutputNeedsPublishedFallback(viewModel.outputs?.[output]));
    // Files, Walkthrough and Commits read the same saved-result owner. A
    // published reading must not depend on visiting its generation controls.
    React.useEffect(() => {
        if (!binding?.isCurrent() || !machineId || !cwd || presence.reachability !== 'reachable' || !comparison || (viewModel && !needsPublishedFallback)) return;
        const scope = binding.scope;
        const abort = new AbortController();
        const current = () => binding.isCurrent() && !abort.signal.aborted;
        const operations = createScmDiffSummaryResultOperations({ ...host, serverId: scope.serverId,
            accountId: scope.accountId, signal: abort.signal, shouldContinue: current });
        const inventory = createScmDiffSummarySavedResultOperations({ machineId, serverId: scope.serverId,
            ...(sessionId ? { sessionId } : {}), accountId: scope.accountId,
            signal: abort.signal, shouldContinue: current });
        let pending = false;
        let invalidated = false;
        const restore = async () => {
            if (!current()) return;
            if (pending) { invalidated = true; return; }
            pending = true;
            try {
                const listed = await inventory.list();
                if (!listed.success || !current()) return;
                const candidates = listed.results.filter(item => item.cwd === cwd && (sessionId ? item.sessionId === sessionId : !item.sessionId)
                    && (!comparison.comparisonId || item.comparisonId === comparison.comparisonId)
                    && scmReviewComparisonMatchesSource(comparison, item.source));
                // Newest first, for the requested output. A content-less failed attempt must not hide a published
                // value; when no candidate supplies one, retain that latest requested attempt.
                let failedAttempt: { result: ScmDiffSummaryResult; savedAtMs: number } | null = null;
                for (const candidate of candidates) {
                    const response = await operations.read({ cwd: candidate.cwd, resultId: candidate.resultId });
                    const captured = response.success ? response.result.output.comparison : null;
                    if (!response.success || !current() || captured?.repository.rootPath !== cwd || captured.id !== candidate.comparisonId
                        || !scmReviewComparisonMatchesSource(comparison, captured.source, captured)) continue;
                    const requestedOutput = response.result.output.success ? response.result.output.outputs?.[output] : undefined;
                    if (!requestedOutput) continue;
                    if (requestedOutput.value === undefined && (failedAttempt || scmDiffSummaryOutputNeedsPublishedFallback(requestedOutput))) {
                        failedAttempt ??= { result: response.result, savedAtMs: candidate.updatedAtMs };
                        continue;
                    }
                    loadSavedScmDiffSummaryResult({ ...host, scope, result: response.result, savedAtMs: candidate.updatedAtMs });
                    return;
                }
                if (failedAttempt && current()) loadSavedScmDiffSummaryResult({ ...host, scope, ...failedAttempt });
            } finally {
                pending = false;
                if (invalidated && current()) { invalidated = false; void restore(); }
            }
        };
        void restore();
        const unsubscribe = sessionId ? subscribeExecutionRunActivity({ sessionId, serverId: scope.serverId }, () => { if (current()) void restore(); }) : () => {};
        return () => { abort.abort(); unsubscribe(); };
    }, [binding, machineId, cwd, presence.reachability, sessionId, comparisonKey, output, Boolean(viewModel), needsPublishedFallback]);
    return viewModel;
}
