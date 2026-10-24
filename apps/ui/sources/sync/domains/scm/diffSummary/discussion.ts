import { resolveExecutionRunInteractionAffordances } from '@happier-dev/protocol/execution/runs/interactionAffordances';
import type { ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';
import type { ScmDiffSummaryResult } from '@happier-dev/protocol/scm/diffSummaryResult';
import { buildSessionExecutionRunRouteHref } from '@/components/sessions/agents/navigation/buildSessionExecutionRunRouteHref';
import type { ScmDiffSummaryState } from './state';

export type ScmDiffSummaryDiscussionTarget =
    | Readonly<{ kind: 'unknown' }>
    | Readonly<{ kind: 'unavailable' }>
    | Readonly<{
        kind: 'continue';
        recipient: Extract<ParticipantRecipientV1, { kind: 'execution_run' }>;
        href: string;
        needsResume: boolean;
    }>;

export type ScmDiffSummaryStopDiscussionContext = Readonly<{
    resultId: string;
    revision: number;
    stopIds: readonly string[];
}>;

/** Capture selected stops from this displayed revision, not a later regenerated result. */
export function selectScmDiffSummaryStopDiscussionContext(
    result: ScmDiffSummaryResult,
    stopIds: readonly string[],
): ScmDiffSummaryStopDiscussionContext | null {
    if (!result.output.success || stopIds.length === 0 || new Set(stopIds).size !== stopIds.length) return null;
    const stops = result.output.outputs?.walkthrough?.value?.stops;
    if (!stops || stopIds.some((id) => !stops.some((stop) => stop.id === id))) return null;
    return { resultId: result.resultId, revision: result.revision, stopIds: [...stopIds] };
}

/**
 * The saved revision an unsent question about one stop addresses, when it is loaded here and still holds that
 * stop. The composer reads the stop's number, file and lines from it; when it is not loaded the recipient alone
 * still says where the question goes, and the stop ids stay the authority for what is sent.
 */
export function selectScmDiffSummaryDiscussionSavedResult(state: ScmDiffSummaryState,
    target: Readonly<{ resultId: string; expectedRevision: number; stopIds?: readonly string[] }> | null): ScmDiffSummaryResult | null {
    const stopId = target?.stopIds?.[0];
    if (!target || !stopId) return null;
    for (const entry of Object.values(state.entriesByKey)) {
        const saved = entry.savedResult;
        if (saved?.resultId !== target.resultId || saved.revision !== target.expectedRevision || !saved.output.success) continue;
        return saved.output.outputs?.walkthrough?.value?.stops.some((stop) => stop.id === stopId) ? saved : null;
    }
    return null;
}

/** Open the generating Run itself; transcript reconstructions never grant interaction. */
export function resolveScmDiffSummaryDiscussionTarget(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    runId: string | null;
    run: ExecutionRunPublicState | null | undefined;
    source: 'session_rpc' | 'transcript_fallback' | 'daemon_fallback';
    canControlExecutionRuns: boolean;
}>): ScmDiffSummaryDiscussionTarget {
    // Restoring saved output precedes observing its Run. Missing or reconstructed
    // evidence cannot establish whether that conversation is still available.
    if (!params.runId || params.source !== 'session_rpc' || params.run?.runId !== params.runId) return { kind: 'unknown' };
    if (!params.canControlExecutionRuns) return { kind: 'unavailable' };
    // Admission publishes the current Run before native interaction is ready.
    if (params.run.status === 'running' && params.run.lifecycle?.state === 'current' && !params.run.interaction) return { kind: 'unknown' };
    const affordances = resolveExecutionRunInteractionAffordances(params.run);
    if (!affordances.canSend && !affordances.canResume) return { kind: 'unavailable' };
    const href = buildSessionExecutionRunRouteHref({ ...params, runId: params.runId });
    if (!href) return { kind: 'unavailable' };
    return {
        kind: 'continue', recipient: { kind: 'execution_run', runId: params.runId },
        href, needsResume: !affordances.canSend && affordances.canResume,
    };
}
