import { RateLimitExceededException } from "@workos-inc/node";
import { describe, expect, it, vi } from "vitest";
import type { ClaimedDirectorySource } from "./directorySourceService";
import {
    consumeWorkosDirectoryEvents,
    scanWorkosDirectorySnapshot,
    type WorkosDirectoryReadContext,
} from "./workosDirectoryReader";

function page(data: readonly unknown[], after: string | null = null) {
    return { object: "list", data, listMetadata: { after } };
}

function user(id: string) {
    return {
        id,
        directoryId: "directory_1",
        organizationId: "org_1",
        idpId: `idp_${id}`,
        firstName: id === "user_1" ? "Alice" : "Bob",
        lastName: "Example",
        email: `${id}@example.com`,
        state: "active",
        updatedAt: "2026-09-05T10:00:00.000Z",
    };
}

function group() {
    return {
        id: "group_1",
        directoryId: "directory_1",
        organizationId: "org_1",
        name: "Engineering",
        updatedAt: "2026-09-05T10:00:00.000Z",
    };
}

function source(): ClaimedDirectorySource {
    return {
        id: "source_1",
        teamId: "team_1",
        kind: "workos_directory",
        binding: { v: 1, kind: "workos_directory", workosDirectoryId: "directory_1" },
        reconcileRunId: "run_1",
        eventCursor: null,
        eventRangeStart: new Date("2026-09-05T09:00:00.000Z"),
        observedManualSyncRequestedAt: null,
    };
}

describe("WorkOS directory reader", () => {
    it("preserves opaque identity subjects byte-for-byte", async () => {
        const exactSubject = "  IdP-Subject  ";
        const writePeoplePage = vi.fn(async () => true);
        await expect(scanWorkosDirectorySnapshot({
            context: {
                organizationId: "org_1",
                directoryId: "directory_1",
                listUsers: vi.fn(async () => page([{ ...user("user_1"), idpId: exactSubject,
                    firstName: "  Alice ", lastName: " Example  " }])),
                listGroups: vi.fn(async () => page([])),
                listEvents: vi.fn(),
            },
            writePeoplePage,
            writeGroupsPage: vi.fn(async () => true),
            writeGroupMembersPage: vi.fn(async () => true),
        })).resolves.toEqual({ ok: true });
        expect(writePeoplePage).toHaveBeenCalledWith([
            expect.objectContaining({ externalSubjectId: exactSubject, displayName: "Alice Example" }),
        ]);
    });

    it("streams bounded user, group, and filtered membership pages", async () => {
        const listUsers = vi.fn(async (options: { directory?: string; group?: string; after?: string | null }) => {
            if (options.group) return page([user("user_1")]);
            if (options.after === null) return page([user("user_1")], "users_next");
            return page([user("user_2")]);
        });
        const context: WorkosDirectoryReadContext = {
            organizationId: "org_1",
            directoryId: "directory_1",
            listUsers,
            listGroups: vi.fn(async () => page([group()])),
            listEvents: vi.fn(),
        };
        const writePeoplePage = vi.fn(async () => true);
        const writeGroupsPage = vi.fn(async () => true);
        const writeGroupMembersPage = vi.fn(async () => true);

        await expect(scanWorkosDirectorySnapshot({
            context,
            writePeoplePage,
            writeGroupsPage,
            writeGroupMembersPage,
        })).resolves.toEqual({ ok: true });

        expect(writePeoplePage).toHaveBeenNthCalledWith(1, [{
            externalUserId: "user_1",
            externalSubjectId: "idp_user_1",
            email: "user_1@example.com",
            displayName: "Alice Example",
            active: true,
            externalUpdatedAt: new Date("2026-09-05T10:00:00.000Z"),
        }]);
        expect(writePeoplePage).toHaveBeenNthCalledWith(2, [expect.objectContaining({ externalUserId: "user_2" })]);
        expect(writeGroupsPage).toHaveBeenCalledWith([{
            externalGroupId: "group_1",
            displayName: "Engineering",
            externalUpdatedAt: new Date("2026-09-05T10:00:00.000Z"),
        }]);
        expect(writeGroupMembersPage).toHaveBeenCalledWith([{
            externalGroupId: "group_1",
            externalUserId: "user_1",
        }]);
    });

    it("rejects a non-adjacent user-page cursor cycle before reapplying the repeated page", async () => {
        const listUsers = vi.fn()
            .mockResolvedValueOnce(page([user("user_1")], "users_a"))
            .mockResolvedValueOnce(page([user("user_2")], "users_b"))
            .mockResolvedValueOnce(page([user("user_1")], "users_a"))
            .mockRejectedValueOnce(new Error("reader must stop before following a repeated cursor"));
        const writePeoplePage = vi.fn(async () => true);

        await expect(scanWorkosDirectorySnapshot({
            context: {
                organizationId: "org_1",
                directoryId: "directory_1",
                listUsers,
                listGroups: vi.fn(),
                listEvents: vi.fn(),
            },
            writePeoplePage,
            writeGroupsPage: vi.fn(async () => true),
            writeGroupMembersPage: vi.fn(async () => true),
        })).resolves.toEqual({ ok: false, code: "directory_snapshot_incomplete" });
        expect(listUsers).toHaveBeenCalledTimes(3);
        expect(writePeoplePage).toHaveBeenCalledTimes(2);
    });

    it("rejects a non-adjacent group-page cursor cycle before reapplying the repeated page", async () => {
        const listGroups = vi.fn()
            .mockResolvedValueOnce(page([{ ...group(), id: "group_1" }], "groups_a"))
            .mockResolvedValueOnce(page([{ ...group(), id: "group_2" }], "groups_b"))
            .mockResolvedValueOnce(page([{ ...group(), id: "group_1" }], "groups_a"))
            .mockRejectedValueOnce(new Error("reader must stop before following a repeated cursor"));
        const writeGroupsPage = vi.fn(async () => true);

        await expect(scanWorkosDirectorySnapshot({
            context: {
                organizationId: "org_1",
                directoryId: "directory_1",
                listUsers: vi.fn(async () => page([])),
                listGroups,
                listEvents: vi.fn(),
            },
            writePeoplePage: vi.fn(async () => true),
            writeGroupsPage,
            writeGroupMembersPage: vi.fn(async () => true),
        })).resolves.toEqual({ ok: false, code: "directory_snapshot_incomplete" });
        expect(listGroups).toHaveBeenCalledTimes(3);
        expect(writeGroupsPage).toHaveBeenCalledTimes(2);
    });

    it("rejects a non-adjacent Group-member cursor cycle before restaging the repeated roster page", async () => {
        const listUsers = vi.fn(async (options: { group?: string; after?: string | null }) => {
            if (!options.group) return page([]);
            if (listUsers.mock.calls.filter(([call]) => call.group).length === 1) {
                return page([user("user_1")], "members_a");
            }
            if (listUsers.mock.calls.filter(([call]) => call.group).length === 2) {
                return page([user("user_2")], "members_b");
            }
            if (listUsers.mock.calls.filter(([call]) => call.group).length === 3) {
                return page([user("user_1")], "members_a");
            }
            throw new Error("reader must stop before following a repeated cursor");
        });
        const writeGroupMembersPage = vi.fn(async () => true);

        await expect(scanWorkosDirectorySnapshot({
            context: {
                organizationId: "org_1",
                directoryId: "directory_1",
                listUsers,
                listGroups: vi.fn(async () => page([group()])),
                listEvents: vi.fn(),
            },
            writePeoplePage: vi.fn(async () => true),
            writeGroupsPage: vi.fn(async () => true),
            writeGroupMembersPage,
        })).resolves.toEqual({ ok: false, code: "directory_snapshot_incomplete" });
        expect(listUsers.mock.calls.filter(([call]) => call.group)).toHaveLength(3);
        expect(writeGroupMembersPage).toHaveBeenCalledTimes(2);
    });

    it("replays ordered events from the captured boundary and replaces changed membership", async () => {
        const listEvents = vi.fn()
            .mockResolvedValueOnce(page([
                { id: "event_1", event: "dsync.user.updated", data: user("user_1") },
                {
                    id: "event_2",
                    event: "dsync.group.user_added",
                    data: { directoryId: "directory_1", user: user("user_1"), group: group() },
                },
            ]))
            .mockResolvedValueOnce(page([]));
        const context: WorkosDirectoryReadContext = {
            organizationId: "org_1",
            directoryId: "directory_1",
            listUsers: vi.fn(async (options: { after?: string | null }) => options.after === null
                ? page([user("user_1")], "members_next")
                : page([user("user_2")])),
            listGroups: vi.fn(),
            listEvents,
        };
        const writeWorkosEvent = vi.fn(async (_event: { attemptId?: string }) => true);
        const stageWorkosGroupMembersEventPage = vi.fn(async () => true);

        await expect(consumeWorkosDirectoryEvents({
            source: source(),
            context,
            writeWorkosEvent,
            stageWorkosGroupMembersEventPage,
        })).resolves.toEqual({ ok: true });

        expect(listEvents).toHaveBeenNthCalledWith(1, expect.objectContaining({
            organizationId: "org_1",
            order: "asc",
            rangeStart: "2026-09-05T09:00:00.000Z",
        }));
        expect(listEvents).toHaveBeenNthCalledWith(2, expect.objectContaining({ after: "event_2", order: "asc" }));
        expect(writeWorkosEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
            expectedPosition: { eventCursor: null, eventRangeStart: new Date("2026-09-05T09:00:00.000Z") },
            eventId: "event_1",
            people: [expect.objectContaining({ externalUserId: "user_1" })],
        }));
        expect(writeWorkosEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
            expectedPosition: { eventCursor: "event_1" },
            eventId: "event_2",
            attemptId: expect.any(String),
            replaceGroupMembers: [{
                externalGroupId: "group_1",
            }],
        }));
        const attemptId = writeWorkosEvent.mock.calls[1]?.[0]?.attemptId;
        expect(attemptId).toEqual(expect.any(String));
        expect(stageWorkosGroupMembersEventPage).toHaveBeenNthCalledWith(1, {
            expectedPosition: { eventCursor: "event_1" },
            eventId: "event_2",
            attemptId,
            externalGroupId: "group_1",
            people: [],
        });
        expect(stageWorkosGroupMembersEventPage).toHaveBeenNthCalledWith(2, {
            expectedPosition: { eventCursor: "event_1" },
            eventId: "event_2",
            attemptId,
            externalGroupId: "group_1",
            people: [expect.objectContaining({ externalUserId: "user_1" })],
        });
        expect(stageWorkosGroupMembersEventPage).toHaveBeenNthCalledWith(3, {
            expectedPosition: { eventCursor: "event_1" },
            eventId: "event_2",
            attemptId,
            externalGroupId: "group_1",
            people: [expect.objectContaining({ externalUserId: "user_2" })],
        });
    });

    it("rejects a mismatched opaque page continuation before advancing any event", async () => {
        const writeWorkosEvent = vi.fn(async () => true);
        await expect(consumeWorkosDirectoryEvents({
            source: source(),
            context: {
                organizationId: "org_1",
                directoryId: "directory_1",
                listUsers: vi.fn(),
                listGroups: vi.fn(),
                listEvents: vi.fn(async () => page([
                    { id: "event_1", event: "dsync.user.updated", data: user("user_1") },
                ], "different_opaque_bookmark")),
            },
            writeWorkosEvent,
            stageWorkosGroupMembersEventPage: vi.fn(async () => true),
        })).resolves.toEqual({ ok: false, code: "directory_snapshot_incomplete" });
        expect(writeWorkosEvent).not.toHaveBeenCalled();
    });

    it("rejects a repeated opaque event ID across pages instead of cycling the cursor", async () => {
        const listEvents = vi.fn()
            .mockResolvedValueOnce(page([
                { id: "event_1", event: "dsync.user.updated", data: user("user_1") },
                { id: "event_2", event: "dsync.user.updated", data: user("user_2") },
            ], "event_2"))
            .mockResolvedValueOnce(page([
                { id: "event_1", event: "dsync.user.updated", data: user("user_1") },
                { id: "event_2", event: "dsync.user.updated", data: user("user_2") },
            ], "event_2"));
        const writeWorkosEvent = vi.fn(async () => true);

        await expect(consumeWorkosDirectoryEvents({
            source: source(),
            context: {
                organizationId: "org_1",
                directoryId: "directory_1",
                listUsers: vi.fn(),
                listGroups: vi.fn(),
                listEvents,
            },
            writeWorkosEvent,
            stageWorkosGroupMembersEventPage: vi.fn(async () => true),
        })).resolves.toEqual({ ok: false, code: "directory_snapshot_incomplete" });
        expect(writeWorkosEvent).toHaveBeenCalledTimes(2);
        expect(listEvents).toHaveBeenCalledTimes(2);
    });

    it("rejects a non-adjacent event cursor cycle before reapplying the repeated event page", async () => {
        const listEvents = vi.fn()
            .mockResolvedValueOnce(page([
                { id: "event_a", event: "dsync.user.updated", data: user("user_1") },
            ]))
            .mockResolvedValueOnce(page([
                { id: "event_b", event: "dsync.user.updated", data: user("user_2") },
            ]))
            .mockResolvedValueOnce(page([
                { id: "event_a", event: "dsync.user.updated", data: user("user_1") },
            ]))
            .mockRejectedValueOnce(new Error("reader must stop before following a repeated cursor"));
        const writeWorkosEvent = vi.fn(async () => true);

        await expect(consumeWorkosDirectoryEvents({
            source: source(),
            context: {
                organizationId: "org_1",
                directoryId: "directory_1",
                listUsers: vi.fn(),
                listGroups: vi.fn(),
                listEvents,
            },
            writeWorkosEvent,
            stageWorkosGroupMembersEventPage: vi.fn(async () => true),
        })).resolves.toEqual({ ok: false, code: "directory_snapshot_incomplete" });
        expect(listEvents).toHaveBeenCalledTimes(3);
        expect(writeWorkosEvent).toHaveBeenCalledTimes(2);
    });

    it("claims a fresh Group-roster attempt before the first upstream page can fail", async () => {
        const listUsers = vi.fn(async () => {
            throw Object.assign(new Error("WorkOS unavailable"), { status: 503 });
        });
        const context: WorkosDirectoryReadContext = {
            organizationId: "org_1",
            directoryId: "directory_1",
            listUsers,
            listGroups: vi.fn(),
            listEvents: vi.fn(async () => page([{
                id: "event_roster",
                event: "dsync.group.user_added",
                data: { directoryId: "directory_1", user: user("user_1"), group: group() },
            }])),
        };
        const stageWorkosGroupMembersEventPage = vi.fn(async () => true);

        const result = await consumeWorkosDirectoryEvents({
            source: { ...source(), eventCursor: "event_before", eventRangeStart: null },
            context,
            writeWorkosEvent: vi.fn(async () => true),
            stageWorkosGroupMembersEventPage,
        });

        expect(result).toEqual({
            ok: false,
            code: "directory_sync_unavailable",
            reconcileRunId: expect.any(String),
        });
        expect(stageWorkosGroupMembersEventPage).toHaveBeenCalledOnce();
        expect(stageWorkosGroupMembersEventPage).toHaveBeenCalledWith({
            expectedPosition: { eventCursor: "event_before" },
            eventId: "event_roster",
            attemptId: result.ok ? "unreachable" : result.reconcileRunId,
            externalGroupId: "group_1",
            people: [],
        });
        expect(stageWorkosGroupMembersEventPage.mock.invocationCallOrder[0])
            .toBeLessThan(listUsers.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
    });

    it("returns an exact source deletion to the native revoke owner without advancing the cursor", async () => {
        const context: WorkosDirectoryReadContext = {
            organizationId: "org_1",
            directoryId: "directory_1",
            listUsers: vi.fn(),
            listGroups: vi.fn(),
            listEvents: vi.fn(async () => page([{
                id: "event_deleted",
                event: "dsync.deleted",
                data: { id: "directory_1", organizationId: "org_1" },
            }])),
        };
        const writeWorkosEvent = vi.fn(async () => true);

        await expect(consumeWorkosDirectoryEvents({
            source: source(),
            context,
            writeWorkosEvent,
            stageWorkosGroupMembersEventPage: vi.fn(async () => true),
        })).resolves.toEqual({ ok: true, sourceDeleted: true });
        expect(writeWorkosEvent).not.toHaveBeenCalled();
    });

    it("preserves caller cancellation when the SDK reports its aborted fetch as HTTP 408", async () => {
        const controller = new AbortController();
        const context: WorkosDirectoryReadContext = {
            organizationId: "org_1",
            directoryId: "directory_1",
            listUsers: vi.fn(async () => {
                controller.abort();
                throw { status: 408 };
            }),
            listGroups: vi.fn(),
            listEvents: vi.fn(),
        };

        await expect(scanWorkosDirectorySnapshot({
            context,
            signal: controller.signal,
            writePeoplePage: vi.fn(async () => true),
            writeGroupsPage: vi.fn(async () => true),
            writeGroupMembersPage: vi.fn(async () => true),
        })).resolves.toEqual({ ok: false, code: "stale_run" });
    });

    it("reports an exact directory 404 as source deletion without treating a missing Group roster as deletion", async () => {
        const notFound = Object.assign(new Error("Not found"), { status: 404 });
        const shared = {
            organizationId: "org_1",
            directoryId: "directory_1",
            listEvents: vi.fn(),
        } as const;

        await expect(scanWorkosDirectorySnapshot({
            context: {
                ...shared,
                listUsers: vi.fn(async () => { throw notFound; }),
                listGroups: vi.fn(),
            },
            writePeoplePage: vi.fn(async () => true),
            writeGroupsPage: vi.fn(async () => true),
            writeGroupMembersPage: vi.fn(async () => true),
        })).resolves.toEqual({ ok: true, sourceDeleted: true });

        await expect(scanWorkosDirectorySnapshot({
            context: {
                ...shared,
                listUsers: vi.fn(async (options) => {
                    if (options.group) throw notFound;
                    return page([]);
                }),
                listGroups: vi.fn(async () => page([group()])),
            },
            writePeoplePage: vi.fn(async () => true),
            writeGroupsPage: vi.fn(async () => true),
            writeGroupMembersPage: vi.fn(async () => true),
        })).resolves.toEqual({ ok: false, code: "directory_source_identity_mismatch" });
    });

    it("reports a rejected event bookmark as an expired cursor rather than an incomplete snapshot", async () => {
        const context: WorkosDirectoryReadContext = {
            organizationId: "org_1",
            directoryId: "directory_1",
            listUsers: vi.fn(),
            listGroups: vi.fn(),
            listEvents: vi.fn(async () => {
                throw Object.assign(new Error("Invalid cursor"), {
                    status: 400,
                    name: "BadRequestException",
                });
            }),
        };

        await expect(consumeWorkosDirectoryEvents({
            source: { ...source(), eventCursor: "event_expired", eventRangeStart: null },
            context,
            writeWorkosEvent: vi.fn(async () => true),
            stageWorkosGroupMembersEventPage: vi.fn(async () => true),
        })).resolves.toEqual({ ok: false, code: "directory_cursor_expired" });

        // A rejected page of directory users is still an incomplete snapshot:
        // only the events bookmark carries a stored position WorkOS can reject.
        await expect(scanWorkosDirectorySnapshot({
            context: {
                ...context,
                listUsers: vi.fn(async () => {
                    throw Object.assign(new Error("Bad request"), { status: 400 });
                }),
            },
            writePeoplePage: vi.fn(async () => true),
            writeGroupsPage: vi.fn(async () => true),
            writeGroupMembersPage: vi.fn(async () => true),
        })).resolves.toEqual({ ok: false, code: "directory_snapshot_incomplete" });
    });

    it("preserves a raw transport Retry-After response header on rate limiting", async () => {
        const context: WorkosDirectoryReadContext = {
            organizationId: "org_1",
            directoryId: "directory_1",
            listUsers: vi.fn(async () => {
                throw {
                    status: 429,
                    response: { headers: { get: (name: string) => name === "retry-after" ? "45" : undefined } },
                };
            }),
            listGroups: vi.fn(),
            listEvents: vi.fn(),
        };

        await expect(scanWorkosDirectorySnapshot({
            context,
            writePeoplePage: vi.fn(async () => true),
            writeGroupsPage: vi.fn(async () => true),
            writeGroupMembersPage: vi.fn(async () => true),
        })).resolves.toEqual({
            ok: false,
            code: "directory_sync_rate_limited",
            retryAfterMs: 45_000,
        });
    });

    it("honours the WorkOS SDK's own parsed Retry-After on rate limiting", async () => {
        // The SDK parses `Retry-After` itself into `retryAfter` (seconds) and
        // builds no `response` object, so a reconstructed header-bearing error
        // proves nothing about the real rate-limit path.
        const context: WorkosDirectoryReadContext = {
            organizationId: "org_1",
            directoryId: "directory_1",
            listUsers: vi.fn(async () => {
                throw new RateLimitExceededException("rate limited", "req_1", 600);
            }),
            listGroups: vi.fn(),
            listEvents: vi.fn(),
        };

        await expect(scanWorkosDirectorySnapshot({
            context,
            writePeoplePage: vi.fn(async () => true),
            writeGroupsPage: vi.fn(async () => true),
            writeGroupMembersPage: vi.fn(async () => true),
        })).resolves.toEqual({
            ok: false,
            code: "directory_sync_rate_limited",
            retryAfterMs: 600_000,
        });
    });

    it("keeps the provider's Retry-After when a Group-membership event's roster read is rate limited", async () => {
        const context: WorkosDirectoryReadContext = {
            organizationId: "org_1",
            directoryId: "directory_1",
            listUsers: vi.fn(async () => {
                throw new RateLimitExceededException("rate limited", "req_2", 120);
            }),
            listGroups: vi.fn(),
            listEvents: vi.fn(async () => page([{
                id: "event_roster_rate_limited",
                event: "dsync.group.user_removed",
                data: { directoryId: "directory_1", user: user("user_1"), group: group() },
            }])),
        };

        // child 05 §9: transient retries honour provider Retry-After before the
        // local fallback cadence, including on the nested roster read.
        await expect(consumeWorkosDirectoryEvents({
            source: { ...source(), eventCursor: "event_before", eventRangeStart: null },
            context,
            writeWorkosEvent: vi.fn(async () => true),
            stageWorkosGroupMembersEventPage: vi.fn(async () => true),
        })).resolves.toEqual({
            ok: false,
            code: "directory_sync_rate_limited",
            retryAfterMs: 120_000,
            reconcileRunId: expect.any(String),
        });
    });
});
