import * as React from 'react';
import type { ScmDiffSummaryOutputKind, ScmDiffSummaryResult } from '@happier-dev/protocol/scm';

import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import type { ScmDiffSummaryEntry, ScmDiffSummaryViewModel, ScmDiffSummaryRestoreState } from '@/sync/domains/scm/diffSummary/state';
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
import { useSessionMachineControlTargetState, useSessionMachineDisplayIdentity } from '@/components/sessions/model/useSessionMachineTarget';
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

export function useScmWalkthroughState(host: Readonly<{ sessionId: string }> | Readonly<{ machineId: string; cwd: string }>,
    comparison: SessionScmReviewComparison | null, output: ScmDiffSummaryOutputKind = 'walkthrough', serverId?: string | null) {
    const binding = useServerCredentialAccountScopeBinding(serverId).binding;
    const scopeKey = binding?.isCurrent() ? serverAccountScopeKeySuffix(binding.scope) : null;
    const comparisonKey = comparison ? scmComparisonKey(comparison) : null;
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
            projection = key ? getScmDiffSummaryOperationState(state, key, output) : null;
            return projection;
        };
    }, ['sessionId' in host ? host.sessionId : null, 'machineId' in host ? host.machineId : null,
        'cwd' in host ? host.cwd : null, comparisonKey, output, scopeKey, binding]);
    const viewModel = React.useSyncExternalStore(subscribeScmDiffSummaryState, getSnapshot, getSnapshot);
    const sessionId = 'sessionId' in host ? host.sessionId : null;
    // The control-target owner admits an exact metadata target before presence hydrates; transport still
    // verifies the captured Session/Account. Display identity is used only to explain known offline state.
    const sessionTarget = useSessionMachineControlTargetState(sessionId ?? '', serverId);
    const sessionMachine = sessionTarget.status === 'ready' ? sessionTarget : null;
    const displayMachine = useSessionMachineDisplayIdentity(sessionId ?? '', serverId);
    const machineId = 'machineId' in host ? host.machineId : sessionMachine?.machineId;
    const cwd = 'cwd' in host ? host.cwd : sessionMachine?.basePath;
    const presence = useMachinePresenceSummary(binding?.scope.serverId, machineId ?? (sessionId ? displayMachine.machineId : null));
    const machineOffline = presence.reachability === 'unreachable';
    const restoreKey = JSON.stringify([scopeKey, sessionId, machineId, cwd, comparisonKey, output]);
    const [restored, setRestored] = React.useState<Readonly<{ key: string; state: 'ready' | 'unavailable' }> | null>(null);
    const [retry, setRetry] = React.useState(0);
    const retryRestore = React.useCallback(() => { setRestored(null); setRetry(value => value + 1); }, []);
    const needsPublishedFallback = Boolean(viewModel?.savedResult && scmDiffSummaryOutputNeedsPublishedFallback(viewModel.outputs?.[output]));
    // Files, Walkthrough and Commits read the same saved-result owner. A
    // published reading must not depend on visiting its generation controls.
    React.useEffect(() => {
        if (!binding?.isCurrent() || !machineId || !cwd || machineOffline || !comparison || (viewModel && !needsPublishedFallback)) return;
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
                if (!current()) return;
                if (!listed.success) { setRestored({ key: restoreKey, state: 'unavailable' }); return; }
                const candidates = listed.results.filter(item => item.cwd === cwd && (sessionId ? item.sessionId === sessionId : !item.sessionId)
                    && (!comparison.comparisonId || item.comparisonId === comparison.comparisonId)
                    && scmReviewComparisonMatchesSource(comparison, item.source));
                // Newest first, for the requested output. A content-less failed attempt must not hide a published
                // value; when no candidate supplies one, retain that latest requested attempt.
                let failedAttempt: { result: ScmDiffSummaryResult; savedAtMs: number } | null = null;
                let unreadable = false;
                for (const candidate of candidates) {
                    const response = await operations.read({ cwd: candidate.cwd, resultId: candidate.resultId });
                    if (!current()) return;
                    const captured = response.success ? response.result.output.comparison : null;
                    if (!response.success || captured?.repository.rootPath !== cwd || captured.id !== candidate.comparisonId
                        || !scmReviewComparisonMatchesSource(comparison, captured.source, captured)) { unreadable = true; continue; }
                    const requestedOutput = response.result.output.success ? response.result.output.outputs?.[output] : undefined;
                    if (!requestedOutput) continue;
                    if (requestedOutput.value === undefined && (failedAttempt || scmDiffSummaryOutputNeedsPublishedFallback(requestedOutput))) {
                        failedAttempt ??= { result: response.result, savedAtMs: candidate.updatedAtMs };
                        continue;
                    }
                    loadSavedScmDiffSummaryResult({ ...host, scope, result: response.result, savedAtMs: candidate.updatedAtMs });
                    setRestored({ key: restoreKey, state: 'ready' });
                    return;
                }
                if (failedAttempt && current()) loadSavedScmDiffSummaryResult({ ...host, scope, ...failedAttempt });
                if (current()) setRestored({ key: restoreKey, state: unreadable ? 'unavailable' : 'ready' });
            } catch {
                if (current()) setRestored({ key: restoreKey, state: 'unavailable' });
            } finally {
                pending = false;
                if (invalidated && current()) { invalidated = false; void restore(); }
            }
        };
        void restore();
        const unsubscribe = sessionId ? subscribeExecutionRunActivity({ sessionId, serverId: scope.serverId }, () => { if (current()) void restore(); }) : () => {};
        return () => { abort.abort(); unsubscribe(); };
    }, [binding, machineId, cwd, machineOffline, sessionId, comparisonKey, output, Boolean(viewModel), needsPublishedFallback, restoreKey, retry]);
    // A missing projection is unknown until its saved read settles. Presence and target hydration can take
    // longer than the read itself; neither is proof that this comparison has no saved output.
    const restoreState: ScmDiffSummaryRestoreState = !comparison ? 'idle' : viewModel ? 'ready'
        : restored?.key === restoreKey ? restored.state
        : machineOffline || (sessionId && sessionTarget.status === 'unavailable') ? 'unavailable' : 'restoring';
    return { viewModel, restoreState, retryRestore, machineReachability: presence.reachability } as const;
}

/** Projection-only consumers share the same restoration lifecycle as the foreground binding. */
export function useScmWalkthrough(host: Readonly<{ sessionId: string }> | Readonly<{ machineId: string; cwd: string }>,
    comparison: SessionScmReviewComparison | null, output: ScmDiffSummaryOutputKind = 'walkthrough', serverId?: string | null): ScmDiffSummaryViewModel | null {
    return useScmWalkthroughState(host, comparison, output, serverId).viewModel;
}
