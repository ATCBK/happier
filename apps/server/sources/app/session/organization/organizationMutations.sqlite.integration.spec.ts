import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    ReorderSessionOrganizationResponseSchema,
    SessionOrganizationSnapshotResponseSchema,
    SetSessionPinResponseSchema,
    SetSessionTagAssignmentsResponseSchema,
} from "@happier-dev/protocol";

import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionOrganizationRoutes } from "@/app/api/routes/session/registerSessionOrganizationRoutes";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";

import { setSessionTagAssignments } from "./organizationMutations";

const authentication = createPresentUserSessionAccessAuthentication();

describe("session organization mutations on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-organization-sqlite-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("keeps independent pin memberships and shared order through authenticated HTTP and SQLite", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: `session-${randomUUID()}`, metadata: "{}", metadataVersion: 0,
            agentState: null, agentStateVersion: 0,
        }, select: { id: true } });
        const retained = await db.sessionPin.create({ data: {
            accountId: account.id, sessionId: session.id, sortKey: "saved", pinnedAt: new Date(1234),
        } });
        const neighbor = await db.session.create({ data: {
            accountId: account.id, tag: `session-${randomUUID()}`, metadata: "{}", metadataVersion: 0,
            agentState: null, agentStateVersion: 0,
        }, select: { id: true } });
        const otherAccount = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const untouchedPins = await db.sessionPin.createMany({ data: [
            { accountId: account.id, sessionId: neighbor.id, sortKey: "neighbor", listPinned: true, railPinned: true },
            { accountId: otherAccount.id, sessionId: session.id, sortKey: "foreign", listPinned: true, railPinned: false },
        ] });
        expect(untouchedPins.count).toBe(2);
        const untouchedWhere = { OR: [{ accountId: account.id, sessionId: neighbor.id }, { accountId: otherAccount.id }] };
        const beforeNeighbors = await db.sessionPin.findMany({ where: untouchedWhere, orderBy: { id: "asc" } });
        expect(retained).toMatchObject({ listPinned: true, railPinned: false });
        const app = createAuthenticatedTestApp();
        registerSessionOrganizationRoutes(app);
        await app.ready();
        const headers = { "x-test-user-id": account.id };
        const pinUrl = `/v2/session-organization/pins/${session.id}`;
        try {
            const pinned = await app.inject({ method: "PUT", url: pinUrl, headers,
                payload: { surface: "rail", pinned: true, sortKey: "ignored" } });
            expect(pinned.statusCode).toBe(200);
            expect(SetSessionPinResponseSchema.parse(pinned.json())).toEqual({ pin: {
                sessionId: session.id, listPinned: true, railPinned: true, sortKey: "saved", pinnedAt: 1234,
            } });
            await expect(db.sessionPin.findUnique({ where: { id: retained.id } })).resolves.toMatchObject({
                listPinned: true, railPinned: true, sortKey: "saved", pinnedAt: new Date(1234),
            });
            const clearedList = await app.inject({ method: "PUT", url: pinUrl, headers,
                payload: { surface: "list", pinned: false } });
            expect(clearedList.statusCode).toBe(200);
            expect(SetSessionPinResponseSchema.parse(clearedList.json())).toEqual({ pin: {
                sessionId: session.id, listPinned: false, railPinned: true, sortKey: "saved", pinnedAt: 1234,
            } });
            // A retained caller omitting surface still changes only list membership.
            const legacyList = await app.inject({ method: "PUT", url: pinUrl, headers,
                payload: { pinned: true, sortKey: "replacement" } });
            expect(legacyList.statusCode).toBe(200);
            expect(SetSessionPinResponseSchema.parse(legacyList.json())).toEqual({ pin: {
                sessionId: session.id, listPinned: true, railPinned: true, sortKey: "saved", pinnedAt: 1234,
            } });
            await expect(db.sessionPin.findUnique({ where: { id: retained.id } })).resolves.toMatchObject({
                listPinned: true, railPinned: true, sortKey: "saved", pinnedAt: new Date(1234),
            });
            const reclearedList = await app.inject({ method: "PUT", url: pinUrl, headers,
                payload: { surface: "list", pinned: false } });
            expect(reclearedList.statusCode).toBe(200);
            expect(SetSessionPinResponseSchema.parse(reclearedList.json()).pin?.listPinned).toBe(false);
            const reordered = await app.inject({ method: "POST", url: "/v2/session-organization/pins/reorder", headers, payload: {
                scopeKind: "pinned", scopeKey: "root", entries: [{ itemKind: "session", itemKey: session.id, sortKey: "moved" }],
            } });
            expect(reordered.statusCode).toBe(200);
            expect(ReorderSessionOrganizationResponseSchema.parse(reordered.json())).toEqual({ orderEntries: [{
                scopeKind: "pinned", scopeKey: "root", itemKind: "session", itemKey: session.id, sortKey: "moved",
            }] });
            await expect(db.sessionPin.findUnique({ where: { id: retained.id } })).resolves.toMatchObject({
                listPinned: false, railPinned: true, sortKey: "moved", pinnedAt: new Date(1234),
            });
            const snapshot = await app.inject({ method: "GET", url: "/v2/session-organization", headers });
            expect(snapshot.statusCode).toBe(200);
            expect(SessionOrganizationSnapshotResponseSchema.parse(snapshot.json()).snapshot.pins).toEqual([
                { sessionId: session.id, listPinned: false, railPinned: true, sortKey: "moved", pinnedAt: 1234 },
                expect.objectContaining({ sessionId: neighbor.id, sortKey: "neighbor", listPinned: true, railPinned: true }),
            ]);
            const compiledRailReorder = {
                scopeKind: "pinned" as const, scopeKey: "root",
                entries: [{ itemKind: "session" as const, itemKey: session.id, sortKey: "stale" }],
            };
            const clearedRail = await app.inject({ method: "PUT", url: pinUrl, headers,
                payload: { surface: "rail", pinned: false } });
            expect(clearedRail.statusCode).toBe(200);
            expect(SetSessionPinResponseSchema.parse(clearedRail.json())).toEqual({ pin: null });
            await expect(db.sessionPin.findUnique({ where: { id: retained.id } })).resolves.toBeNull();
            const checkpoint = await db.sessionOrganizationCheckpoint.findUnique({ where: { accountId: account.id } });
            const staleReorder = await app.inject({ method: "POST", url: "/v2/session-organization/pins/reorder", headers,
                payload: compiledRailReorder });
            expect(staleReorder.statusCode).toBe(200);
            expect(ReorderSessionOrganizationResponseSchema.parse(staleReorder.json())).toEqual({ orderEntries: [] });
            await expect(db.sessionPin.findUnique({ where: { accountId_sessionId: { accountId: account.id, sessionId: session.id } } }))
                .resolves.toBeNull();
            await expect(db.sessionPin.findMany({ where: untouchedWhere, orderBy: { id: "asc" } })).resolves.toEqual(beforeNeighbors);
            await expect(db.sessionOrganizationCheckpoint.findUnique({ where: { accountId: account.id } })).resolves.toEqual(checkpoint);
            const railOnly = await app.inject({ method: "PUT", url: pinUrl, headers,
                payload: { surface: "rail", pinned: true } });
            expect(railOnly.statusCode).toBe(200);
            expect(SetSessionPinResponseSchema.parse(railOnly.json()).pin).toMatchObject({
                sessionId: session.id, listPinned: false, railPinned: true,
            });
            await expect(db.sessionPin.findUnique({ where: { accountId_sessionId: {
                accountId: account.id, sessionId: session.id,
            } } })).resolves.toMatchObject({ listPinned: false, railPinned: true });
        } finally {
            await app.close();
        }
    });

    it("persists tag assignments through the real SQLite Prisma client", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select: { id: true },
        });
        const [firstTag, secondTag] = await Promise.all([
            db.sessionOrganizationTag.create({
                data: {
                    accountId: account.id,
                    tagKey: `tag-${randomUUID()}`,
                    tagHash: `tag-hash-${randomUUID()}`,
                },
                select: { id: true },
            }),
            db.sessionOrganizationTag.create({
                data: {
                    accountId: account.id,
                    tagKey: `tag-${randomUUID()}`,
                    tagHash: `tag-hash-${randomUUID()}`,
                },
                select: { id: true },
            }),
        ]);

        const result = await setSessionTagAssignments({
            accountId: account.id,
            sessionId: session.id,
            request: { tagIds: [firstTag.id, secondTag.id] },
            authentication,
        });

        expect(SetSessionTagAssignmentsResponseSchema.parse(result)).toEqual({
            sessionId: session.id,
            tagIds: [firstTag.id, secondTag.id].sort(),
        });
        await expect(
            db.sessionTagAssignment.findMany({
                where: { accountId: account.id, sessionId: session.id },
                orderBy: { tagId: "asc" },
                select: { tagId: true },
            }),
        ).resolves.toEqual([
            { tagId: firstTag.id },
            { tagId: secondTag.id },
        ].sort((left, right) => left.tagId.localeCompare(right.tagId)));
        await expect(
            db.sessionOrganizationCheckpoint.findUnique({
                where: { accountId: account.id },
                select: { version: true },
            }),
        ).resolves.toEqual({ version: 1 });
    });
});
