export type DiscussionVisibleReadController = Readonly<{
    updateEligibility(input: Readonly<{ activeAndVisible: boolean; lastReadSeq: number | null }>): void;
    observeVisibleMessageSeqs(seqs: readonly number[]): void;
}>;

export type DiscussionVisibleReadWriteOutcome =
    | Readonly<{ kind: 'succeeded'; lastReadSeq: number }>
    | Readonly<{ kind: 'retryable' }>
    | Readonly<{ kind: 'stopped' }>;

/**
 * The mounted Discussion surface's read-cursor choke point. Fetching or
 * decrypting a message never reaches this owner; only the actual list
 * viewability boundary supplies observed sequence numbers.
 */
export function createDiscussionVisibleReadController(input: Readonly<{
    writeCursor(lastReadSeq: number): Promise<DiscussionVisibleReadWriteOutcome>;
}>): DiscussionVisibleReadController {
    let activeAndVisible = false;
    let tracked = false;
    let highestVisibleSeq = 0;
    let confirmedReadSeq = 0;
    let submittedReadSeq = 0;
    let writeInFlight = false;

    const advance = (): void => {
        if (!activeAndVisible || !tracked || writeInFlight || highestVisibleSeq <= submittedReadSeq) return;
        const requestedSeq = highestVisibleSeq;
        const previousSubmittedSeq = submittedReadSeq;
        submittedReadSeq = requestedSeq;
        writeInFlight = true;
        let shouldContinue = false;
        void input.writeCursor(requestedSeq)
            .then((result) => {
                if (result.kind === 'stopped') {
                    tracked = false;
                    highestVisibleSeq = confirmedReadSeq;
                    submittedReadSeq = confirmedReadSeq;
                    return;
                }
                if (result.kind !== 'succeeded'
                    || !Number.isSafeInteger(result.lastReadSeq)
                    || result.lastReadSeq < requestedSeq) {
                    submittedReadSeq = Math.max(previousSubmittedSeq, confirmedReadSeq);
                    return;
                }
                // Another device may already have advanced the canonical cursor
                // beyond this viewport. This controller records only the exact
                // sequence it actually submitted after observing it foreground.
                confirmedReadSeq = Math.max(confirmedReadSeq, requestedSeq);
                submittedReadSeq = Math.max(submittedReadSeq, requestedSeq);
                shouldContinue = true;
            })
            .catch(() => {
                // Treat an unexpected transport exception as retryable. The
                // existing repository refresh/reconnect signal calls
                // updateEligibility again; no controller-owned timer or queue.
                submittedReadSeq = Math.max(previousSubmittedSeq, confirmedReadSeq);
            })
            .finally(() => {
                writeInFlight = false;
                if (shouldContinue) advance();
            });
    };

    return Object.freeze({
        updateEligibility(next): void {
            activeAndVisible = next.activeAndVisible;
            tracked = next.lastReadSeq !== null;
            if (next.lastReadSeq !== null) {
                confirmedReadSeq = Math.max(confirmedReadSeq, next.lastReadSeq);
                submittedReadSeq = Math.max(submittedReadSeq, next.lastReadSeq);
            } else {
                highestVisibleSeq = confirmedReadSeq;
                submittedReadSeq = confirmedReadSeq;
            }
            advance();
        },
        observeVisibleMessageSeqs(seqs): void {
            // Viewability callbacks may arrive while a retained Details surface
            // is mounted behind another tab or while the app is backgrounded.
            // Those observations are not proof the user saw the content and
            // must not be replayed when the surface later becomes foreground.
            if (!activeAndVisible || !tracked) return;
            for (const seq of seqs) {
                if (Number.isSafeInteger(seq) && seq > highestVisibleSeq) highestVisibleSeq = seq;
            }
            advance();
        },
    });
}
