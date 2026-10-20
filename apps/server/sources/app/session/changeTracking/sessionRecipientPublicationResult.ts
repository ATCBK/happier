import { transactionResult, type TransactionResult } from "@/storage/inTx";
import {
    resolveSessionAccountChangePublications,
    type SessionAccountChangeCursor,
    type SessionAccountChangePublication,
} from "./markAccountChangesForSessionAccounts";

export type SessionRecipientPublicationResult<T> = T extends {
    recipientCursors: readonly SessionAccountChangeCursor[];
} ? Omit<T, "recipientCursors"> & {
    recipientCursors: readonly SessionAccountChangePublication[];
} & TransactionResult<T> : T;

/** Keep transaction-local fields available while explicitly projecting committed cursors. */
export function sessionRecipientPublicationResult<const T extends {
    recipientCursors: readonly SessionAccountChangePublication[];
}>(result: T): T & TransactionResult<Omit<T, "recipientCursors"> & {
    recipientCursors: SessionAccountChangeCursor[];
}> {
    return {
        ...result,
        ...transactionResult(() => ({
            ...result,
            recipientCursors: resolveSessionAccountChangePublications(result.recipientCursors),
        })),
    };
}
