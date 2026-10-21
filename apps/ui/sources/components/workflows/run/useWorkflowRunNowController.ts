import React from 'react';

import { WorkflowRunStartRequestV1Schema, WorkflowRunStartResultV1Schema, WorkflowRunGetResultV1Schema, type WorkflowRunStartRequestV1, type WorkflowRunStartResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';

import {
    resolveWorkflowProblemPresentation,
    type WorkflowProblemPresentation,
} from '@/components/workflows/presentation/workflowProblemPresentation';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import {
    useTransientCommandAcknowledgement,
    type TransientCommandState,
} from '@/hooks/ui/useTransientCommandAcknowledgement';
import { storage } from '@/sync/domains/state/storageStore';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';

import { projectAcceptedWorkflowRunTarget } from './projectAcceptedWorkflowRunTarget';

/**
 * Transient command state for one **Run now** press.
 *
 * `acknowledged` means the server accepted the admission — it is not a Run
 * state. Whether that Run is queued, running, waiting for an approval or
 * already finished is read from the canonical Run projection, never inferred
 * from this vocabulary. The machine itself is the shared transient-command
 * owner, so this press and the Automation one cannot drift apart.
 */
export type WorkflowRunNowState = TransientCommandState;

export type WorkflowRunNowRequest = Readonly<{
    /**
     * Explicit recovery identity (for example a held Plan's derived Run id).
     * Ordinary starts omit this: the controller retains their identity until
     * admission settles, independently of the composer's dismissal/reopening.
     */
    runId?: string;
    source: WorkflowRunStartRequestV1['source'];
    metadata?: WorkflowRunStartRequestV1['metadata'];
    /** Declared-input values collected by the input sheet, in the Protocol shape. */
    inputs?: WorkflowRunStartRequestV1['inputs'];
    /** Reviewed run-layer overrides; admission resolves and freezes them. */
    roleOverrides?: WorkflowRunStartRequestV1['roleOverrides'];
    /**
     * Run-wide runtime choice. Session is the protocol default and is omitted
     * on the wire so older/current callers retain the same canonical shape.
     */
    executionTarget?: WorkflowRunStartRequestV1['executionTarget'];
    onComplete?: WorkflowRunStartRequestV1['onComplete'];
    /** Exact committed Discussion question; admission derives its frontier. */
    origin?: WorkflowRunStartRequestV1['origin'];
    /** Exact page-selected project, stamped as host context rather than Action input. */
    project?: WorkflowProjectTargetV1;
    /**
     * The definition the person reviewed when the source names it only by
     * reference (a saved revision or a catalog entry). It is never sent; it is
     * retained with this admission so a later review shows exactly what was
     * reviewed, not a newer revision read since.
     */
    reviewedDefinition?: WorkflowDefinitionV1;
    /**
     * The invoking session, stamped as host context `defaultSessionId`: FIN's one origin producer
     * records it as the Run's `origin.originSessionId` (`origin_session` steps, result delivery).
     */
    originSessionId?: string;
    /** Whether the pressing surface is still mounted/current, for error presentation only. */
    isInvocationCurrent?: () => boolean;
    /**
     * Where a refusal is said. A surface that keeps the reviewed composer open
     * (04 §4.8) takes it `inline` from {@link WorkflowRunNowController.refusal};
     * every other caller interrupts with the same problem as an alert.
     */
    refusal?: 'alert' | 'inline';
}>;

/** Preparation is part of this same press, including its retained id and pending/reconciliation custody. */
export type WorkflowRunNowPreparationRequest = Pick<WorkflowRunNowRequest, 'runId' | 'isInvocationCurrent' | 'refusal'> & Readonly<{
    prepareRequest: (runId: string) => Promise<Omit<WorkflowRunNowRequest, 'runId' | 'isInvocationCurrent' | 'refusal'>>;
}>;

export type WorkflowRunNowController = Readonly<{
    /** This start surface's pending admission, not an admitted Run's lifecycle. */
    pendingRunId: string | null;
    stateFor: (runId: string) => WorkflowRunNowState;
    isPending: (runId: string) => boolean;
    /** Active transport or retained uncertainty: a new press must keep this identity. */
    hasUnsettledAdmission: (runId: string) => boolean;
    /**
     * The exact request this start surface's intent already sent, while its
     * admission is unsettled. A later press re-sends this request, never the
     * surface's current values, so a review must show this one.
     */
    retainedRequest: WorkflowRunNowRetainedRequest | null;
    /**
     * Admits the reviewed draft and returns the exact admitted handle, so the
     * caller navigates to the Run the server settled rather than guessing it
     * from the newest history row. `null` means no handle is returned by this
     * call: no active Account, an admission already in flight for this id, a
     * retired Account scope, or a failure that was surfaced to the user.
     */
    runNow: (request: WorkflowRunNowRequest | WorkflowRunNowPreparationRequest) => Promise<WorkflowRunStartResultV1 | null>;
    /**
     * The last `inline` refusal, as the canonical problem owner describes it.
     * The next press replaces it; `clearRefusal` drops it when the composer that
     * showed it closes.
     */
    refusal: WorkflowProblemPresentation | null;
    clearRefusal: () => void;
}>;

function prepareWorkflowRunNowRequest(request: WorkflowRunNowRequest & Readonly<{ runId: string }>) {
    // Retain the exact transport snapshot, including permissive ingress data,
    // rather than the composer's mutable objects across an unknown outcome.
    const input = WorkflowRunStartRequestV1Schema.parse(projectNativeJsonValueForTransport({
        runId: request.runId,
        source: request.source,
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        ...(request.inputs === undefined ? {} : { inputs: request.inputs }),
        ...(request.roleOverrides === undefined ? {} : { roleOverrides: request.roleOverrides }),
        ...(request.executionTarget === undefined || request.executionTarget.kind === 'session'
            ? {}
            : { executionTarget: request.executionTarget }),
        ...(request.onComplete === undefined ? {} : { onComplete: request.onComplete }),
        ...(request.origin === undefined ? {} : { origin: request.origin }),
    }));
    const context = request.project === undefined && request.originSessionId === undefined ? undefined : {
        ...(request.originSessionId === undefined ? {} : { defaultSessionId: request.originSessionId }),
        ...(request.project === undefined ? {} : { externalActionTarget: {
            kind: 'machine' as const,
            machineId: request.project.machineId,
            project: projectAcceptedWorkflowRunTarget(request.project),
        } }),
    };
    return { input, context, ...(request.reviewedDefinition === undefined ? {} : { reviewedDefinition: request.reviewedDefinition }) };
}

type PreparedWorkflowRunNowRequest = ReturnType<typeof prepareWorkflowRunNowRequest>;

export type WorkflowRunNowRetainedRequest = Readonly<{
    input: WorkflowRunStartRequestV1;
    /** The project stamped as host context, when the request carried one. */
    project?: WorkflowProjectTargetV1;
    /** Whether its outcome is unknown (rather than still in flight). */
    unresolved: boolean;
    /** The reviewed definition of a by-reference source, when its sender supplied it. */
    reviewedDefinition?: WorkflowDefinitionV1;
}>;

function projectRetainedRequest(request: PreparedWorkflowRunNowRequest | null | undefined, unresolved: boolean): WorkflowRunNowRetainedRequest | null {
    if (request == null) return null;
    const project = request.context?.externalActionTarget?.project;
    return { input: request.input, ...(project === undefined ? {} : { project }), unresolved,
        ...(request.reviewedDefinition === undefined ? {} : { reviewedDefinition: request.reviewedDefinition }) };
}

type PendingAdmission = {
    runId: string;
    request: PreparedWorkflowRunNowRequest | null;
    unresolved: boolean;
};

/**
 * Reviewed requests outlive a route, just as the shared transient-command guard
 * does. Only pending/unknown admission data stays here, until settlement or the
 * captured Account's retirement; this is neither a Run cache nor reload custody.
 */
const admissionsByAccount = new Map<string, ReturnType<typeof createAdmissionState>>();

function createAdmissionState() {
    const byIntent = new Map<string, PendingAdmission>();
    const byRunId = new Map<string, PendingAdmission>();
    const refusals = new Map<string, WorkflowProblemPresentation>();
    const listeners = new Set<() => void>();
    let version = 0;
    return {
        byIntent, byRunId, refusals,
        activeLifetime: null as ActiveServerAccountScopeLifetime | null,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        snapshot: () => version,
        publish: () => { version++; for (const listener of listeners) listener(); },
        clear: () => { byIntent.clear(); byRunId.clear(); refusals.clear(); version++; for (const listener of listeners) listener(); },
    };
}

function admissionStateFor(lifetime: ActiveServerAccountScopeLifetime) {
    const key = serverAccountScopeKeySuffix(lifetime.scope);
    let state = admissionsByAccount.get(key);
    if (!state) {
        state = createAdmissionState();
        admissionsByAccount.set(key, state);
        const accountState = state;
        const serverId = lifetime.scope.serverId;
        // Exact-Home bindings retire on unmount as well as credential changes.
        // The credential owner, not a route's presentation lifetime, retires
        // Account-private request custody between mounts.
        subscribeHomeCredentialChange((event) => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, serverId)) accountState.clear();
        });
    }
    const activeLifetime = captureActiveServerAccountScopeLifetime();
    if (activeLifetime && areServerAccountScopesEqual(activeLifetime.scope, lifetime.scope) && state.activeLifetime !== activeLifetime) {
        state.activeLifetime = activeLifetime;
        activeLifetime.onRetire(state.clear);
    }
    return state;
}

const EMPTY_ADMISSION_STATE = createAdmissionState();

async function startWorkflowRun(request: PreparedWorkflowRunNowRequest, accountLifetime: ActiveServerAccountScopeLifetime): Promise<WorkflowRunStartResultV1> {
    // Dispatch and failure mapping stay at the one shared workflow Action seam.
    const result = await callWorkflowAction({
        actionId: 'workflow.run.start',
        input: request.input,
        parseResult: (value) => WorkflowRunStartResultV1Schema.parse(value),
        fallbackMessage: 'Workflow run request failed',
        accountLifetime,
        ...(request.context === undefined ? {} : { context: request.context }),
    });
    return result;
}

function unresolvedAdmission(): WorkflowActionError {
    return new WorkflowActionError({ message: 'workflow_outcome_unresolved', rawCode: 'workflow_outcome_unresolved' });
}

/** Absence is not rejection: rejoin the immutable request through canonical admission. */
async function reconcileWorkflowRunStart(
    request: PreparedWorkflowRunNowRequest,
    lifetime: ActiveServerAccountScopeLifetime,
): Promise<WorkflowRunStartResultV1> {
    try {
        const detail = await callWorkflowAction({
            actionId: 'workflow.run.get', input: { runId: request.input.runId },
            parseResult: (value) => WorkflowRunGetResultV1Schema.parse(value),
            fallbackMessage: 'Workflow admission outcome unavailable',
            accountLifetime: lifetime,
        });
        return { run: detail.run, admission: 'existing' };
    } catch (error) {
        if (!(error instanceof WorkflowActionError) || error.code !== 'run_not_found') throw unresolvedAdmission();
    }
    // A late original and this rejoin have the same Run id and reviewed input.
    // The admission owner compares that request and deduplicates the effect.
    // If this exchange is also unconfirmed, return control with the retained
    // identity rather than waiting forever for a feed event that may never exist.
    try { return await startWorkflowRun(request, lifetime); }
    catch { throw unresolvedAdmission(); }
}

/**
 * The UI admission owner for `workflow.run.start`.
 *
 * It owns one thing: turning an explicit press into exactly one canonical
 * admission and handing back the Run the server settled. The admitted body is
 * merged into the existing Account-scoped Run row map so the exact route can
 * open it immediately; this controller keeps no Run cache, no polling and no
 * Run-state interpretation of its own.
 */
export function useWorkflowRunNowController(
    accountLifetime?: ActiveServerAccountScopeLifetime | null,
    /** Stable source identity when navigation/remount returns to the same start surface. */
    intentKey?: string,
): WorkflowRunNowController {
    const lifetime = accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : accountLifetime;
    const command = useTransientCommandAcknowledgement<WorkflowRunStartResultV1>('workflow.runNow', lifetime);
    const instanceKey = React.useId();
    const key = intentKey ?? instanceKey;
    const state = lifetime?.isCurrent() ? admissionStateFor(lifetime) : EMPTY_ADMISSION_STATE;
    React.useSyncExternalStore(state.subscribe, state.snapshot, state.snapshot);
    const clearRefusal = React.useCallback(() => {
        if (state.refusals.delete(key)) state.publish();
    }, [key, state]);
    React.useEffect(() => () => {
        // A known refusal is presentation-local. Unknown custody remains
        // recoverable when this source is opened again under the same Account.
        if (!state.byIntent.has(key)) state.refusals.delete(key);
    }, [key, state]);
    const pendingAdmission = state.byIntent.get(key);
    const pendingRunId = pendingAdmission?.runId ?? null;
    const retained = pendingAdmission?.request;
    const retainedUnresolved = pendingAdmission?.unresolved === true;
    const retainedRequest = React.useMemo(() => projectRetainedRequest(retained, retainedUnresolved), [retained, retainedUnresolved]);
    const refusal = state.refusals.get(key) ?? null;

    return React.useMemo(() => ({
        pendingRunId,
        retainedRequest,
        stateFor: command.stateFor,
        isPending: (runId) => {
            const state = command.stateFor(runId);
            return state === 'submitting' || state === 'reconciling';
        },
        hasUnsettledAdmission: (runId) => {
            const state = command.stateFor(runId);
            return state === 'submitting' || state === 'reconciling'
                || lifetime?.isCurrent() === true && admissionStateFor(lifetime).byRunId.get(runId)?.unresolved === true;
        },
        // A second press while the first is still unsettled is the same intent,
        // not a second Run: the identical `runId` is already in flight.
        refusal,
        clearRefusal,
        runNow: async (request) => {
            const requestLifetime = accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : accountLifetime;
            if (requestLifetime === null || !requestLifetime.isCurrent()) return null;
            const requestState = admissionStateFor(requestLifetime);
            requestState.refusals.delete(key);
            const admission = (intentKey !== undefined || request.runId === undefined ? requestState.byIntent.get(key) : undefined)
                ?? (request.runId === undefined ? undefined : requestState.byRunId.get(request.runId))
                ?? { runId: request.runId ?? randomUUID(), request: null, unresolved: false };
            requestState.byIntent.set(key, admission);
            requestState.byRunId.set(admission.runId, admission);
            requestState.publish();
            const runId = admission.runId;
            let didSubmit = false;
            let accepted = false;
            let submitted: PreparedWorkflowRunNowRequest | null = null;
            const result = await command.run({
                commandId: runId,
                submit: async () => {
                    didSubmit = true;
                    submitted = admission.request ?? prepareWorkflowRunNowRequest({
                        ...('prepareRequest' in request ? await request.prepareRequest(runId) : request), runId,
                    });
                    if (admission.request !== submitted) {
                        admission.request = submitted;
                        requestState.publish();
                    }
                    try { return await startWorkflowRun(submitted, requestLifetime); }
                    catch (error) {
                        if (error instanceof WorkflowActionError && error.code === 'workflow_outcome_unresolved') {
                            admission.unresolved = true;
                        }
                        throw error;
                    }
                },
                recoverUnknownOutcome: {
                    isUnknown: (error) => error instanceof WorkflowActionError && error.code === 'workflow_outcome_unresolved',
                    reconcile: async (lifetime) => {
                        admission.unresolved = true;
                        if (submitted === null) throw unresolvedAdmission();
                        try { return await reconcileWorkflowRunStart(submitted, lifetime); }
                        catch (error) {
                            if (requestState.byRunId.get(runId) === admission) {
                                requestState.refusals.set(key, resolveWorkflowProblemPresentation(unresolvedAdmission()));
                                requestState.publish();
                            }
                            throw error;
                        }
                    },
                },
                // Merged into the existing Account-scoped Run row map only while
                // the pressing Account is still active, so the exact route can open
                // the settled Run immediately.
                onAccepted: (result) => {
                    accepted = true;
                    admission.unresolved = false;
                    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(
                        result.run,
                        submitted?.input.metadata ? { kind: 'available', value: submitted.input.metadata } : null,
                    )], requestLifetime.scope);
                },
                ...(request.isInvocationCurrent
                    ? { isInvocationCurrent: request.isInvocationCurrent }
                    : {}),
                onError: async (error) => {
                    // The Automation formatter knows no workflow code, so every
                    // admission refusal — no access, a conflicting rejoin, a
                    // definition that needs repair — read as one generic sentence.
                    const problem = resolveWorkflowProblemPresentation(admission.unresolved ? unresolvedAdmission() : error);
                    if (request.refusal === 'inline') {
                        requestState.refusals.set(key, problem);
                        requestState.publish();
                    }
                    else await Modal.alert(problem.title, problem.message);
                },
            });
            const state = command.stateFor(runId);
            if (admission.unresolved && state === 'idle' && requestState.byRunId.get(runId) === admission
                && requestState.refusals.get(key)?.code !== 'workflow_outcome_unresolved') {
                requestState.refusals.set(key, resolveWorkflowProblemPresentation(unresolvedAdmission()));
                requestState.publish();
            }
            // A duplicate press returns null while the first is still pending;
            // only acceptance, a definitive refusal or retired scope releases its id.
            if (didSubmit && !admission.unresolved && state !== 'submitting' && state !== 'reconciling') {
                requestState.byRunId.delete(runId);
                for (const [intent, pending] of requestState.byIntent) {
                    if (pending === admission) {
                        requestState.byIntent.delete(intent);
                        if (accepted) requestState.refusals.delete(intent);
                    }
                }
                requestState.publish();
            }
            return result;
        },
    }), [accountLifetime, clearRefusal, command, intentKey, key, lifetime, pendingRunId, refusal, retainedRequest]);
}
