import { z } from "zod/mini";
import { randomUUID } from "node:crypto";
import { readAccountNameFromLegacyProfileV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import type {
    DirectoryProjectionCatchUp,
    DirectoryProjectionCatchUpResult,
    DirectoryProjectionScan,
    DirectoryProjectionScanFailureCode,
    DirectoryProjectionScanResult,
} from "./directoryReconciler";
import type { ActiveWorkosDirectorySource, ClaimedDirectorySource } from "./directorySourceService";
import type { DirectoryGroup, DirectoryPerson } from "./directorySourceEvidence";
import { parseDirectoryRetryAfterMs, readUpstreamResponseHeader } from "./directorySourceProjection";

const PAGE_SIZE = 100;
const WORKOS_DIRECTORY_EVENT_TYPES = [
    "dsync.activated",
    "dsync.deleted",
    "dsync.group.created",
    "dsync.group.deleted",
    "dsync.group.updated",
    "dsync.group.user_added",
    "dsync.group.user_removed",
    "dsync.user.created",
    "dsync.user.deleted",
    "dsync.user.updated",
] as const;
type WorkosDirectoryEventName = typeof WORKOS_DIRECTORY_EVENT_TYPES[number];

const NonEmptyStringSchema = z.string().check(z.minLength(1));
const ExternalIdSchema = NonEmptyStringSchema.check(z.maxLength(256));
const ExternalSubjectSchema = z.string().check(z.maxLength(512));
const ExternalEmailSchema = z.string().check(z.maxLength(320));
const ExternalLabelSchema = z.string().check(z.maxLength(256));
const WorkosUserSchema = z.object({
    id: ExternalIdSchema,
    directoryId: ExternalIdSchema,
    organizationId: z.nullable(NonEmptyStringSchema.check(z.maxLength(512))),
    idpId: ExternalSubjectSchema,
    firstName: z.nullable(ExternalLabelSchema),
    lastName: z.nullable(ExternalLabelSchema),
    email: z.nullable(ExternalEmailSchema),
    state: z.enum(["active", "inactive"]),
    updatedAt: NonEmptyStringSchema,
});
const WorkosGroupSchema = z.object({
    id: ExternalIdSchema,
    directoryId: ExternalIdSchema,
    organizationId: z.nullable(NonEmptyStringSchema.check(z.maxLength(512))),
    name: ExternalLabelSchema.check(z.minLength(1)),
    updatedAt: NonEmptyStringSchema,
});
const WorkosDirectorySchema = z.object({
    id: ExternalIdSchema,
    organizationId: z.optional(NonEmptyStringSchema.check(z.maxLength(512))),
});
const WorkosEventEnvelopeSchema = z.object({
    id: ExternalIdSchema,
    event: NonEmptyStringSchema,
    data: z.unknown(),
});
const WorkosPageMetadataSchema = z.object({
    after: z.optional(z.nullable(NonEmptyStringSchema)),
});

type WorkosDirectoryPageOptions = Readonly<{
    directory?: string;
    group?: string;
    after?: string | null;
    limit?: number;
}>;
type WorkosEventsOptions = Readonly<{
    events: WorkosDirectoryEventName[];
    organizationId: string;
    order: "asc";
    limit: number;
    after?: string;
    rangeStart?: string;
}>;

export type WorkosDirectoryReadContext = Readonly<{
    organizationId: string;
    directoryId: string;
    listUsers: (options: WorkosDirectoryPageOptions) => Promise<unknown>;
    listGroups: (options: WorkosDirectoryPageOptions) => Promise<unknown>;
    listEvents: (options: WorkosEventsOptions) => Promise<unknown>;
}>;

function parseDate(value: string): Date | null {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeUser(
    value: unknown,
    context: WorkosDirectoryReadContext,
): DirectoryPerson | null {
    const parsed = WorkosUserSchema.safeParse(value);
    if (
        !parsed.success
        || parsed.data.directoryId !== context.directoryId
        || parsed.data.organizationId !== context.organizationId
    ) return null;
    const externalUpdatedAt = parseDate(parsed.data.updatedAt);
    if (!externalUpdatedAt) return null;
    const displayName = readAccountNameFromLegacyProfileV1(parsed.data) ?? "";
    if (displayName.length > 256) return null;
    const idpId = parsed.data.idpId;
    return {
        externalUserId: parsed.data.id,
        ...(idpId.length > 0 ? { externalSubjectId: idpId } : {}),
        ...(parsed.data.email === null ? {} : { email: parsed.data.email }),
        ...(displayName.length === 0 ? {} : { displayName }),
        active: parsed.data.state === "active",
        externalUpdatedAt,
    };
}

function normalizeGroup(
    value: unknown,
    context: WorkosDirectoryReadContext,
): DirectoryGroup | null {
    const parsed = WorkosGroupSchema.safeParse(value);
    if (
        !parsed.success
        || parsed.data.directoryId !== context.directoryId
        || parsed.data.organizationId !== context.organizationId
    ) return null;
    const externalUpdatedAt = parseDate(parsed.data.updatedAt);
    if (!externalUpdatedAt) return null;
    return {
        externalGroupId: parsed.data.id,
        displayName: parsed.data.name,
        externalUpdatedAt,
    };
}

function parsePage(value: unknown): Readonly<{
    data: readonly unknown[];
    nextCursor: string | null;
}> | null {
    if (typeof value !== "object" || value === null || !("data" in value) || !("listMetadata" in value)) {
        return null;
    }
    if (!Array.isArray(value.data)) return null;
    const metadata = WorkosPageMetadataSchema.safeParse(value.listMetadata);
    if (!metadata.success) return null;
    return { data: value.data, nextCursor: metadata.data.after ?? null };
}

function readHttpStatus(error: unknown): number | null {
    if (typeof error !== "object" || error === null) return null;
    if ("status" in error && typeof error.status === "number") return error.status;
    if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
    if ("response" in error && typeof error.response === "object" && error.response !== null) {
        const response = error.response;
        if ("status" in response && typeof response.status === "number") return response.status;
    }
    return null;
}

function readWorkosRetryAfterSeconds(error: unknown): unknown {
    return typeof error === "object" && error !== null && "retryAfter" in error
        ? error.retryAfter
        : undefined;
}

function mapWorkosError(error: unknown): DirectoryProjectionScanResult {
    const status = readHttpStatus(error);
    switch (status) {
        case 401:
        case 403:
            return { ok: false, code: "directory_source_permission_lost" };
        case 404:
            return { ok: false, code: "directory_source_identity_mismatch" };
        case 429: {
            // WorkOS' SDK parses `Retry-After` into
            // `RateLimitExceededException.retryAfter` (seconds) and builds no
            // `response` object at all, so the shared header reader finds
            // nothing on it. Read the SDK's own field first and keep the header
            // reader as the fallback for a raw transport error.
            const retryAfterMs = parseDirectoryRetryAfterMs(readWorkosRetryAfterSeconds(error))
                ?? parseDirectoryRetryAfterMs(readUpstreamResponseHeader(error, "retry-after"));
            return {
                ok: false,
                code: "directory_sync_rate_limited",
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            };
        }
        default:
            return status === null || status === 408 || status >= 500
                ? { ok: false, code: "directory_sync_unavailable" }
                : { ok: false, code: "directory_snapshot_incomplete" };
    }
}

function mapWorkosSnapshotRequestError(
    error: unknown,
    signal: AbortSignal | undefined,
    scope: "directory" | "group",
): DirectoryProjectionScanResult {
    if (signal?.aborted) return { ok: false, code: "stale_run" };
    if (readHttpStatus(error) === 404) {
        return scope === "directory"
            ? { ok: true, sourceDeleted: true }
            : { ok: false, code: "directory_source_identity_mismatch" };
    }
    return mapWorkosError(error);
}

/**
 * The stored event bookmark (`after`) or retention boundary (`rangeStart`) is
 * the only caller-supplied position on the Events request, so WorkOS rejecting
 * that request as malformed means the saved position is no longer usable. That
 * is the typed cursor-loss path (child 05 §8.4): it never silently skips
 * forward, and recovery is a new boundary plus a complete reconciliation.
 */
function mapWorkosEventsRequestError(
    error: unknown,
    signal: AbortSignal | undefined,
): DirectoryProjectionScanResult {
    if (signal?.aborted) return { ok: false, code: "stale_run" };
    const status = readHttpStatus(error);
    return status === 400 || status === 422
        ? { ok: false, code: "directory_cursor_expired" }
        : mapWorkosError(error);
}

async function readUsers(params: Readonly<{
    context: WorkosDirectoryReadContext;
    signal?: AbortSignal;
    groupId?: string;
    consume: (people: readonly DirectoryPerson[]) => Promise<boolean>;
}>): Promise<DirectoryProjectionScanResult> {
    let cursor: string | null = null;
    const visitedCursors = new Set<string>();
    do {
        if (params.signal?.aborted) return { ok: false, code: "stale_run" };
        let raw: unknown;
        try {
            raw = await params.context.listUsers({
                ...(params.groupId ? { group: params.groupId } : { directory: params.context.directoryId }),
                after: cursor,
                limit: PAGE_SIZE,
            });
        } catch (error) {
            return mapWorkosSnapshotRequestError(
                error,
                params.signal,
                params.groupId ? "group" : "directory",
            );
        }
        const page = parsePage(raw);
        if (!page) return { ok: false, code: "directory_snapshot_incomplete" };
        if (page.nextCursor !== null && visitedCursors.has(page.nextCursor)) {
            return { ok: false, code: "directory_snapshot_incomplete" };
        }
        if (page.nextCursor !== null) visitedCursors.add(page.nextCursor);
        const people = page.data.map((item) => normalizeUser(item, params.context));
        if (people.some((person) => person === null)) {
            return { ok: false, code: "directory_source_identity_mismatch" };
        }
        if (!await params.consume(people as readonly DirectoryPerson[])) {
            return { ok: false, code: "stale_run" };
        }
        cursor = page.nextCursor;
    } while (cursor !== null);
    return { ok: true };
}

export async function scanWorkosDirectorySnapshot(params: Readonly<{
    context: WorkosDirectoryReadContext;
    signal?: AbortSignal;
    writePeoplePage: Parameters<DirectoryProjectionScan>[0]["writePeoplePage"];
    writeGroupsPage: Parameters<DirectoryProjectionScan>[0]["writeGroupsPage"];
    writeGroupMembersPage: Parameters<DirectoryProjectionScan>[0]["writeGroupMembersPage"];
}>): Promise<DirectoryProjectionScanResult> {
    const people = await readUsers({
        context: params.context,
        signal: params.signal,
        consume: params.writePeoplePage,
    });
    if (!people.ok || people.sourceDeleted) return people;

    let cursor: string | null = null;
    const visitedCursors = new Set<string>();
    do {
        if (params.signal?.aborted) return { ok: false, code: "stale_run" };
        let raw: unknown;
        try {
            raw = await params.context.listGroups({
                directory: params.context.directoryId,
                after: cursor,
                limit: PAGE_SIZE,
            });
        } catch (error) {
            return mapWorkosSnapshotRequestError(error, params.signal, "directory");
        }
        const page = parsePage(raw);
        if (!page) return { ok: false, code: "directory_snapshot_incomplete" };
        if (page.nextCursor !== null && visitedCursors.has(page.nextCursor)) {
            return { ok: false, code: "directory_snapshot_incomplete" };
        }
        if (page.nextCursor !== null) visitedCursors.add(page.nextCursor);
        const groups = page.data.map((item) => normalizeGroup(item, params.context));
        if (groups.some((group) => group === null)) {
            return { ok: false, code: "directory_source_identity_mismatch" };
        }
        const normalizedGroups = groups as readonly DirectoryGroup[];
        if (!await params.writeGroupsPage(normalizedGroups)) return { ok: false, code: "stale_run" };

        for (const group of normalizedGroups) {
            const members = await readUsers({
                context: params.context,
                signal: params.signal,
                groupId: group.externalGroupId,
                consume: async (groupPeople) => {
                    if (!await params.writePeoplePage(groupPeople)) return false;
                    return await params.writeGroupMembersPage(groupPeople.map((person) => ({
                        externalGroupId: group.externalGroupId,
                        externalUserId: person.externalUserId,
                    })));
                },
            });
            if (!members.ok || members.sourceDeleted) return members;
        }

        cursor = page.nextCursor;
    } while (cursor !== null);
    return { ok: true };
}

type PreparedEvent =
    | Readonly<{ status: "advance"; delta: Parameters<Parameters<DirectoryProjectionCatchUp>[0]["writeWorkosEvent"]>[0] }>
    | Readonly<{ status: "source_deleted" }>
    | Readonly<{
        status: "invalid";
        code: DirectoryProjectionScanFailureCode;
        reconcileRunId?: string;
        retryAfterMs?: number;
    }>;

function isSameDirectory(
    value: Readonly<{ directoryId: string; organizationId: string | null }>,
    context: WorkosDirectoryReadContext,
): boolean {
    return value.directoryId === context.directoryId && value.organizationId === context.organizationId;
}

async function prepareEvent(params: Readonly<{
    envelope: z.infer<typeof WorkosEventEnvelopeSchema>;
    context: WorkosDirectoryReadContext;
    signal?: AbortSignal;
    expectedPosition: Parameters<Parameters<DirectoryProjectionCatchUp>[0]["writeWorkosEvent"]>[0]["expectedPosition"];
    stageWorkosGroupMembersEventPage: Parameters<DirectoryProjectionCatchUp>[0]["stageWorkosGroupMembersEventPage"];
}>): Promise<PreparedEvent> {
    const base = { expectedPosition: params.expectedPosition, eventId: params.envelope.id } as const;
    switch (params.envelope.event) {
        case "dsync.activated": {
            const directory = WorkosDirectorySchema.safeParse(params.envelope.data);
            if (!directory.success) return { status: "invalid", code: "directory_snapshot_incomplete" };
            return { status: "advance", delta: base };
        }
        case "dsync.deleted": {
            const directory = WorkosDirectorySchema.safeParse(params.envelope.data);
            if (!directory.success) return { status: "invalid", code: "directory_snapshot_incomplete" };
            if (
                directory.data.id !== params.context.directoryId
                || directory.data.organizationId !== params.context.organizationId
            ) return { status: "advance", delta: base };
            return { status: "source_deleted" };
        }
        case "dsync.user.created":
        case "dsync.user.updated":
        case "dsync.user.deleted": {
            const user = WorkosUserSchema.safeParse(params.envelope.data);
            if (!user.success) return { status: "invalid", code: "directory_snapshot_incomplete" };
            if (!isSameDirectory(user.data, params.context)) return { status: "advance", delta: base };
            const person = normalizeUser(user.data, params.context);
            if (!person) return { status: "invalid", code: "directory_source_identity_mismatch" };
            return params.envelope.event === "dsync.user.deleted"
                ? { status: "advance", delta: { ...base, deletedPeople: [person] } }
                : { status: "advance", delta: { ...base, people: [person] } };
        }
        case "dsync.group.created":
        case "dsync.group.updated":
        case "dsync.group.deleted": {
            const group = WorkosGroupSchema.safeParse(params.envelope.data);
            if (!group.success) return { status: "invalid", code: "directory_snapshot_incomplete" };
            if (!isSameDirectory(group.data, params.context)) return { status: "advance", delta: base };
            const normalized = normalizeGroup(group.data, params.context);
            if (!normalized) return { status: "invalid", code: "directory_source_identity_mismatch" };
            return params.envelope.event === "dsync.group.deleted"
                ? { status: "advance", delta: { ...base, deletedGroups: [normalized] } }
                : { status: "advance", delta: { ...base, groups: [normalized] } };
        }
        case "dsync.group.user_added":
        case "dsync.group.user_removed": {
            const attemptId = randomUUID();
            const membership = z.object({
                directoryId: NonEmptyStringSchema,
                user: WorkosUserSchema,
                group: WorkosGroupSchema,
            }).safeParse(params.envelope.data);
            if (!membership.success) return { status: "invalid", code: "directory_snapshot_incomplete" };
            if (
                membership.data.directoryId !== params.context.directoryId
                || !isSameDirectory(membership.data.user, params.context)
                || !isSameDirectory(membership.data.group, params.context)
            ) return { status: "advance", delta: base };

            // Claim the fresh attempt before the first external roster page.
            // The active-source repository uses this empty stage to install
            // activeReconcileRunId, so a provider failure before page one can
            // still be recorded against the exact attempt and cannot leave the
            // source looking authoritative. Full-run catch-up already owns the
            // outer fence; the same call remains a harmless currentness check.
            if (!await params.stageWorkosGroupMembersEventPage({
                expectedPosition: params.expectedPosition,
                eventId: params.envelope.id,
                attemptId,
                externalGroupId: membership.data.group.id,
                people: [],
            })) return { status: "invalid", code: "stale_run", reconcileRunId: attemptId };

            const current = await readUsers({
                context: params.context,
                signal: params.signal,
                groupId: membership.data.group.id,
                consume: async (people) => {
                    return await params.stageWorkosGroupMembersEventPage({
                        expectedPosition: params.expectedPosition,
                        eventId: params.envelope.id,
                        attemptId,
                        externalGroupId: membership.data.group.id,
                        people,
                    });
                },
            });
            if (!current.ok) {
                return {
                    status: "invalid",
                    code: current.code,
                    reconcileRunId: attemptId,
                    // The roster read's provider Retry-After (child 05 §9).
                    ...(current.retryAfterMs === undefined ? {} : { retryAfterMs: current.retryAfterMs }),
                };
            }
            return {
                status: "advance",
                delta: {
                    ...base,
                    attemptId,
                    replaceGroupMembers: [{
                        externalGroupId: membership.data.group.id,
                    }],
                },
            };
        }
        default:
            return { status: "advance", delta: base };
    }
}

export async function consumeWorkosDirectoryEvents(params: Readonly<{
    source: ClaimedDirectorySource | ActiveWorkosDirectorySource;
    context: WorkosDirectoryReadContext;
    signal?: AbortSignal;
    writeWorkosEvent: Parameters<DirectoryProjectionCatchUp>[0]["writeWorkosEvent"];
    stageWorkosGroupMembersEventPage: Parameters<DirectoryProjectionCatchUp>[0]["stageWorkosGroupMembersEventPage"];
}>): Promise<DirectoryProjectionCatchUpResult> {
    if (params.source.kind !== "workos_directory") {
        return { ok: false, code: "directory_source_identity_mismatch" };
    }
    let expectedPosition: Parameters<Parameters<DirectoryProjectionCatchUp>[0]["writeWorkosEvent"]>[0]["expectedPosition"];
    let after: string | undefined;
    let rangeStart: string | undefined;
    if (params.source.eventCursor !== null) {
        expectedPosition = { eventCursor: params.source.eventCursor };
        after = params.source.eventCursor;
    } else if (params.source.eventRangeStart !== null) {
        expectedPosition = { eventCursor: null, eventRangeStart: params.source.eventRangeStart };
        rangeStart = params.source.eventRangeStart.toISOString();
    } else {
        return { ok: false, code: "directory_snapshot_incomplete" };
    }
    const visitedCursors = new Set<string>(after === undefined ? [] : [after]);
    for (;;) {
        if (params.signal?.aborted) return { ok: false, code: "stale_run" };
        let raw: unknown;
        try {
            raw = await params.context.listEvents({
                events: [...WORKOS_DIRECTORY_EVENT_TYPES],
                organizationId: params.context.organizationId,
                order: "asc",
                limit: PAGE_SIZE,
                ...(after ? { after } : {}),
                ...(rangeStart ? { rangeStart } : {}),
            });
        } catch (error) {
            return mapWorkosEventsRequestError(error, params.signal);
        }
        const page = parsePage(raw);
        if (!page) return { ok: false, code: "directory_snapshot_incomplete" };
        if (page.data.length === 0) {
            return page.nextCursor === null
                ? { ok: true }
                : { ok: false, code: "directory_snapshot_incomplete" };
        }

        const envelopes: z.infer<typeof WorkosEventEnvelopeSchema>[] = [];
        const pageEventIds = new Set<string>();
        for (const value of page.data) {
            const envelope = WorkosEventEnvelopeSchema.safeParse(value);
            if (!envelope.success) return { ok: false, code: "directory_snapshot_incomplete" };
            if (
                envelope.data.id === after
                || pageEventIds.has(envelope.data.id)
            ) return { ok: false, code: "directory_snapshot_incomplete" };
            pageEventIds.add(envelope.data.id);
            envelopes.push(envelope.data);
        }
        const lastEventId = envelopes[envelopes.length - 1]?.id;
        if (lastEventId === undefined || (page.nextCursor !== null && page.nextCursor !== lastEventId)) {
            return { ok: false, code: "directory_snapshot_incomplete" };
        }
        if (visitedCursors.has(lastEventId)) {
            return { ok: false, code: "directory_snapshot_incomplete" };
        }
        visitedCursors.add(lastEventId);

        for (const envelope of envelopes) {
            const prepared = await prepareEvent({
                envelope,
                context: params.context,
                signal: params.signal,
                expectedPosition,
                stageWorkosGroupMembersEventPage: params.stageWorkosGroupMembersEventPage,
            });
            if (prepared.status === "source_deleted") {
                return { ok: true, sourceDeleted: true };
            }
            if (prepared.status === "invalid") return {
                ok: false,
                code: prepared.code,
                ...(prepared.reconcileRunId === undefined ? {} : { reconcileRunId: prepared.reconcileRunId }),
                ...(prepared.retryAfterMs === undefined ? {} : { retryAfterMs: prepared.retryAfterMs }),
            };
            if (!await params.writeWorkosEvent(prepared.delta)) return { ok: false, code: "stale_run" };
            expectedPosition = { eventCursor: envelope.id };
            after = envelope.id;
            rangeStart = undefined;
        }
    }
}
