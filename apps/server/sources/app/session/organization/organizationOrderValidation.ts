import type { ReorderSessionOrganizationRequest } from '@happier-dev/protocol/sessions/organization/mutations';

import { buildSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import { createVisibleUnarchivedOrganizationSessionWhere } from "./sessionVisibility";
import type { SessionOrganizationTx } from "./types";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";

type OrderEntityReader = SessionOrganizationTx;

interface OrderEntryLike {
    readonly scopeKind: string;
    readonly scopeKey: string;
    readonly itemKind: string;
    readonly itemKey: string;
}

interface ActiveOrderEntitySets {
    readonly sessionIds: ReadonlySet<string>;
    readonly folderIds: ReadonlySet<string>;
    readonly tagIds: ReadonlySet<string>;
}

function unique(values: readonly string[]): string[] {
    return Array.from(new Set(values));
}

function collectServerOwnedOrderEntityIds(entries: readonly OrderEntryLike[]) {
    return {
        sessionIds: unique(entries
            .filter((entry) => entry.itemKind === "session")
            .map((entry) => entry.itemKey)),
        folderIds: unique(entries
            .flatMap((entry) => [
                ...(entry.scopeKind === "folder" ? [entry.scopeKey] : []),
                ...(entry.itemKind === "folder" ? [entry.itemKey] : []),
            ])),
        tagIds: unique(entries
            .flatMap((entry) => [
                ...(entry.scopeKind === "tag" ? [entry.scopeKey] : []),
                ...(entry.itemKind === "tag" ? [entry.itemKey] : []),
            ])),
    };
}

async function fetchActiveOrderEntitySets(params: Readonly<{
    accountId: string;
    entries: readonly OrderEntryLike[];
    reader: OrderEntityReader;
    authentication: SessionAccessAuthentication;
}>): Promise<ActiveOrderEntitySets> {
    const { sessionIds, folderIds, tagIds } = collectServerOwnedOrderEntityIds(params.entries);

    const [sessions, folders, tags] = await Promise.all([
        sessionIds.length > 0
            ? params.reader.session.findMany({
                where: {
                    AND: [{ id: { in: sessionIds } }, await buildSessionAccessWhere({ tx: params.reader, accountId: params.accountId, capability: 'readTranscript', mode: 'effective_access_v1', authentication: params.authentication })],
                },
                select: { id: true },
            })
            : Promise.resolve([]),
        folderIds.length > 0
            ? params.reader.sessionOrganizationFolder.findMany({
                where: { accountId: params.accountId, id: { in: folderIds }, archivedAt: null },
                select: { id: true },
            })
            : Promise.resolve([]),
        tagIds.length > 0
            ? params.reader.sessionOrganizationTag.findMany({
                where: { accountId: params.accountId, id: { in: tagIds }, archivedAt: null },
                select: { id: true },
            })
            : Promise.resolve([]),
    ]);

    return {
        sessionIds: new Set(sessions.map((session) => session.id)),
        folderIds: new Set(folders.map((folder) => folder.id)),
        tagIds: new Set(tags.map((tag) => tag.id)),
    };
}

function isOrderEntryValidForActiveEntities(entry: OrderEntryLike, active: ActiveOrderEntitySets): boolean {
    if (entry.scopeKind === "pinned") return false;
    if (entry.scopeKind === "folder" && !active.folderIds.has(entry.scopeKey)) return false;
    if (entry.scopeKind === "tag" && !active.tagIds.has(entry.scopeKey)) return false;
    if (entry.itemKind === "session" && !active.sessionIds.has(entry.itemKey)) return false;
    if (entry.itemKind === "folder" && !active.folderIds.has(entry.itemKey)) return false;
    if (entry.itemKind === "tag" && !active.tagIds.has(entry.itemKey)) return false;
    return true;
}

export async function validateSessionOrganizationOrderRequest(params: Readonly<{
    accountId: string;
    reader: OrderEntityReader;
    request: ReorderSessionOrganizationRequest;
    authentication: SessionAccessAuthentication;
}>): Promise<boolean> {
    const entries = params.request.entries.length > 0
        ? params.request.entries.map((entry) => ({
            scopeKind: params.request.scopeKind,
            scopeKey: params.request.scopeKey,
            itemKind: entry.itemKind,
            itemKey: entry.itemKey,
        }))
        : [{
            scopeKind: params.request.scopeKind,
            scopeKey: params.request.scopeKey,
            itemKind: "group" as const,
            itemKey: params.request.scopeKey,
        }];
    const active = await fetchActiveOrderEntitySets({
        accountId: params.accountId,
        entries,
        reader: params.reader,
        authentication: params.authentication,
    });
    return entries.every((entry) => isOrderEntryValidForActiveEntities(entry, active));
}

export async function validateSessionOrganizationSessionOrderItems(params: Readonly<{
    accountId: string;
    reader: OrderEntityReader;
    entries: ReorderSessionOrganizationRequest["entries"];
    authentication: SessionAccessAuthentication;
}>): Promise<boolean> {
    if (params.entries.some((entry) => entry.itemKind !== "session")) return false;

    const entries = params.entries.map((entry) => ({
        scopeKind: "group" as const,
        scopeKey: "session-order-validation",
        itemKind: entry.itemKind,
        itemKey: entry.itemKey,
    }));
    const sessionIds = unique(entries.map((entry) => entry.itemKey));
    const sessions = sessionIds.length > 0
        ? await params.reader.session.findMany({
            where: {
                id: { in: sessionIds },
                ...await createVisibleUnarchivedOrganizationSessionWhere(params.reader, params.accountId, params.authentication),
            },
            select: { id: true },
        })
        : [];
    const visibleUnarchivedSessionIds = new Set(sessions.map((session) => session.id));
    return entries.every((entry) => visibleUnarchivedSessionIds.has(entry.itemKey));
}

export async function filterValidSessionOrganizationOrderEntries<T extends OrderEntryLike>(params: Readonly<{
    accountId: string;
    entries: readonly T[];
    reader: OrderEntityReader;
    authentication: SessionAccessAuthentication;
}>): Promise<T[]> {
    if (params.entries.length === 0) return [];

    const active = await fetchActiveOrderEntitySets({
        accountId: params.accountId,
        entries: params.entries,
        reader: params.reader,
        authentication: params.authentication,
    });
    return params.entries.filter((entry) => isOrderEntryValidForActiveEntities(entry, active));
}
