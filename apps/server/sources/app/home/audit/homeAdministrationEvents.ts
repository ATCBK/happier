import { decodeKeysetCursorV1, encodeKeysetCursorV1, readKeysetCursorIdV1, readKeysetCursorTimeV1 } from '@happier-dev/protocol/pagination/keysetCursorV1';
import { HOME_AUDIT_PAGE_LIMIT_DEFAULT_V1, HomeAdministrationTargetKindV1Schema, parseHomeAdministrationEventDetailV1, type HomeAdministrationActorKindV1, type HomeAdministrationEventDetailV1, type HomeAdministrationEventV1, type HomeAdministrationTargetKindV1, type HomeAuditListResultV1 } from '@happier-dev/protocol/home/governance';

import {
    ACCOUNT_DISPLAY_PROFILE_SELECT,
    projectAccountDisplayProfileV1,
} from "@/app/account/profile/accountDisplayProfile";
import type { Tx } from "@/storage/inTx";

/**
 * The Home administration audit trail (plan `2026-09-26-home-owner-console` §3.9).
 *
 * The writer runs inside the transaction of the mutation it records, so an event exists exactly
 * when its change committed. Callers pass the typed detail; its summary shape is the protocol's
 * strict per-action schema, which never carries a secret value.
 */
export type HomeAdministrationActor =
    | Readonly<{ kind: "account"; accountId: string }>
    | Readonly<{ kind: Exclude<HomeAdministrationActorKindV1, "account"> }>;

export type HomeAdministrationTarget = Readonly<{ kind: HomeAdministrationTargetKindV1; id: string }>;

export async function recordHomeAdministrationEventInTx(
    tx: Tx,
    input: Readonly<{
        actor: HomeAdministrationActor;
        target: HomeAdministrationTarget | null;
        detail: HomeAdministrationEventDetailV1;
    }>,
): Promise<void> {
    await tx.homeAdministrationEvent.create({
        data: {
            actorKind: input.actor.kind,
            actorAccountId: input.actor.kind === "account" ? input.actor.accountId : null,
            action: input.detail.action,
            targetKind: input.target?.kind ?? null,
            targetId: input.target?.id ?? null,
            summary: input.detail.summary as object,
        },
        select: { id: true },
    });
}

const HOME_AUDIT_CURSOR_QUERY_V1 = "home-audit:v1";
type HomeAuditCursor = Readonly<{ at: number; id: string }>;

function encodeHomeAuditCursor(cursor: HomeAuditCursor): string {
    return encodeKeysetCursorV1({ queryKey: HOME_AUDIT_CURSOR_QUERY_V1, parts: [cursor.at, cursor.id] });
}

function decodeHomeAuditCursor(cursor: string): HomeAuditCursor | null {
    const decoded = decodeKeysetCursorV1(cursor, HOME_AUDIT_CURSOR_QUERY_V1);
    if (decoded.status !== "ok") return null;
    const at = readKeysetCursorTimeV1(decoded.parts[0]);
    const id = readKeysetCursorIdV1(decoded.parts[1]);
    return at === null || id === null ? null : { at, id };
}

function isActorKind(value: string): value is HomeAdministrationActorKindV1 {
    return value === "account" || value === "deployment_command" || value === "personal_home_bootstrap";
}

function isTargetKind(value: string): value is HomeAdministrationTargetKindV1 {
    return HomeAdministrationTargetKindV1Schema.safeParse(value).success;
}

export type HomeAuditListResult =
    | Readonly<{ status: "ok"; result: HomeAuditListResultV1 }>
    | Readonly<{ status: "invalid_cursor" }>;

/**
 * Newest first over `(at, id)`, optionally about one target. The caller authorizes
 * (`viewAdministration`). A stored row whose summary no longer parses is skipped rather than
 * projected loosely: the strict summary is the disclosure contract.
 */
export async function listHomeAdministrationEventsInTx(
    tx: Tx,
    input: Readonly<{ cursor?: string | null; limit?: number; targetId?: string }>,
): Promise<HomeAuditListResult> {
    const limit = input.limit ?? HOME_AUDIT_PAGE_LIMIT_DEFAULT_V1;
    const before = input.cursor ? decodeHomeAuditCursor(input.cursor) : null;
    if (input.cursor && !before) return { status: "invalid_cursor" };

    const rows = await tx.homeAdministrationEvent.findMany({
        where: {
            ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
            ...(before
                ? {
                    OR: [
                        { at: { lt: new Date(before.at) } },
                        { at: new Date(before.at), id: { lt: before.id } },
                    ],
                }
                : {}),
        },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        take: limit + 1,
    });
    const page = rows.slice(0, limit);

    const accountIds = new Set<string>();
    for (const row of page) {
        if (row.actorAccountId) accountIds.add(row.actorAccountId);
        if (row.targetKind === "account" && row.targetId) accountIds.add(row.targetId);
    }
    const accounts = accountIds.size === 0
        ? []
        : await tx.account.findMany({
            where: { id: { in: [...accountIds] } },
            select: ACCOUNT_DISPLAY_PROFILE_SELECT,
        });
    const profiles = new Map(accounts.map((account) => [account.id, projectAccountDisplayProfileV1(account)]));

    const items: HomeAdministrationEventV1[] = [];
    for (const row of page) {
        const detail = parseHomeAdministrationEventDetailV1(row.action, row.summary);
        if (!detail || !isActorKind(row.actorKind)) continue;
        const targetKind = row.targetKind !== null && isTargetKind(row.targetKind) ? row.targetKind : null;
        items.push({
            id: row.id,
            at: row.at.getTime(),
            actor: {
                kind: row.actorKind,
                accountId: row.actorAccountId,
                profile: row.actorAccountId ? profiles.get(row.actorAccountId) ?? null : null,
            },
            target: targetKind && row.targetId
                ? {
                    kind: targetKind,
                    id: row.targetId,
                    profile: targetKind === "account" ? profiles.get(row.targetId) ?? null : null,
                }
                : null,
            ...detail,
        } as HomeAdministrationEventV1);
    }
    const last = page.length === limit ? page[page.length - 1] : undefined;
    return {
        status: "ok",
        result: {
            items,
            nextCursor: rows.length > limit && last ? encodeHomeAuditCursor({ at: last.at.getTime(), id: last.id }) : null,
        },
    };
}
