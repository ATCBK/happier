import { applySessionArchiveTransitionToFollowsInTx } from "@/app/session/follow/lifecycle";
import { applySessionArchiveTransitionToReportsToInTx } from "@/app/session/relations/sessionReportsToService";
import type { Tx } from "@/storage/inTx";
import { admitSessionLifecycleAutomationRunsTx } from "@/app/automations/automationSessionLifecycleAdmission";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";

/** The canonical transactional Session archive-state write and its Follow lifecycle. */
export async function transitionSessionArchiveStateInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    wasArchived: boolean;
    archivedAt: Date | null;
    meaningfulActivityAt?: Date;
    /** The HTTP owner has already verified this exact Run's Machine publisher. */
    originRunId?: string;
}>) {
    const relatedEdges = await params.tx.sessionReportsTo.findMany({
        where: { OR: [{ sessionId: params.sessionId }, { leadSessionId: params.sessionId }] },
        select: { sessionId: true, leadSessionId: true },
    });
    await acquireSessionAccountCursorLocksInTx(params.tx, [
        params.sessionId,
        ...relatedEdges.flatMap(edge => [edge.sessionId, edge.leadSessionId]),
    ], [], { includeLifecyclePublications: !params.wasArchived && params.archivedAt !== null });
    const session = await params.tx.session.update({
        where: { id: params.sessionId },
        data: {
            archivedAt: params.archivedAt,
            ...(params.meaningfulActivityAt
                ? { meaningfulActivityAt: params.meaningfulActivityAt }
                : {}),
        },
    });
    await applySessionArchiveTransitionToFollowsInTx({
        tx: params.tx,
        sessionId: params.sessionId,
        wasArchived: params.wasArchived,
        isArchived: params.archivedAt !== null,
    });
    await applySessionArchiveTransitionToReportsToInTx(params.tx, {
        sessionId: params.sessionId, wasArchived: params.wasArchived, isArchived: params.archivedAt !== null,
    });
    if (!params.wasArchived && params.archivedAt !== null) {
        await admitSessionLifecycleAutomationRunsTx({
            tx: params.tx,
            accountId: session.accountId,
            occurrence: {
                v: 1, kind: "sessionLifecycle", event: "sessionArchived",
                sourceSessionId: session.id, occurredAt: params.archivedAt.getTime(),
                ...(params.originRunId !== undefined ? { originRunId: params.originRunId } : {}),
            },
        });
    }
    return session;
}
