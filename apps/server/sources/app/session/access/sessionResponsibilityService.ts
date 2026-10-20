import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

import { HOME_ACCOUNT_PAGE_LIMIT_DEFAULT_V1, HOME_ACCOUNT_PAGE_LIMIT_MAX_V1 } from '@happier-dev/protocol/home/governance';
import { decodeKeysetCursorV1, encodeKeysetCursorV1, readKeysetCursorIdV1 } from '@happier-dev/protocol/pagination/keysetCursorV1';
import { type AccountDisplayProfileV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import { type SessionAccessAccountSummaryV1 } from '@happier-dev/protocol/sessions/access/sessionAccessPrincipalV1';
import { type SessionResponsibilityCandidateAccessHintV1, type SessionResponsibilityCandidatePurposeV1, type SetSessionResponsibilityResponse } from '@happier-dev/protocol/sessions/access/sessionResponsibilityV1';

import {
    ACCOUNT_DISPLAY_PROFILE_SELECT,
    projectAccountDisplayProfileV1,
} from "@/app/account/profile/accountDisplayProfile";
import { buildAccountTextPrefixFilter } from "@/app/account/accountTextPrefixFilter";
import { scheduleSessionActivityRemoteAlerts } from "@/app/activity/remoteAlerts/submitSessionActivityRemoteAlerts";
import { markCurrentSessionReadersChanged } from "@/app/session/changeTracking/markCurrentSessionReadersChanged";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { scheduleSessionPersonalEvent } from "@/app/session/personal/publishPersonalEvent";
import { AccountStatus, getDbProviderFromEnv } from "@/storage/prisma";
import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { afterAccountChangePublication } from "@/app/changes/markAccountChanged";
import {
    assertSessionCapabilityInTx,
    resolveEffectiveSessionAccess,
    resolveStructuralSessionAccessForAccountsInTx,
    type EffectiveSessionAccess,
    type SessionCapability,
} from "./sessionAccess";
import { buildSessionReadableAccountWhereInTx } from "./sessionAccessWhere";
import { resolveCurrentSessionRecipientAccountIdsInTx } from "./sessionRecipients";
import type { SessionAccessAuthentication } from "./sessionAccessAuthentication";

type SessionResponsibilityAdmissionError =
    | "forbidden"
    | "not_found"
    | "session_access_authentication_required"
    | "session_access_authentication_unavailable";

export type SetSessionResponsibilityResult =
    | Readonly<{ ok: true } & SetSessionResponsibilityResponse>
    | Readonly<{ ok: false; error: SessionResponsibilityAdmissionError | "assignee_unavailable" }>;

async function admitSessionResponsibilityCapabilityInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        sessionId: string;
        capability: SessionCapability;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<Readonly<{ ok: true; access: EffectiveSessionAccess }> | Readonly<{ ok: false; error: SessionResponsibilityAdmissionError }>> {
    const admission = await assertSessionCapabilityInTx({ tx, ...params });
    if (admission.ok) return admission;
    if (admission.reason === "authentication_required") {
        return { ok: false, error: "session_access_authentication_required" };
    }
    if (admission.reason === "authentication_unavailable") {
        return { ok: false, error: "session_access_authentication_unavailable" };
    }

    // The capability owner deliberately coalesces an unreadable Session and a
    // readable Session without this capability as `unavailable`. Re-project
    // ordinary qualified read access only to preserve the route's non-disclosure
    // contract; capability and credential evidence remain owned above.
    const readable = await resolveEffectiveSessionAccess(tx, {
        accountId: params.accountId,
        sessionId: params.sessionId,
        authentication: params.authentication,
    });
    return readable?.capabilities.readTranscript === true
        ? { ok: false, error: "forbidden" }
        : { ok: false, error: "not_found" };
}

async function resolveAccessInTx(
    tx: Tx,
    sessionId: string,
    accountIds: readonly string[],
): Promise<ReadonlyMap<string, EffectiveSessionAccess | null>> {
    return await resolveStructuralSessionAccessForAccountsInTx(tx, {
        sessionId,
        accountIds,
    });
}

async function resolveResponsibleAccountSummaryInTx(
    tx: Tx,
    accountId: string | null,
): Promise<SessionAccessAccountSummaryV1 | null> {
    if (accountId === null) return null;
    const row = await tx.account.findUnique({
        where: { id: accountId },
        select: ACCOUNT_DISPLAY_PROFILE_SELECT,
    });
    if (!row) return null;
    const profile = projectAccountDisplayProfileV1(row);
    return { kind: "account" as const, accountId: row.id, ...profile };
}

async function isAssignableTargetInTx(
    tx: Tx,
    params: Readonly<{
        sessionId: string;
        accountId: string;
        access: ReadonlyMap<string, EffectiveSessionAccess | null>;
    }>,
): Promise<boolean> {
    if (params.access.get(params.accountId)?.capabilities.readTranscript !== true) return false;
    const account = await tx.account.findUnique({
        where: { id: params.accountId },
        select: { status: true },
    });
    return account?.status === AccountStatus.active;
}

/**
 * Sets the one human Account currently expected to handle a Session.
 *
 * Authority and target eligibility are both rechecked inside the committing
 * transaction through the canonical Session access owner, because access can
 * change between opening the picker and committing. The operation grants no
 * access: an Account that cannot already read the Session is refused.
 */
export async function setSessionResponsibility(params: Readonly<{
    actorAccountId: string;
    sessionId: string;
    responsibleAccountId: string | null;
    authentication: SessionAccessAuthentication;
}>): Promise<SetSessionResponsibilityResult> {
    const desired = params.responsibleAccountId;
    return await inTx(async (tx) => {
        await acquireSessionAccountCursorLocksInTx(tx, [params.sessionId]);
        const actor = await admitSessionResponsibilityCapabilityInTx(tx, {
            accountId: params.actorAccountId,
            sessionId: params.sessionId,
            capability: "assignResponsibility",
            authentication: params.authentication,
        });
        if (!actor.ok) return actor;

        const targetAccess = desired === null ? new Map<string, EffectiveSessionAccess | null>()
            : await resolveAccessInTx(tx, params.sessionId, [desired]);
        if (desired !== null && !await isAssignableTargetInTx(tx, {
            sessionId: params.sessionId,
            accountId: desired,
            access: targetAccess,
        })) {
            // One outcome for absent, inactive and inaccessible targets: distinguishing
            // them would make this mutation an Account and access-source oracle.
            return { ok: false as const, error: "assignee_unavailable" as const };
        }

        const session = await tx.session.findUnique({
            where: { id: params.sessionId },
            select: { responsibleAccountId: true },
        });
        if (!session) return { ok: false as const, error: "not_found" as const };

        const current = session.responsibleAccountId ?? null;
        if (current === desired) {
            return {
                ok: true as const,
                changed: false,
                responsibleAccountId: current,
                responsibleAccount: await resolveResponsibleAccountSummaryInTx(tx, current),
                autoFollowed: false,
            };
        }

        await tx.session.update({
            where: { id: params.sessionId },
            data: { responsibleAccountId: desired },
            select: { id: true },
        });
        const responsibleAccount = await resolveResponsibleAccountSummaryInTx(tx, desired);

        const autoFollowed = false;
        if (desired !== null) {
            // Relationship defaults are evaluated as rules at the occurrence.
            // Assignment itself remains a targeted notice; self-assignment
            // does not notify the actor about their own action.
            if (desired !== params.actorAccountId) {
                afterTx(tx, () => scheduleSessionActivityRemoteAlerts({
                    sessionId: params.sessionId,
                    event: "assigned",
                    targetAccountIds: [desired],
                    assignmentAutoFollowed: autoFollowed,
                }));
            }
        }

        // One broad content-safe wake for the Accounts that can currently read the
        // Session. It is synchronization, not notification eligibility.
        const readerCursors = await markCurrentSessionReadersChanged({
            tx,
            sessionId: params.sessionId,
            // The id/summary pair is one viewer-safe projection. Publishing
            // only the id can leave another device displaying the previous
            // assignee's name until a full list refresh.
            hint: { responsibleAccountId: desired, responsibleAccount },
        });

        if (desired !== null && desired !== params.actorAccountId) {
            const recipientChange = readerCursors.find(change => change.accountId === desired);
            if (recipientChange) {
                afterAccountChangePublication(tx, async () => scheduleSessionPersonalEvent(tx, desired, {
                    type: "session-personal-event",
                    sessionId: params.sessionId,
                    event: "assigned",
                    eventId: `assigned:${desired}:${recipientChange.resolveCursor()}`,
                    assignmentAutoFollowed: autoFollowed,
                }));
            }
        }

        return {
            ok: true as const,
            changed: true,
            responsibleAccountId: desired,
            responsibleAccount,
            autoFollowed,
        };
    }, { isolationLevel: "Serializable" /* Responsibility admission and access-change cleanup depend on the same assignment and eligibility reads. */ });
}

/**
 * Maintains `responsibleAccountId != null ⇒ that Account is active and can still
 * read the Session`, in the transaction that removed the access.
 *
 * It re-evaluates every current access source rather than reacting to the one
 * that disappeared, so an assignee who keeps another source stays responsible and
 * only a final loss clears. Regaining access later never resurrects the value.
 */
export async function clearSessionResponsibilityIfNoReadAccessInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
}>): Promise<Readonly<{ clearedAccountId: string | null }>> {
    const { tx, sessionId } = params;
    const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { responsibleAccountId: true },
    });
    const responsibleAccountId = session?.responsibleAccountId ?? null;
    if (responsibleAccountId === null) return { clearedAccountId: null };

    await acquireSessionAccountCursorLocksInTx(tx, [sessionId]);
    const access = await resolveAccessInTx(tx, sessionId, [responsibleAccountId]);
    if (await isAssignableTargetInTx(tx, { sessionId, accountId: responsibleAccountId, access })) {
        return { clearedAccountId: null };
    }

    await tx.session.update({
        where: { id: sessionId },
        data: { responsibleAccountId: null },
        select: { id: true },
    });
    await markCurrentSessionReadersChanged({
        tx,
        sessionId,
        hint: { responsibleAccountId: null, responsibleAccount: null },
    });
    return { clearedAccountId: responsibleAccountId };
}

/** Retained responsibility rows are cleanup resources even after access is lost. */
export async function readSessionResponsibilityRemovalSessionIdsInTx(tx: Tx, accountId: string): Promise<string[]> {
    return (await tx.session.findMany({ where: { responsibleAccountId: accountId }, select: { id: true } }))
        .map(session => session.id);
}

/**
 * Clears current responsibility as part of the Home Account removal transaction.
 * The caller owns permanent Account deletion or loss of active Account status in
 * this same transaction. Unlike losing one grant, global eligibility cannot be
 * preserved by another access source. Surviving readers must refresh even when
 * the foreign key would otherwise clear the pointer silently on deletion.
 */
export async function clearSessionResponsibilitiesForAccountRemovalInTx(
    tx: Tx,
    params: Readonly<{ accountId: string }>,
): Promise<void> {
    const sessionIds = await readSessionResponsibilityRemovalSessionIdsInTx(tx, params.accountId);
    if (sessionIds.length === 0) return;

    await acquireSessionAccountCursorLocksInTx(tx, sessionIds);
    await tx.session.updateMany({
        where: { responsibleAccountId: params.accountId },
        data: { responsibleAccountId: null },
    });
    for (const sessionId of sessionIds) {
        const accountIds = await resolveCurrentSessionRecipientAccountIdsInTx(tx, { sessionId });
        await markCurrentSessionReadersChanged({
            tx,
            sessionId,
            accountIds: accountIds.filter(accountId => accountId !== params.accountId),
            hint: { responsibleAccountId: null, responsibleAccount: null },
        });
    }
}

export type SessionResponsibilityCandidate = Readonly<{
    accountId: string;
    profile: AccountDisplayProfileV1;
    accessHint?: SessionResponsibilityCandidateAccessHintV1;
}>;

export type SessionResponsibilityCandidatesResult =
    | Readonly<{
        ok: true;
        candidates: readonly SessionResponsibilityCandidate[];
        nextCursor: string | null;
    }>
    | Readonly<{ ok: false; error: SessionResponsibilityAdmissionError | "invalid_cursor" }>;

const SESSION_RESPONSIBILITY_CANDIDATE_CURSOR_QUERY_V1 = "session-responsibility-candidates:v1";

function responsibilityCandidateCursorQueryKey(params: Readonly<{
    sessionId: string;
    purpose: SessionResponsibilityCandidatePurposeV1;
    query: string | undefined;
}>): string {
    const binding = createHash("sha256")
        .update(JSON.stringify([params.sessionId, params.purpose, params.query ?? null]))
        .digest("base64url");
    return `${SESSION_RESPONSIBILITY_CANDIDATE_CURSOR_QUERY_V1}:${binding}`;
}

function buildCandidateSearchWhere(query: string): Prisma.AccountWhereInput {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    return {
        OR: [
            { username: buildAccountTextPrefixFilter(query, provider) },
            { name: buildAccountTextPrefixFilter(query, provider) },
        ],
    };
}

/**
 * The bounded, authorized principal page the responsibility picker selects from.
 *
 * It is a projection of the canonical access owner's current reader set, not a
 * directory: an Account appears only while it can currently read this Session and
 * is active, and each row carries neutral identity plus the bounded access level
 * the actor is already authorized to see. The canonical inverse access predicate
 * is applied before search and pagination in this same transaction; discovery
 * never materializes the complete Session audience.
 */
export async function listSessionResponsibilityCandidates(params: Readonly<{
    actorAccountId: string;
    sessionId: string;
    purpose: SessionResponsibilityCandidatePurposeV1;
    query?: string;
    cursor?: string;
    limit?: number;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionResponsibilityCandidatesResult> {
    const limit = Math.min(
        Math.max(params.limit ?? HOME_ACCOUNT_PAGE_LIMIT_DEFAULT_V1, 1),
        HOME_ACCOUNT_PAGE_LIMIT_MAX_V1,
    );
    const trimmedQuery = params.query?.trim();
    const query = trimmedQuery ? trimmedQuery : undefined;

    return await inTx(async (tx) => {
        const sessionExists = await tx.session.findUnique({
            where: { id: params.sessionId },
            select: { id: true, archivedAt: true },
        });
        if (!sessionExists) return { ok: false as const, error: "not_found" as const };
        // Archived Sessions retain current responsibility and allow an
        // otherwise-authorized manager to assign/clear it. The candidate query
        // uses the same readable archived-Session admission as the mutation and
        // must not reject what the mutation accepts. Assignment never unarchives.

        const capability = params.purpose === "mention" ? "submitAgentInput" : "assignResponsibility";
        const actorAdmission = await admitSessionResponsibilityCapabilityInTx(tx, {
            accountId: params.actorAccountId,
            sessionId: params.sessionId,
            capability,
            authentication: params.authentication,
        });
        if (!actorAdmission.ok) return actorAdmission;
        if (params.purpose === "mention" && sessionExists.archivedAt !== null) {
            return { ok: false as const, error: "forbidden" as const };
        }
        // Mention discovery is authorized by the discussion input capability plus
        // Lane 05 discussion admission consumed by its picker, not by assignment
        // authority and not by a route-local creator exception.
        const cursorQueryKey = responsibilityCandidateCursorQueryKey({
            sessionId: params.sessionId,
            purpose: params.purpose,
            query,
        });
        const decodedCursor = params.cursor
            ? decodeKeysetCursorV1(params.cursor, cursorQueryKey)
            : null;
        const afterAccountId = decodedCursor?.status === "ok"
            ? readKeysetCursorIdV1(decodedCursor.parts[0])
            : null;
        if (params.cursor && afterAccountId === null) {
            return { ok: false as const, error: "invalid_cursor" as const };
        }

        const readableAccountWhere = await buildSessionReadableAccountWhereInTx({
            tx,
            sessionId: params.sessionId,
        });

        const rows = await tx.account.findMany({
            where: {
                AND: [
                    readableAccountWhere,
                    { status: AccountStatus.active },
                    ...(afterAccountId ? [{ id: { gt: afterAccountId } }] : []),
                    ...(query ? [buildCandidateSearchWhere(query)] : []),
                ],
            },
            orderBy: { id: "asc" },
            take: limit + 1,
            select: ACCOUNT_DISPLAY_PROFILE_SELECT,
        });

        const page = rows.slice(0, limit);
        const access = await resolveAccessInTx(tx, params.sessionId, page.map((row) => row.id));

        return {
            ok: true as const,
            candidates: page.map((row) => {
                const level = access.get(row.id)?.level;
                return {
                    accountId: row.id,
                    profile: projectAccountDisplayProfileV1(row),
                    ...(params.purpose === "assignment" && level ? { accessHint: level } : {}),
                };
            }),
            nextCursor: rows.length > limit && page[page.length - 1]
                ? encodeKeysetCursorV1({
                    queryKey: cursorQueryKey,
                    parts: [page[page.length - 1]!.id],
                })
                : null,
        };
    }, { isolationLevel: "Serializable" /* Responsibility admission and access-change cleanup depend on the same assignment and eligibility reads. */ });
}
