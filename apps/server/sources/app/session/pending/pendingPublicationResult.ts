import {
    resolveSessionAccountChangePublications,
    type SessionAccountChangePublication,
} from "@/app/session/changeTracking/markAccountChangesForSessionAccounts";
import { transactionResult, type TransactionResult } from "@/storage/inTx";
import type { PendingActivationPublicationTarget, PendingActivationTarget } from "./pendingActivationAuthorization";

type PendingCursorField = "recipientCursors" | "recipientCursorsPending" | "recipientCursorsMessage";

/** Pending domain results retain publication handles until their outer transaction finishes. */
export type PendingPublicationFields<T> = T extends unknown ? {
    [K in keyof T]: K extends PendingCursorField
        ? SessionAccountChangePublication[]
        : K extends "activationTarget" ? PendingActivationPublicationTarget | Extract<T[K], undefined> : T[K];
} : never;

type PendingPublications = {
    recipientCursors?: SessionAccountChangePublication[];
    recipientCursorsPending?: SessionAccountChangePublication[];
    recipientCursorsMessage?: SessionAccountChangePublication[];
    activationTarget?: PendingActivationPublicationTarget;
};

function resolveActivationTarget(target: PendingActivationPublicationTarget): PendingActivationTarget {
    const { managedControllerPublication: publication, ...activation } = target;
    return {
        ...activation,
        ...(publication ? {
            managedControllerPublication: { accountId: publication.accountId, cursor: publication.resolveCursor() },
        } : {}),
    };
}

/** Explicitly projects the Pending result fields after terminal Account publication. */
export async function pendingPublicationResult<T extends object>(
    operation: () => Promise<PendingPublicationFields<T>>,
): Promise<TransactionResult<T>> {
    const result = await operation();
    const publications = result as PendingPublications;
    return transactionResult(() => ({
        ...result,
        ...(publications.recipientCursors ? {
            recipientCursors: resolveSessionAccountChangePublications(publications.recipientCursors),
        } : {}),
        ...(publications.recipientCursorsPending ? {
            recipientCursorsPending: resolveSessionAccountChangePublications(publications.recipientCursorsPending),
        } : {}),
        ...(publications.recipientCursorsMessage ? {
            recipientCursorsMessage: resolveSessionAccountChangePublications(publications.recipientCursorsMessage),
        } : {}),
        ...(publications.activationTarget ? {
            activationTarget: resolveActivationTarget(publications.activationTarget),
        } : {}),
    }) as T);
}
