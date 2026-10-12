import { createHash } from "node:crypto";
import {
    decodeTeamKeysetCursorV1,
    encodeTeamKeysetCursorV1,
    readTeamKeysetIdV1,
    readTeamKeysetTimeV1,
    TeamCredentialActivityKindV1Schema,
    type TeamCredentialActivityKindV1,
} from "@happier-dev/protocol/teams";
import type { Tx } from "@/storage/inTx";
import { resolveAccountDisplayLabelV1 } from "@/app/account/profile/accountDisplayProfile";
import { resolveTeamActorContextInTx, type TeamOperationAuthenticationContext } from "../actorContext";
import { resolveTeamCredentialCapabilities } from "../capabilities";
import { qualifyTeamCredentialOperationInTx } from "./resourceRead";

type ActivityCursor = Readonly<{ createdAt: number; id: string }>;

function directDeliveryActivityId(resourceId: string, recipientAccountId: string): string {
    const digest = createHash("sha256")
        .update(JSON.stringify([resourceId, recipientAccountId]), "utf8")
        .digest("base64url");
    return `team-credential-direct-delivered:${digest}`;
}

function activityCursorQueryKey(resourceId: string): string {
    return `team-credential-activity:v1:${resourceId}`;
}

function encodeActivityCursor(input: ActivityCursor, resourceId: string): string {
    return encodeTeamKeysetCursorV1({
        queryKey: activityCursorQueryKey(resourceId),
        parts: [input.createdAt, input.id],
    });
}

function decodeActivityCursor(value: string, resourceId: string): ActivityCursor | null {
    const decoded = decodeTeamKeysetCursorV1(value, activityCursorQueryKey(resourceId));
    if (decoded.status !== "ok") return null;
    const createdAt = readTeamKeysetTimeV1(decoded.parts[0]);
    const id = readTeamKeysetIdV1(decoded.parts[1]);
    return createdAt === null || id === null ? null : { createdAt, id };
}

export type ReadTeamCredentialActivityResult =
    | Readonly<{ ok: true; page: { items: readonly Readonly<{
        kind: TeamCredentialActivityKindV1;
        actorDisplayName: string | null;
        subjectDisplayName: string;
        createdAt: string;
    }>[]; nextCursor: string | null } }>
    | Readonly<{ ok: false; error: "resource_not_found" | "resource_forbidden" | "invalid_resource_input" | "team_authentication_required" | "team_authentication_policy_unavailable" }>;

/** Reads the narrow metadata history through the same Team capability owner as mutations. */
export async function readTeamCredentialActivityInTx(
    tx: Tx,
    input: Readonly<{ resourceId: string; actorAccountId: string; cursor?: string; limit?: number; authentication: TeamOperationAuthenticationContext }>,
): Promise<ReadTeamCredentialActivityResult> {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !input.resourceId.trim()) {
        return { ok: false, error: "invalid_resource_input" };
    }
    const live = await tx.teamCredentialResource.findUnique({
        where: { id: input.resourceId },
        select: { teamId: true },
    });
    const historical = live ? null : await tx.teamCredentialActivityEvent.findFirst({
        where: { resourceId: input.resourceId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { teamId: true },
    });
    const teamId = live?.teamId ?? historical?.teamId;
    if (!teamId) return { ok: false, error: "resource_not_found" };
    const actor = await resolveTeamActorContextInTx(tx, { teamId, actorAccountId: input.actorAccountId });
    if (!actor || !resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt }).manageCredentials) {
        return { ok: false, error: "resource_forbidden" };
    }
    const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, input.authentication);
    if (!qualification.ok) return qualification;
    const cursor = input.cursor === undefined ? null : decodeActivityCursor(input.cursor, input.resourceId);
    if (input.cursor !== undefined && cursor === null) return { ok: false, error: "invalid_resource_input" };
    const rows = await tx.teamCredentialActivityEvent.findMany({
        where: {
            resourceId: input.resourceId,
            ...(cursor ? {
                OR: [
                    { createdAt: { lt: new Date(cursor.createdAt) } },
                    { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
                ],
            } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
        select: {
            id: true, kind: true, subjectDisplayName: true, createdAt: true,
            actorAccount: { select: { name: true, username: true } },
        },
    });
    const page = rows.slice(0, limit);
    const items = page.map(row => ({
        kind: TeamCredentialActivityKindV1Schema.parse(row.kind),
        actorDisplayName: row.actorAccount
            ? resolveAccountDisplayLabelV1(row.actorAccount)
            : null,
        subjectDisplayName: row.subjectDisplayName,
        createdAt: row.createdAt.toISOString(),
    }));
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last
        ? encodeActivityCursor({ createdAt: last.createdAt.getTime(), id: last.id }, input.resourceId)
        : null;
    return { ok: true, page: { items, nextCursor } };
}

export const TeamCredentialActivityKindSchema = TeamCredentialActivityKindV1Schema;

export type TeamCredentialActivityActor =
    | Readonly<{ kind: "account"; accountId: string }>
    | Readonly<{ kind: "system" }>;

/** Records only public administrative context in the transaction that changes it. */
export async function recordTeamCredentialActivityInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        resourceId: string;
        kind: TeamCredentialActivityKindV1;
        actor: TeamCredentialActivityActor;
        subjectDisplayName: string;
    }>,
): Promise<void> {
    await tx.teamCredentialActivityEvent.create({ data: {
        teamId: input.teamId,
        resourceId: input.resourceId,
        kind: TeamCredentialActivityKindSchema.parse(input.kind),
        actorAccountId: input.actor.kind === "account" ? input.actor.accountId : null,
        subjectDisplayName: input.subjectDisplayName,
    } });
}

/**
 * Records the first irreversible disclosure for one resource recipient.
 * The existing Activity primary key is the idempotency owner, so concurrent
 * successful opens converge without a delivery ledger or acknowledgement.
 */
export async function recordTeamCredentialDirectDeliveryActivityInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        resourceId: string;
        recipientAccountId: string;
        subjectDisplayName: string;
    }>,
): Promise<void> {
    await tx.teamCredentialActivityEvent.upsert({
        where: { id: directDeliveryActivityId(input.resourceId, input.recipientAccountId) },
        update: {},
        create: {
            id: directDeliveryActivityId(input.resourceId, input.recipientAccountId),
            teamId: input.teamId,
            resourceId: input.resourceId,
            kind: "direct_delivered",
            actorAccountId: input.recipientAccountId,
            subjectDisplayName: input.subjectDisplayName,
        },
    });
}

/**
 * Whether usable material of this resource was ever delivered to anyone. Once
 * it has been, use outside Happier is possible and unknowable, whatever the
 * current audience says. Retained metadata only, like the per-recipient read.
 */
export async function hasTeamCredentialResourceDirectDeliveryActivityInTx(
    tx: Tx,
    input: Readonly<{ resourceId: string }>,
): Promise<boolean> {
    return (await tx.teamCredentialActivityEvent.findFirst({
        where: { resourceId: input.resourceId, kind: "direct_delivered" },
        select: { id: true },
    })) !== null;
}

/** Reads only the retained metadata fact; live authority remains resource-owned. */
export async function hasTeamCredentialDirectDeliveryActivityInTx(
    tx: Tx,
    input: Readonly<{ resourceId: string; recipientAccountId: string }>,
): Promise<boolean> {
    return (await tx.teamCredentialActivityEvent.findUnique({
        where: { id: directDeliveryActivityId(input.resourceId, input.recipientAccountId) },
        select: { id: true },
    })) !== null;
}
