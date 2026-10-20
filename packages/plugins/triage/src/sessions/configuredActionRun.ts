import { createTriageBulkEntrySessionsController, projectTriageConfiguredBulkResultV1, type TriageBulkSessionsRequestV1, type TriageBulkHostV1 } from './bulkEntrySessionsController.js';
import { createTriageEntrySessionStartController, type TriageStartHostV1, type TriagePendingPullRequestReviewV1 } from './entrySessionStartController.js';
import type { TriageRunConfiguredActionInputV1, TriageRunConfiguredActionResultV1 } from '../actions/configuredActionRunProtocol.js';
import { planTriageOfferedActionsV1 } from '../settings/actions.js';
import type { TriagePullRequestReviewChoiceV1, TriageStartEntrySessionResultV1 } from '../actions/entrySessionProtocol.js';
import { continueTriagePullRequestReviewV1 } from './pullRequestReviewContinuation.js';
import { openLinkedSession } from './entrySessionOpen.js';
import { triageEntryRowKey } from '../projection/listWindow.js';
import { resolveTriageConfiguredActionForExecutionV1 } from './actionResolution.js';

export type TriageConfiguredActionRunHostV1 = TriageBulkHostV1 & TriageStartHostV1;
export type TriageConfiguredActionRunRequestV1 = Readonly<{
    actionId: string;
    entries: TriageBulkSessionsRequestV1['entries'];
    /** Original addressed identities, including unavailable/refused rows, on retained continuation. */
    selectedEntries?: TriageRunConfiguredActionInputV1['entries'];
    unavailableKeys?: readonly string[];
    destination: 'single' | TriageBulkSessionsRequestV1['destination'];
    settlements?: readonly unknown[];
    reviewChoices?: TriagePullRequestReviewChoiceV1;
    resumeReview?: TriageRunConfiguredActionInputV1['resumeReview'];
    resumeStart?: TriageRunConfiguredActionInputV1['resumeStart'];
}>;

export async function runTriageConfiguredActionV1(
    host: TriageConfiguredActionRunHostV1,
    request: TriageConfiguredActionRunRequestV1,
    options?: Readonly<{ signal?: AbortSignal; mintCreationKey?: () => string }>,
): Promise<TriageRunConfiguredActionResultV1> {
    if (options?.signal?.aborted) return { v: 1, status: 'cancelled' };
    const refuse = (reason: string): TriageRunConfiguredActionResultV1 => ({
        v: 1, status: 'unavailable', reason,
        ...(request.resumeStart === undefined ? {} : {
            recovery: request.resumeStart,
            ...(request.resumeStart.state.kind === 'bulk' ? {
                results: request.resumeStart.state.units.map((unit) => unit.result),
                refusals: request.resumeStart.state.refusals,
                unavailableKeys: request.resumeStart.state.unavailableKeys,
            } : {}),
        }),
        ...(request.resumeReview === undefined ? {} : {
            result: request.resumeReview.result, reviewInstructions: request.resumeReview.instructions,
        }),
    });
    const resolved = await resolveTriageConfiguredActionForExecutionV1(host, request.actionId, undefined,
        options?.signal === undefined ? undefined : { signal: options.signal });
    if (options?.signal?.aborted) return { v: 1, status: 'cancelled' };
    if (resolved.status !== 'resolved') return refuse(resolved.reason);
    const action = resolved.action;
    const selectedEntries = request.selectedEntries ?? request.entries.map((entry) => ({ entryRef: entry.entryRef, sourceInstanceId: entry.sourceInstance.sourceInstanceId }));
    const recovery = request.resumeStart;
    if (recovery !== undefined) {
        const matchesEntries = recovery.entries.length === selectedEntries.length && recovery.entries.every((retained, index) => {
            const current = selectedEntries[index];
            return current !== undefined && triageEntryRowKey(retained.entryRef) === triageEntryRowKey(current.entryRef)
                && retained.sourceInstanceId === current.sourceInstanceId;
        });
        const state = recovery.state;
        const matchesStart = state.kind === 'single'
            ? request.destination === 'single' && state.actionId === action.actionId
                && selectedEntries.length === 1
                && triageEntryRowKey(state.input.entryRef) === triageEntryRowKey(selectedEntries[0]!.entryRef)
            : request.destination === state.destination && state.action.actionId === action.actionId;
        if (!matchesEntries || !matchesStart || request.resumeReview !== undefined) {
            return refuse('startContinuationMismatch');
        }
    }
    if (request.destination === 'single' && recovery === undefined && request.resumeReview === undefined) {
        const entry = request.entries.length === 1 ? request.entries[0] : undefined;
        if (entry === undefined) return refuse('singleEntryRequired');
        if (entry.workflowSubject === null || planTriageOfferedActionsV1([action], entry.workflowSubject).length === 0) {
            return refuse('actionInapplicable');
        }
    }
    const finishReview = async (pending: TriagePendingPullRequestReviewV1, result: TriageStartEntrySessionResultV1): Promise<TriageRunConfiguredActionResultV1> => {
        const basis = { v: 1 as const, result, reviewInstructions: pending.instructions };
        if (request.reviewChoices === undefined) return { ...basis, status: 'awaitingReview' };
        const continuation = await continueTriagePullRequestReviewV1(host, pending, request.reviewChoices, options);
        if (continuation.kind !== 'settled') return { ...basis, status: continuation.kind === 'unknown'
            ? 'reviewUnknown' : continuation.kind === 'cancelled' ? 'awaitingReview' : 'reviewRefused' };
        const reviewResult = continuation.result;
        if (reviewResult.status !== 'started') return { ...basis, status: 'reviewRefused', reviewResult };
        if (reviewResult.failedEngineIds.length > 0) return { ...basis, status: 'reviewPartial', reviewResult };
        const opened = await openLinkedSession({ execute: async (id, input, cancellation) => host.executeAction(id, input, cancellation),
            sessionId: pending.sessionId, signal: options?.signal });
        return { ...basis, status: 'reviewStarted', reviewResult, sessionOpen: opened.status };
    };
    if (request.resumeReview !== undefined) {
        const { result, instructions } = request.resumeReview;
        const entry = selectedEntries.length === 1 ? selectedEntries[0] : undefined;
        if (request.destination !== 'single' || action.target.kind !== 'reviewStart'
            || action.workspaceMode !== 'pull_request' || entry === undefined
            || (result.type !== 'linked' && result.type !== 'opened') || result.review === undefined
            || triageEntryRowKey(result.review.entryRef) !== triageEntryRowKey(entry.entryRef)
            || result.review.instance.instance.sourceInstanceId !== entry.sourceInstanceId) {
            return refuse('reviewContinuationMismatch');
        }
        // Retained facts are input, not authority: the incumbent final Review Action
        // rereads the source/workspace and admits the canonical review.start request.
        return finishReview({ actionId: action.actionId, sessionId: result.sessionId, review: result.review, instructions }, result);
    }
    if (request.destination === 'single') {
        const entry = request.entries.length === 1 ? request.entries[0] : undefined;
        if (entry === undefined) return refuse('singleEntryRequired');
        const singleHost: TriageStartHostV1 = options?.signal === undefined ? host : {
            ...host,
            executeAction: (id, input, executionOptions) => host.executeAction(id, input, { ...executionOptions, signal: options.signal }),
            selectActionInput: (input, selectionOptions) => host.selectActionInput(input, { ...selectionOptions, signal: options.signal }),
        };
        const owner = createTriageEntrySessionStartController(singleHost, options);
        try {
            if (recovery?.state.kind === 'single') owner.restore(recovery.state);
            owner.getSnapshot().start({ ...entry, action, ...(request.settlements?.[0] === undefined ? {} : { settlement: request.settlements[0] }) });
            const outcome = await owner.waitForSettled();
            const state = owner.getRecovery();
            const retained = state === null ? {} : { recovery: { entries: selectedEntries, state } };
            if (outcome.phase.kind === 'settled' && outcome.review !== null) {
                return finishReview(outcome.review, outcome.phase.result);
            }
            if (outcome.phase.kind === 'settled') return {
                v: 1, status: 'single', result: outcome.phase.result,
                ...retained,
                ...(outcome.review === null ? {} : { reviewInstructions: outcome.review.instructions }),
            };
            if (options?.signal?.aborted) return { v: 1, status: 'cancelled', ...retained };
            if (outcome.phase.kind === 'unavailable') return { v: 1, status: 'unavailable', reason: outcome.phase.reason, ...retained };
            return { v: 1, status: 'seeded' };
        } finally { owner.dispose(); }
    }
    const owner = createTriageBulkEntrySessionsController(host, options);
    const cancel = () => owner.getSnapshot().cancel();
    options?.signal?.addEventListener('abort', cancel, { once: true });
    try {
        if (recovery?.state.kind === 'bulk') {
            if (!owner.restore(recovery.state, request.entries)) return refuse('startContinuationMismatch');
            owner.getSnapshot().retry();
        } else owner.getSnapshot().run({ action, entries: request.entries, destination: request.destination, unavailableKeys: request.unavailableKeys,
            settlementForEntries: (entries) => request.settlements?.[
                request.destination === 'oneSessionForAllEntries' ? 0
                    : request.entries.findIndex((candidate) => candidate.key === entries[0]?.key)
            ],
        });
        const { phase } = await owner.waitForSettled();
        const state = owner.getRecovery();
        if (phase.kind === 'settled') return {
            v: 1, status: 'bulk', unavailableKeys: [...phase.unavailableKeys],
            refusals: phase.refusals.map((refusal) => ({ entryRef: refusal.entry.entryRef, reason: refusal.reason })),
            results: phase.results.map(projectTriageConfiguredBulkResultV1),
            ...(state === null ? {} : { recovery: { entries: selectedEntries, state } }),
        };
        if (phase.kind === 'seeded') return { v: 1, status: 'seeded', entries: [...phase.outcomes],
            refusals: phase.refusals.map((refusal) => ({ entryRef: refusal.entry.entryRef, reason: refusal.reason })),
        };
        if (phase.kind === 'unavailable') return refuse(phase.reason);
        return { v: 1, status: 'cancelled' };
    } finally {
        options?.signal?.removeEventListener('abort', cancel);
        owner.dispose();
    }
}
