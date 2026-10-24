import type { Tx } from '@/storage/inTx';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { buildSessionAccessWhere } from '@/app/session/access/sessionAccessWhere';
import { resolveSessionAccessForOperation } from '@/app/session/access/sessionAccess';
import { buildSessionMessagePublicationWhere, loadSessionTranscriptPublication, isExternalShareableSessionTurnVisible } from '@/app/session/sessionTranscriptPublicationPolicy';
import { parseStoredSessionTurn } from '@/app/session/turns/parseSessionTurnState';
import { projectSessionMessageAccountActors } from './projectSessionMessageAccountActors';

/** Exact committed reads share transcript publication and current credential admission. */
export async function readCommittedSessionMessageInTx(tx: Tx, input: Readonly<{
    accountId: string;
    sessionId: string;
    authentication: SessionAccessAuthentication;
    /** Current publisher locality from the existing server owner, never client input. */
    targetMachineId?: string | null;
}> & (Readonly<{ messageId: string }> | Readonly<{ localId: string }>)) {
    const accessDecision = await resolveSessionAccessForOperation(tx, { accountId: input.accountId,
        sessionId: input.sessionId, authentication: input.authentication, capability: 'readTranscript',
        apiTokenAction: { actionId: 'session.transcript.get', targetMachineId: input.targetMachineId } });
    if (accessDecision.status !== 'allowed') return { row: null, accessDecision, accountActor: null };
    const publication = await loadSessionTranscriptPublication(tx, input.sessionId);
    const row = await tx.sessionMessage.findFirst({
        where: buildSessionMessagePublicationWhere({
            where: {
                sessionId: input.sessionId,
                ...('messageId' in input ? { id: input.messageId } : { localId: input.localId }),
                session: { AND: [{ id: input.sessionId }, await buildSessionAccessWhere({ tx, accountId: input.accountId,
                    capability: 'readTranscript', mode: 'effective_access_v1', authentication: input.authentication })] },
            },
            publication,
        }),
        select: {
            id: true, seq: true, localId: true, sidechainId: true, messageRole: true, content: true,
            deliveryResolution: true, acceptedTurnKind: true, acceptedTurnId: true, turnStartWitnessId: true,
            createdAt: true, updatedAt: true, sourceCreatedAt: true, sourceUpdatedAt: true,
            transcriptObservationProvenance: true, inputAdmissionReceipt: true, authorAccountId: true,
        },
    });
    const turnRow = 'localId' in input && row?.turnStartWitnessId ? await tx.sessionTurn.findUnique({ where: {
        sessionId_turnId: { sessionId: input.sessionId, turnId: row.turnStartWitnessId },
    } }) : null;
    const turn = turnRow && isExternalShareableSessionTurnVisible({ row: turnRow, publication })
        ? parseStoredSessionTurn(turnRow) : null;
    return {
        row: row ? { ...row, turn } : null,
        accessDecision,
        accountActor: row ? (await projectSessionMessageAccountActors(tx, [row]))[0] ?? null : null,
    };
}
