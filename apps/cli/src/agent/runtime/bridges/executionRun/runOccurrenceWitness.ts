import type { ExecutionRunInputTurnV1 } from '@happier-dev/protocol';

import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import type {
    ExecutionRunController,
    ExecutionRunBackendController,
    ExecutionRunControllerOccurrenceV1,
} from '@/agent/executionRuns/controllers/types';

/**
 * The exact live occurrence of one Session-owned Execution Run.
 *
 * A resume, restart, or controller replacement produces a new occurrence. A
 * superseded occurrence stops being current and can never supply the live turn's
 * authority again, so two simultaneously active turns cannot borrow each other's
 * witness.
 */
export type ExecutionRunOccurrenceWitnessV1 = ExecutionRunControllerOccurrenceV1;

/**
 * A Session-lifetime reader over the current Run occurrences.
 *
 * Consumers that are rebuilt per request — for example a per-HTTP/RPC MCP server —
 * hold this stable reader instead of capturing a controller, so they always
 * resolve the exact occurrence that is current at call time.
 */
export type ExecutionRunOccurrenceWitnessReaderV1 = Readonly<{
    readCurrentRunOccurrence: (runId: string) => ExecutionRunOccurrenceWitnessV1 | null;
}>;

export type ExecutionRunOccurrenceRegistration = Readonly<{
    occurrence: ExecutionRunOccurrenceWitnessV1;
    /** Retire this exact occurrence. Disposing a superseded one never retires the live one. */
    dispose: () => void;
}>;

export type ExecutionRunOccurrenceWitnessRegistry = Readonly<{
    reader: ExecutionRunOccurrenceWitnessReaderV1;
    register: (params: Readonly<{
        runId: string;
        sidechainId: string;
        controller: ExecutionRunController;
        runtimeLifetimeSignal: AbortSignal;
        /**
         * The native Session runtime's own liveness. Once disposal starts, the
         * occurrence stops being current immediately — it does not wait for
         * controller settlement to retire the registration.
         */
        isRuntimeLive?: () => boolean;
        readActiveTurnAdmissionWitness: () => AgentInvocationTurnAdmissionWitness | null;
    }>) => ExecutionRunOccurrenceRegistration;
}>;

export type RegisterExecutionRunOccurrence = (params: Readonly<{
    runId: string;
    sidechainId: string;
    controller: ExecutionRunController;
}>) => () => void;

export type ExecutionRunInputTurnsProjectionV1 = Readonly<{
    occurrenceId: string;
    current?: ExecutionRunInputTurnV1;
    last?: ExecutionRunInputTurnV1;
}>;

export function projectExecutionRunInputTurn({ committedResultLocalId: _localId, committedPartialResultLocalId: _partialLocalId, ...turn }:
    NonNullable<ExecutionRunBackendController['currentInputTurn']>): ExecutionRunInputTurnV1 {
    return turn;
}

/**
 * The one exact-input observation every reader shares: public state, the
 * blocking exact-input wait and stop's final witness capture.
 *
 * A live backend controller answers from its own current/last turn under the
 * occurrence that labels it — the canonical occurrence witness for a
 * Session-owned retained Run, or the detached/bounded controller's own
 * exact-result occurrence. Without a live labelled controller the Run's
 * retained `inputTurns` stands. The controller identity also labels a Run with
 * no exact-input turn; retaining that identity does not retain live authority.
 */
export function projectExecutionRunInputTurns(params: Readonly<{
    runId: string;
    retained: ExecutionRunInputTurnsProjectionV1 | undefined;
    controller: ExecutionRunController | undefined;
    reader: ExecutionRunOccurrenceWitnessReaderV1;
}>): ExecutionRunInputTurnsProjectionV1 | undefined {
    const controller = params.controller;
    if (!controller) return params.retained;
    const occurrenceId = params.reader.readCurrentRunOccurrence(params.runId)?.occurrenceId
        ?? (controller.kind === 'backend' ? controller.inputTurnOccurrenceId : undefined)
        ?? controller.controllerOccurrenceId;
    if (!occurrenceId) return params.retained;
    return {
        occurrenceId,
        ...(controller.kind === 'backend' && controller.currentInputTurn ? { current: projectExecutionRunInputTurn(controller.currentInputTurn) } : {}),
        ...(controller.kind === 'backend' && controller.lastInputTurn ? { last: projectExecutionRunInputTurn(controller.lastInputTurn) } : {}),
    };
}

/**
 * Stable occurrence identities projected from the canonical controller map.
 *
 * It holds no permission decision, Account identity, or approval policy.
 * It does not own currentness: every answer is derived from the exact controller
 * entry plus that controller's runtime lifetime.
 */
export function createExecutionRunOccurrenceWitnessRegistry(
    controllers: ReadonlyMap<string, ExecutionRunController>,
): ExecutionRunOccurrenceWitnessRegistry {
    const reader: ExecutionRunOccurrenceWitnessReaderV1 = Object.freeze({
        readCurrentRunOccurrence: (runId) => {
            const controller = controllers.get(runId);
            const occurrence = controller?.executionRunOccurrence;
            return occurrence && occurrence.isCurrent() ? occurrence : null;
        },
    });

    return Object.freeze({
        reader,
        register: (params) => {
            const occurrenceId = params.controller.controllerOccurrenceId;
            const isCurrent = (): boolean => controllers.get(params.runId) === params.controller
                && params.controller.executionRunOccurrence === occurrence
                && !params.runtimeLifetimeSignal.aborted
                && (params.isRuntimeLive?.() ?? true);
            const occurrence: ExecutionRunOccurrenceWitnessV1 = Object.freeze({
                runId: params.runId,
                sidechainId: params.sidechainId,
                occurrenceId,
                runtimeLifetimeSignal: params.runtimeLifetimeSignal,
                isCurrent,
                readActiveTurnAdmissionWitness: () => (
                    isCurrent() ? params.readActiveTurnAdmissionWitness() : null
                ),
            });
            params.controller.executionRunOccurrence = occurrence;
            return Object.freeze({
                occurrence,
                dispose: () => {
                    if (params.controller.executionRunOccurrence === occurrence) {
                        delete params.controller.executionRunOccurrence;
                    }
                },
            });
        },
    });
}
