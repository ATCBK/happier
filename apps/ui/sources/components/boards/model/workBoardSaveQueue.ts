import { applyWorkBoardIntentV1, buildWorkBoardWidgetKeyV1, WorkBoardWidgetMutationErrorV1, type WorkBoardIntentV1, type WorkBoardsV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { WorkBoardMutationErrorV1, type WorkBoardArtifactPortV1 } from '@happier-dev/protocol/boards/workBoardArtifactV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { WIDGET_SIZE_POLICY_V1 } from '@happier-dev/protocol/widgets';

/**
 * The optimistic queue of a Home's Board Artifacts.
 *
 * Every edit is a `WorkBoardIntentV1` from the protocol owner. It shows at once — the displayed
 * boards are the last acknowledged boards with the pending intents replayed on top — and is then
 * written through the shared Board Artifact port, which replays the same intent against the
 * current Artifact winner. A refusal drops the intent, so
 * the last acknowledged board shows again, and leaves an actionable failure with Retry.
 *
 * Writes run one at a time, in order: each replays against the result of the one before.
 */

export type WorkBoardSaveFailureReason = 'invalidValue' | 'not_found' | 'unavailable';

export type WorkBoardSaveFailure = Readonly<{
    intent: WorkBoardIntentV1;
    reason: WorkBoardSaveFailureReason;
}>;

export type WorkBoardSaveState = Readonly<{
    pending: readonly WorkBoardIntentV1[];
    failure: WorkBoardSaveFailure | null;
}>;

export type WorkBoardSaveOutcome = Readonly<{ status: 'applied'; boards: WorkBoardsV1 }>
    | Readonly<{ status: 'pending'; code: 'approval_required' }>
    /** `details` is the Action refusal's own reason (a widget's refused inputs), kept so its Add can say what is wrong. */
    | Readonly<{ status: 'refused' | 'unknown'; code: string; details?: unknown }>;

const INITIAL_STATE: WorkBoardSaveState = Object.freeze({ pending: Object.freeze([]), failure: null });

/** The boards to show: the acknowledged boards with every pending edit replayed by the protocol owner. */
export function projectDisplayedWorkBoards(acknowledged: WorkBoardsV1, pending: readonly WorkBoardIntentV1[]): WorkBoardsV1 {
    let boards = acknowledged;
    for (const intent of pending) {
        try {
            const result = applyWorkBoardIntentV1(boards, intent);
            if (result.status === 'applied') boards = result.boards;
        } catch (error) {
            // An acknowledgement may publish before its pending intent retires, or a
            // concurrent edit may invalidate it. Keep the acknowledged projection;
            // the actual writer still decides and exposes the pending edit's outcome.
            if (!(error instanceof WorkBoardWidgetMutationErrorV1)) throw error;
        }
    }
    return boards;
}

export type WorkBoardSaveQueue = Readonly<{
    getState(): WorkBoardSaveState;
    subscribe(listener: () => void): () => void;
    dispatch(intent: WorkBoardIntentV1): Promise<WorkBoardSaveOutcome>;
    /** Admission can refuse before an optimistic write begins; recovery still belongs to this queue. */
    recordFailure(intent: WorkBoardIntentV1, reason: WorkBoardSaveFailureReason): void;
    /** Replays the failed edit. */
    retry(): Promise<WorkBoardSaveOutcome | null>;
    dismissFailure(): void;
    /** Forgets pending edits and the failure (another Account or Home took over). */
    reset(): void;
}>;

export function createWorkBoardSaveQueue(deps: Readonly<{ port: Pick<WorkBoardArtifactPortV1, 'readBoard' | 'apply'> }>): WorkBoardSaveQueue {
    let state = INITIAL_STATE;
    let generation = 0;
    let tail: Promise<void> = Promise.resolve();
    const listeners = new Set<() => void>();
    const setState = (next: WorkBoardSaveState) => {
        state = next;
        for (const listener of listeners) listener();
    };

    const readAddedWidget = async (intent: Extract<WorkBoardIntentV1, { kind: 'widget_add' }>): Promise<WorkBoardSaveOutcome | null> => {
        const board = await deps.port.readBoard(intent.boardId);
        const placement = board?.widgets?.find(item => buildWorkBoardWidgetKeyV1(item.ref) === buildWorkBoardWidgetKeyV1(intent.ref));
        if (!board || !placement) return null;
        if (!sameStrictJsonValue(placement.instance, intent.instance)
            || placement.size !== (intent.size ?? WIDGET_SIZE_POLICY_V1.workBoard.defaultSize)
            || (placement.frameStyle ?? 'card') !== (intent.frameStyle ?? 'card')) {
            throw new WorkBoardWidgetMutationErrorV1('widget_instance_already_exists');
        }
        return { status: 'applied', boards: { v: 1, boards: [board] } };
    };
    const write = async (intent: WorkBoardIntentV1, writeGeneration: number, retryingAdd: boolean): Promise<WorkBoardSaveOutcome> => {
        let failure: WorkBoardSaveFailure | null = null;
        let outcome: WorkBoardSaveOutcome;
        let applying = false;
        try {
            if (writeGeneration !== generation) return { status: 'refused', code: 'board_scope_retired' };
            // A retry first asks the actual Artifact owner. An unavailable read cannot
            // authorize another write, and a committed placement is already success.
            const recovered = retryingAdd && intent.kind === 'widget_add' ? await readAddedWidget(intent) : null;
            applying = !recovered;
            outcome = recovered ?? { status: 'applied', boards: await deps.port.apply(intent) };
        } catch (error) {
            failure = { intent, reason: error instanceof WorkBoardWidgetMutationErrorV1 ? 'invalidValue' : error instanceof WorkBoardMutationErrorV1
                ? error.code === 'board_not_found' ? 'not_found'
                    : error.code === 'board_scope_retired' ? 'unavailable' : 'invalidValue' : 'unavailable' };
            outcome = error instanceof WorkBoardWidgetMutationErrorV1 || error instanceof WorkBoardMutationErrorV1 && error.code !== 'board_scope_retired'
                ? { status: 'refused', code: error.code }
                : { status: 'unknown', code: error instanceof WorkBoardMutationErrorV1 ? error.code : 'board_write_unknown' };
            const lateAdd = applying && retryingAdd && error instanceof WorkBoardWidgetMutationErrorV1 && error.code === 'widget_instance_already_exists';
            if (lateAdd) {
                outcome = { status: 'unknown', code: 'board_write_unknown' };
                failure = { intent, reason: 'unavailable' };
            }
            if (applying && intent.kind === 'widget_add' && writeGeneration === generation && outcome.status === 'unknown') {
                // The transport may have committed before losing its acknowledgement,
                // including between a retry's read and CAS. Identity survives that retry.
                try {
                    const recovered = await readAddedWidget(intent);
                    if (recovered) { outcome = recovered; failure = null; }
                } catch (readError) {
                    if (readError instanceof WorkBoardWidgetMutationErrorV1) {
                        outcome = { status: 'refused', code: readError.code };
                        failure = { intent, reason: 'invalidValue' };
                    }
                    // Unavailable read-back keeps the unknown outcome and original intent.
                }
            }
        }
        // Retirement hides the projection, never rewrites an already-dispatched outcome.
        if (writeGeneration !== generation) return outcome;
        setState({
            pending: state.pending.filter((candidate) => candidate !== intent),
            failure: failure ?? state.failure,
        });
        return outcome;
    };

    const dispatch = (intent: WorkBoardIntentV1): Promise<WorkBoardSaveOutcome> => {
        const writeGeneration = generation;
        const failed = state.failure;
        const retryingAdd = intent.kind === 'widget_add' && failed?.reason === 'unavailable' && failed.intent.kind === 'widget_add'
            && failed.intent.boardId === intent.boardId && buildWorkBoardWidgetKeyV1(failed.intent.ref) === buildWorkBoardWidgetKeyV1(intent.ref);
        setState({ pending: [...state.pending, intent], failure: null });
        const result = tail.then(() => write(intent, writeGeneration, retryingAdd));
        tail = result.then(() => {});
        return result;
    };

    return {
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        dispatch,
        recordFailure(intent, reason) {
            setState({ ...state, failure: { intent, reason } });
        },
        retry() {
            const failed = state.failure;
            return failed ? dispatch(failed.intent) : Promise.resolve(null);
        },
        dismissFailure() {
            if (state.failure) setState({ ...state, failure: null });
        },
        reset() {
            generation += 1;
            setState(INITIAL_STATE);
        },
    };
}
