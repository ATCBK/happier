import { isDeepStrictEqual } from "node:util";
import { inTx, TransactionReplayRequiredError, type ResolvedTransactionResult, type Tx } from "@/storage/inTx";
import { assertAccountChangePublicationAudienceInTx, beforeAccountChangePublication } from "@/app/changes/markAccountChanged";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { readPendingActivationControllerAccountIdsInTx } from "./pendingActivationAuthorization";
import { readCurrentCommittedSessionInputMachineTargetInTx } from "@/app/session/messages/sessionInputAdmission";

export async function inPendingQueuePositionTx<T>(
    sessionId: string,
    fn: (tx: Tx) => Promise<T>,
    targetMachineId?: string,
    readAdditionalPublicationAccountsInTx?: (tx: Tx) => Promise<readonly string[]>,
): Promise<ResolvedTransactionResult<T>> {
    return inTx(async (tx) => {
        const committedTarget = targetMachineId === undefined
            ? await readCurrentCommittedSessionInputMachineTargetInTx(tx, sessionId) : undefined;
        const candidateMachineId = targetMachineId ?? committedTarget?.machineId;
        const controllerAccountIds = await readPendingActivationControllerAccountIdsInTx(tx, candidateMachineId);
        // Admit the complete Account audience, then serialize Pending work at
        // the canonical Session resource fence. Publication remains terminal.
        const additionalAccountIds = await readAdditionalPublicationAccountsInTx?.(tx) ?? [];
        await acquireSessionAccountCursorLocksInTx(tx, [sessionId], [...controllerAccountIds, ...additionalAccountIds]);
        const currentCommittedTarget = targetMachineId === undefined
            ? await readCurrentCommittedSessionInputMachineTargetInTx(tx, sessionId) : undefined;
        const currentControllerAccountIds = await readPendingActivationControllerAccountIdsInTx(
            tx, targetMachineId ?? currentCommittedTarget?.machineId,
        );
        // Admission below reads current placement again. A changed placement
        // must replay before Session locking can turn a new lower Account into
        // an inversion against another publisher's ordered acquisition.
        if (!isDeepStrictEqual(committedTarget, currentCommittedTarget)
            || !isDeepStrictEqual(controllerAccountIds, currentControllerAccountIds)
            || !isDeepStrictEqual(additionalAccountIds, await readAdditionalPublicationAccountsInTx?.(tx) ?? [])) {
            throw new TransactionReplayRequiredError("pending-activation-target-changed");
        }
        const admittedExtraAccounts = new Set([...controllerAccountIds, ...additionalAccountIds]);
        beforeAccountChangePublication(tx, [...admittedExtraAccounts], async client => {
            const target = targetMachineId === undefined
                ? await readCurrentCommittedSessionInputMachineTargetInTx(client, sessionId) : undefined;
            const controllers = await readPendingActivationControllerAccountIdsInTx(client, targetMachineId ?? target?.machineId);
            const additional = await readAdditionalPublicationAccountsInTx?.(client) ?? [];
            assertAccountChangePublicationAudienceInTx(client, [...controllers, ...additional]);
        });
        return fn(tx);
    }, { transactionClass: "pending-input-admission" });
}

export async function reserveNextPendingQueuePosition(tx: Tx, sessionId: string): Promise<number> {
    const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { pendingQueueSeq: true },
    });

    const highestQueued = await tx.sessionPendingMessage.findFirst({
        where: { sessionId, status: "queued" },
        orderBy: [{ position: "desc" }, { createdAt: "desc" }, { localId: "desc" }],
        select: { position: true },
    });

    const normalizedPendingQueueSeq = Math.max(session?.pendingQueueSeq ?? 0, highestQueued?.position ?? 0);
    if ((session?.pendingQueueSeq ?? 0) !== normalizedPendingQueueSeq) {
        await tx.session.update({
            where: { id: sessionId },
            data: { pendingQueueSeq: normalizedPendingQueueSeq },
        });
    }

    const updated = await tx.session.update({
        where: { id: sessionId },
        data: { pendingQueueSeq: { increment: 1 } },
        select: { pendingQueueSeq: true },
    });

    return updated.pendingQueueSeq;
}
