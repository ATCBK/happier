import { isDeepStrictEqual } from "node:util";
import { inTx, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { readPendingActivationControllerAccountIdsInTx } from "./pendingActivationAuthorization";
import { readCurrentCommittedSessionInputMachineTargetInTx } from "@/app/session/messages/sessionInputAdmission";

export async function inPendingQueuePositionTx<T>(
    sessionId: string,
    fn: (tx: Tx) => Promise<T>,
    targetMachineId?: string,
): Promise<T> {
    return inTx(async (tx) => {
        const committedTarget = targetMachineId === undefined
            ? await readCurrentCommittedSessionInputMachineTargetInTx(tx, sessionId) : undefined;
        const candidateMachineId = targetMachineId ?? committedTarget?.machineId;
        const controllerAccountIds = await readPendingActivationControllerAccountIdsInTx(tx, candidateMachineId);
        // Publication and mode-bound writers share Account→Session order.
        // Keep every recipient cursor fenced before admission begins, including
        // a different Session's heartbeat on the same Account.
        await acquireSessionAccountCursorLocksInTx(tx, [sessionId], controllerAccountIds);
        const currentCommittedTarget = targetMachineId === undefined
            ? await readCurrentCommittedSessionInputMachineTargetInTx(tx, sessionId) : undefined;
        const currentControllerAccountIds = await readPendingActivationControllerAccountIdsInTx(
            tx, targetMachineId ?? currentCommittedTarget?.machineId,
        );
        // Admission below reads current placement again. A changed placement
        // must replay before Session locking can turn a new lower Account into
        // an inversion against another publisher's ordered acquisition.
        if (!isDeepStrictEqual(committedTarget, currentCommittedTarget)
            || !isDeepStrictEqual(controllerAccountIds, currentControllerAccountIds)) {
            throw new TransactionReplayRequiredError("pending-activation-target-changed");
        }
        if (getDbProviderFromEnv(process.env, "postgres") === "postgres") {
            await tx.$queryRawUnsafe('SELECT "id" FROM "Session" WHERE "id" = $1 FOR NO KEY UPDATE', sessionId);
        }
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
