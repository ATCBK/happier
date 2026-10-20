import { resolveCurrentSessionRecipientAccountIdsInTx } from "@/app/session/access/sessionRecipients";
import type { Tx } from "@/storage/inTx";
import {
    markAccountChangesForSessionAccounts,
    type SessionAccountChangeCursor,
    type SessionAccountChangePublication,
} from "./markAccountChangesForSessionAccounts";

export type CurrentSessionReaderCursor = SessionAccountChangeCursor;
export type CurrentSessionReaderPublication = SessionAccountChangePublication;

/**
 * Wakes every Account that currently reads this Session for a Session-owned
 * domain that is not the primary transcript.
 *
 * Discussion availability follows Session access, not transcript publication:
 * a Session whose transcript is unpublished still has collaborators who must
 * see its discussions, so this deliberately does not route through the
 * transcript publication filter.
 *
 * The reader set itself is resolved by the canonical Session participant owner;
 * this wrapper adds no membership rule of its own.
 */
export async function markCurrentSessionReadersChanged(params: {
    tx: Tx;
    sessionId: string;
    hint?: unknown;
    accountIds?: readonly string[];
}): Promise<CurrentSessionReaderPublication[]> {
    const accountIds = params.accountIds ?? await resolveCurrentSessionRecipientAccountIdsInTx(
        params.tx,
        { sessionId: params.sessionId },
    );

    return await markAccountChangesForSessionAccounts({
        tx: params.tx,
        sessionId: params.sessionId,
        accountIds,
        hint: params.hint,
    });
}
