import { AutonomousExchangeStateV1Schema, applyAutonomousExchangeAcceptedTurnV1 } from '@happier-dev/protocol/sessions/messages/autonomousExchangeV1';
import { isAutonomousExchangeRootReceiptForAccount } from '@/app/session/messages/readAutonomousExchangeSourceRoot';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { TransactionReplayRequiredError, type Tx } from '@/storage/inTx';

/** Join host-accepted input to the canonical started Turn, whichever persisted first. */
export async function reconcileAutonomousExchangeAcceptedTurnInTx(
    tx: Tx,
    params: Readonly<{ sessionId: string; turnId: string; startingInputId?: string }>,
): Promise<void> {
    const started = await tx.sessionTurn.findUnique({
        where: { sessionId_turnId: { sessionId: params.sessionId, turnId: params.turnId } },
        select: { id: true },
    });
    if (!started) return;
    if (params.startingInputId) {
        // Pending remains the exact original-input custody owner until retirement.
        // ACK and Turn begin can arrive in either order, so stamp whichever row exists.
        await tx.sessionPendingMessage.updateMany({
            where: { sessionId: params.sessionId, localId: params.startingInputId,
                targetExecutionRunId: null, turnStartWitnessId: null },
            data: { turnStartWitnessId: params.turnId },
        });
        await tx.sessionMessage.updateMany({
            where: { sessionId: params.sessionId, localId: params.startingInputId,
                targetExecutionRunId: null, turnStartWitnessId: null },
            data: { turnStartWitnessId: params.turnId },
        });
    }
    const inputs = await tx.sessionMessage.findMany({
        where: { sessionId: params.sessionId, acceptedTurnId: params.turnId,
            targetExecutionRunId: null, turnStartWitnessId: params.turnId,
            acceptedTurnCounted: false, autonomousExchangeCause: 'agent_session',
            autonomousExchangeRootSessionId: { not: null },
            autonomousExchangeRootLocalId: { not: null },
            acceptedTurnKind: { in: ['newTurn', 'followUp'] },
        },
        select: { id: true, acceptedTurnKind: true,
            autonomousExchangeRootSessionId: true, autonomousExchangeRootLocalId: true },
        orderBy: { seq: 'asc' },
    });
    for (const input of inputs) {
        const rootSessionId = input.autonomousExchangeRootSessionId;
        const rootLocalId = input.autonomousExchangeRootLocalId;
        if (!rootSessionId || !rootLocalId || !input.acceptedTurnKind) continue;
        const duplicate = await tx.sessionMessage.findFirst({
            where: { sessionId: params.sessionId, acceptedTurnId: params.turnId,
                targetExecutionRunId: null,
                acceptedTurnCounted: true, autonomousExchangeRootSessionId: rootSessionId,
                autonomousExchangeRootLocalId: rootLocalId },
            select: { id: true },
        });
        if (duplicate) continue;
        const root = await tx.sessionMessage.findUnique({
            where: { sessionId_localId: { sessionId: rootSessionId, localId: rootLocalId } },
            select: { id: true, rowRevision: true, inputAdmissionReceipt: true,
                autonomousExchangeState: true, session: { select: { accountId: true } } },
        });
        const session = await tx.session.findUnique({ where: { id: params.sessionId }, select: { accountId: true } });
        // Only the receiving Account's root can count its native starts. A
        // foreign cause carries neither its actor nor its private preference.
        if (!root || !session || root.session.accountId !== session.accountId
            || !isAutonomousExchangeRootReceiptForAccount(root.inputAdmissionReceipt, session.accountId, rootSessionId)) continue;
        const parsedState = createStoredReadSchema(AutonomousExchangeStateV1Schema).safeParse(root.autonomousExchangeState);
        if (!parsedState.success) continue;
        const next = applyAutonomousExchangeAcceptedTurnV1(parsedState.data, {
            cause: 'agent_session', deliveryKind: input.acceptedTurnKind === 'followUp' ? 'followUp' : 'newTurn',
            turnId: params.turnId, startsNewTurn: true,
        });
        const updated = await tx.sessionMessage.updateMany({
            where: { id: root.id, rowRevision: root.rowRevision },
            data: { autonomousExchangeState: next, rowRevision: { increment: BigInt(1) } },
        });
        if (updated.count !== 1) throw new TransactionReplayRequiredError('autonomous-exchange-root-changed');
        await tx.sessionMessage.update({ where: { id: input.id }, data: { acceptedTurnCounted: true } });
    }
}
