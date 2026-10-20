import { afterTx, type Tx } from "@/storage/inTx";
import type { AccountChangePublication } from "@/app/changes/markAccountChanged";
import { scheduleSessionPersonalEvent } from "@/app/session/personal/publishPersonalEvent";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { projectAccountNameToLegacyFieldsV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import {
    buildSessionSharedUpdate,
    buildSessionShareRevokedUpdate,
    buildSessionShareUpdatedUpdate,
    eventRouter,
} from "@/app/events/eventRouter";
import type {
    SessionAccessDirectShareRow,
    SessionAccessGrantEffects,
} from "./sessionAccessGrantService";

/**
 * The released direct-share socket events, projected from committed access state.
 *
 * These three events are a compatibility hint for clients that predate the
 * effective-access projection. They are derived here from the canonical before/after
 * result rather than from "a row was written", because a released client treats
 * `session-share-revoked` as deleting the whole Session locally. Emitting one because
 * a direct row disappeared, while a Team or Group grant still admits the reader,
 * would destroy a still-authorized client's local state.
 *
 * Two rules follow from the released payloads themselves and are load-bearing:
 * every event needs a real `SessionShare.id`, and no event may claim authority the
 * direct row does not carry. A pure Team/Group grant or membership change therefore
 * emits nothing and converges through AccountChange plus the current projection.
 */
export type ReleasedDirectShareEvent =
    | Readonly<{ kind: "shared"; share: SessionAccessDirectShareRow }>
    | Readonly<{ kind: "updated"; share: SessionAccessDirectShareRow }>
    | Readonly<{ kind: "revoked"; shareId: string; sessionId: string }>;

export function projectReleasedDirectShareEvent(
    input: Readonly<{
        recipientAccountId: string;
        effects: SessionAccessGrantEffects;
        /** The surviving direct row after a set, or the removed row after a delete. */
        directShare: SessionAccessDirectShareRow | null;
        directShareRemoved: boolean;
    }>,
): ReleasedDirectShareEvent | null {
    const { recipientAccountId, effects, directShare } = input;
    if (!directShare) return null;

    if (effects.revokedAccountIds.includes(recipientAccountId)) {
        return { kind: "revoked", shareId: directShare.id, sessionId: directShare.sessionId };
    }
    // Effective access survived. A released `updated` event carries the direct row's
    // own level and id, so once that row is gone there is nothing truthful to send.
    if (input.directShareRemoved) return null;
    if (effects.grantedAccountIds.includes(recipientAccountId)) {
        return { kind: "shared", share: directShare };
    }
    if (effects.changedAccountIds.includes(recipientAccountId)) {
        return { kind: "updated", share: directShare };
    }
    return null;
}

/**
 * The one personal fact a direct share produces (Lane 09 brief item 16).
 *
 * Access never creates tracking, unread or notifications by itself. A **new**
 * direct grant is the single exception: it is a relevance entry carrying exactly
 * one targeted `directly_shared` event for the granted recipient, at effective
 * notification level `none`. Level changes on a surviving row, revocations, and
 * Team or Group grants carry no direct-share fact at all — collective access is
 * a non-event, not a quieter share.
 *
 * The event is derived from the same projected before/after result as the
 * released socket events, so the "is this a genuinely new direct grant" decision
 * stays with the one owner that already makes it. The live socket router checks
 * current recipient authority; this fact is not an OS alert candidate.
 */
export function projectDirectSharePersonalEvent(
    event: ReleasedDirectShareEvent | null,
): Readonly<{ sessionId: string; event: "directly_shared"; targetAccountIds: readonly string[]; sourceAccountId: string }> | null {
    if (event?.kind !== "shared") return null;
    return {
        sessionId: event.share.sessionId,
        event: "directly_shared",
        targetAccountIds: [event.share.sharedWithUserId],
        // The granter performed the action; it is never their own event.
        sourceAccountId: event.share.sharedByUserId,
    };
}

export type ReleasedDirectShareSenderProfile = Readonly<{
    id: string;
    name: string | null;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    avatar: unknown;
}>;

/**
 * Schedule the projected released event, and a new grant's one personal
 * `directly_shared` event, after commit.
 *
 * Nothing is emitted from inside the transaction: an event that escaped a rolled
 * back transaction would tell a client about access it does not have.
 */
export function scheduleReleasedDirectShareEvent(
    tx: Tx,
    params: Readonly<{
        recipientAccountId: string;
        publication: AccountChangePublication | undefined;
        event: ReleasedDirectShareEvent | null;
        sharedByUser: ReleasedDirectShareSenderProfile | null;
    }>,
): void {
    const { event } = params;
    if (!event) return;

    const eventId = randomKeyNaked(12);
    const personalEvent = projectDirectSharePersonalEvent(event);
    if (personalEvent) {
        for (const accountId of personalEvent.targetAccountIds) {
            if (accountId === personalEvent.sourceAccountId) continue;
            scheduleSessionPersonalEvent(tx, accountId, {
                type: "session-personal-event",
                sessionId: personalEvent.sessionId,
                event: personalEvent.event,
                eventId,
            });
        }
    }

    afterTx(tx, () => {
        const cursor = params.publication?.resolveCursor() ?? 0;
        const payload = event.kind === "revoked"
            ? buildSessionShareRevokedUpdate(
                event.shareId,
                event.sessionId,
                cursor,
                eventId,
            )
            : event.kind === "shared"
                ? buildSessionSharedUpdate(
                    {
                        id: event.share.id,
                        sessionId: event.share.sessionId,
                        sharedByUser: {
                            id: params.sharedByUser?.id ?? event.share.sharedByUserId,
                            ...projectAccountNameToLegacyFieldsV1(params.sharedByUser?.name ?? null),
                            username: params.sharedByUser?.username ?? null,
                            avatar: params.sharedByUser?.avatar ?? null,
                        },
                        accessLevel: event.share.accessLevel,
                        canApprovePermissions: event.share.canApprovePermissions,
                        createdAt: event.share.createdAt,
                    },
                    cursor,
                    eventId,
                )
                : buildSessionShareUpdatedUpdate(
                    event.share.id,
                    event.share.sessionId,
                    event.share.accessLevel,
                    event.share.canApprovePermissions,
                    event.share.updatedAt,
                    cursor,
                    eventId,
                );

        eventRouter.emitUpdate({
            userId: params.recipientAccountId,
            payload,
            recipientFilter: { type: "all-user-authenticated-connections" },
        });
    });
}
