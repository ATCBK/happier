import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { listSessionsForAccount } from "./service";
import { createV2SessionListServerTiming } from "./timing";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionListingRoutes } from "@/app/api/routes/session/registerSessionListingRoutes";
import { withSqliteReadSnapshot } from "@/storage/prisma";

const authentication = createPresentUserSessionAccessAuthentication();

describe("Reports-to listing (SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-reports-list-", initAuth: false });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture() {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const create = () => db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: '{"v":1}', encryptionMode: "plain",
            metadataLayoutVersion: 1, ownerMetadata: '{"t":"plain","v":{"v":1}}',
        } });
        return { owner, lead: await create(), unrelated: await create(), create };
    }

    const list = (userId: string, underSessionId: string) => listSessionsForAccount({
        userId, authentication,
        source: { kind: "query", query: {
            v: 1, storage: "active", includeInactive: true, scope: "all_accessible", attention: "any",
            audiences: [], tagIds: [], limit: 50, underSessionId,
        } },
        rowRepresentabilityWhere: {}, timing: createV2SessionListServerTiming({}),
    });

    it('refreshes captured list capabilities after an Admin grant becomes View', async () => {
        const { owner: viewer } = await fixture();
        const { owner, lead } = await fixture();
        const share = await db.sessionShare.create({ data: { sessionId: lead.id, sharedByUserId: owner.id,
            sharedWithUserId: viewer.id, accessLevel: 'admin', canApprovePermissions: true } });
        expect((await list(viewer.id, lead.id))?.sessions[0]?.effectiveAccess).toMatchObject({ level: 'admin' });
        const reader = await withSqliteReadSnapshot(async tx => tx);
        const delegate = reader.session;
        const original = delegate.findMany.bind(delegate);
        let enter!: () => void;
        let resume!: () => void;
        const reached = new Promise<void>(resolve => { enter = resolve; });
        const release = new Promise<void>(resolve => { resume = resolve; });
        let paused = false;
        Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true,
            value: async (...args: Parameters<typeof original>) => {
                const rows = await original(...args);
                if (!paused && args[0]?.select?.metadata) { paused = true; enter(); await release; }
                return rows;
            } });
        const response = list(viewer.id, lead.id);
        try {
            expect(await Promise.race([reached.then(() => 'barrier'), response.then(() => 'response')])).toBe('barrier');
            await db.sessionShare.update({ where: { id: share.id }, data: { accessLevel: 'view', canApprovePermissions: false } });
            resume();
            const captured = await response;
            const current = (await list(viewer.id, lead.id))?.sessions[0];
            expect(current?.effectiveAccess).toMatchObject({ level: 'view', capabilities: { manageAccess: false } });
            expect(current?.share).toEqual({ accessLevel: 'view', canApprovePermissions: false });
            expect(captured?.sessions[0]?.effectiveAccess).toMatchObject({ level: 'view', capabilities: { manageAccess: false } });
            expect(captured?.sessions[0]?.share).toEqual({ accessLevel: 'view', canApprovePermissions: false });
        } finally {
            resume(); await response;
            Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true, value: original });
        }
    });

    it('redacts a revoked report contribution while preserving the readable lead captured detail', async () => {
        const { owner, lead } = await fixture();
        const foreign = await fixture();
        await db.sessionShare.create({ data: { sessionId: foreign.lead.id, sharedByUserId: foreign.owner.id,
            sharedWithUserId: owner.id, accessLevel: 'view' } });
        await db.session.update({ where: { id: foreign.lead.id }, data: { active: true,
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: new Date() } });
        await db.sessionReportsTo.create({ data: { sessionId: foreign.lead.id, leadSessionId: lead.id } });
        await withAuthenticatedTestApp(registerSessionListingRoutes, async app => {
            const request = { method: 'GET' as const, url: `/v2/sessions/${lead.id}?accessProjectionVersion=1`,
                headers: { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' } };
            const warm = await app.inject(request);
            expect(warm.statusCode, warm.body).toBe(200);
            expect(warm.json().session).toMatchObject({ reports: { total: 1, needsYou: 1 } });
            const reader = await withSqliteReadSnapshot(async tx => tx);
            const delegate = reader.session;
            const original = delegate.findMany.bind(delegate);
            let enter!: () => void;
            let resume!: () => void;
            const reached = new Promise<void>(resolve => { enter = resolve; });
            const release = new Promise<void>(resolve => { resume = resolve; });
            let paused = false;
            Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof original>) => {
                    const rows = await original(...args);
                    if (!paused && args[0]?.select?.runtimeActivityState && !args[0]?.select?.metadata) {
                        paused = true; enter(); await release;
                    }
                    return rows;
                } });
            const response = app.inject(request);
            try {
                expect(await Promise.race([reached.then(() => 'barrier'), response.then(() => 'response')])).toBe('barrier');
                await db.sessionShare.delete({ where: { sessionId_sharedWithUserId: {
                    sessionId: foreign.lead.id, sharedWithUserId: owner.id } } });
                resume();
                const captured = await response;
                const current = await app.inject(request);
                expect(current.statusCode, current.body).toBe(200);
                expect(current.json().session).toMatchObject({ id: lead.id, reports: { total: 0, needsYou: 0 } });
                expect(captured.statusCode, captured.body).toBe(200);
                expect(captured.json().session).toMatchObject({ id: lead.id, reports: { total: 0, needsYou: 0 } });
            } finally {
                resume(); await response;
                Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true, value: original });
            }
        });
    });

    it("restricts the public listing to a readable root instead of every accessible session", async () => {
        const { owner, lead, unrelated } = await fixture();
        const page = await list(owner.id, lead.id);
        expect(page?.sessions.map((row) => row.id)).toEqual([lead.id]);
        expect(page?.sessions.map((row) => row.id)).not.toContain(unrelated.id);
    });

    it("publishes immutable step origin and depth from the same row in list and detail", async () => {
        const { owner, lead } = await fixture();
        await db.session.update({ where: { id: lead.id }, data: {
            originKind: "run_step", originRunId: "workflow-run", workDepth: 3,
        } });
        const page = await list(owner.id, lead.id);
        expect(page?.sessions[0]).toMatchObject({ origin: { kind: "run_step", runId: "workflow-run" }, workDepth: 3 });
        await withAuthenticatedTestApp(registerSessionListingRoutes, async (app) => {
            const response = await app.inject({ method: "GET", url: `/v2/sessions/${lead.id}?accessProjectionVersion=1`,
                headers: { "x-test-user-id": owner.id, "x-happier-account-stored-content-protocol": "2" } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().session).toMatchObject({ origin: { kind: "run_step", runId: "workflow-run" }, workDepth: 3 });
        });
    });

    it("does not disclose other readable sessions under an unreadable root", async () => {
        const { owner } = await fixture();
        const foreign = await fixture();
        const page = await list(owner.id, foreign.lead.id);
        expect(page?.sessions).toEqual([]);
    });

    it("includes nested readable reports without granting access to an unreadable child", async () => {
        const { owner, lead, unrelated, create } = await fixture();
        const child = await create();
        const grandchild = await create();
        const foreign = await fixture();
        const readableBehindForeign = await create();
        await db.sessionReportsTo.createMany({ data: [
            { sessionId: child.id, leadSessionId: lead.id },
            { sessionId: grandchild.id, leadSessionId: child.id },
            { sessionId: foreign.lead.id, leadSessionId: lead.id },
            { sessionId: readableBehindForeign.id, leadSessionId: foreign.lead.id },
        ] });
        const page = await list(owner.id, lead.id);
        expect(page?.sessions.map((row) => row.id).sort()).toEqual([lead.id, child.id, grandchild.id, readableBehindForeign.id].sort());
        expect(page?.sessions.map((row) => row.id)).not.toContain(unrelated.id);
        expect(page?.sessions.find((row) => row.id === child.id)).toMatchObject({ reportsTo: { sessionId: lead.id } });
        expect(page?.sessions.find((row) => row.id === lead.id)).toMatchObject({ reports: { total: 1, working: 0, needsYou: 0, stalled: 0 } });
        expect(page?.sessions.find((row) => row.id === readableBehindForeign.id)).not.toHaveProperty("reportsTo");
    });

    it("counts direct reports from canonical awareness and omits unreadable lead facts", async () => {
        const { owner, lead, create } = await fixture();
        const working = await create();
        const needsYou = await create();
        const grandchild = await create();
        await db.session.update({ where: { id: working.id }, data: { active: true, latestTurnStatus: "in_progress" } });
        await db.session.update({ where: { id: needsYou.id }, data: {
            active: true, pendingPermissionRequestCount: 1, pendingRequestObservedAt: new Date(),
        } });
        await db.sessionReportsTo.createMany({ data: [
            { sessionId: working.id, leadSessionId: lead.id },
            { sessionId: needsYou.id, leadSessionId: lead.id },
            { sessionId: grandchild.id, leadSessionId: working.id },
        ] });
        const page = await list(owner.id, lead.id);
        expect(page?.sessions.find((row) => row.id === lead.id)).toMatchObject({ reports: { total: 2, working: 1, needsYou: 1, stalled: 0 } });
        const foreign = await fixture();
        await db.sessionReportsTo.create({ data: { sessionId: foreign.lead.id, leadSessionId: lead.id } });
        const foreignPage = await list(foreign.owner.id, foreign.lead.id);
        expect(foreignPage?.sessions[0]).not.toHaveProperty("reportsTo");
    });

    it("projects the same direct-report facts through HTTP detail without widening cross-owner reads", async () => {
        const { owner, lead, create } = await fixture();
        const child = await create();
        const foreign = await fixture();
        await db.sessionReportsTo.createMany({ data: [
            { sessionId: child.id, leadSessionId: lead.id },
            { sessionId: foreign.lead.id, leadSessionId: lead.id },
        ] });
        await withAuthenticatedTestApp(registerSessionListingRoutes, async (app) => {
            const headers = { "x-test-user-id": owner.id, "x-happier-account-stored-content-protocol": "2" };
            const leadDetail = await app.inject({ method: "GET", url: `/v2/sessions/${lead.id}?accessProjectionVersion=1`, headers });
            expect(leadDetail.statusCode, leadDetail.body).toBe(200);
            expect(leadDetail.json().session).toMatchObject({ reports: { total: 1, working: 0, needsYou: 0, stalled: 0 } });
            const childDetail = await app.inject({ method: "GET", url: `/v2/sessions/${child.id}?accessProjectionVersion=1`, headers });
            expect(childDetail.statusCode, childDetail.body).toBe(200);
            expect(childDetail.json().session).toMatchObject({ reportsTo: { sessionId: lead.id } });
            const deniedDetail = await app.inject({ method: "GET", url: `/v2/sessions/${foreign.lead.id}?accessProjectionVersion=1`, headers });
            expect(deniedDetail.statusCode).toBe(404);
        });
    });

    it("keeps supplemental pins and attention inside the subtree and counts reports outside a page", async () => {
        const { owner, lead, unrelated, create } = await fixture();
        const child = await create();
        await db.sessionReportsTo.create({ data: { sessionId: child.id, leadSessionId: lead.id } });
        await db.session.update({ where: { id: lead.id }, data: { meaningfulActivityAt: new Date(Date.now() + 1_000) } });
        await db.sessionPin.create({ data: { accountId: owner.id, sessionId: unrelated.id, sortKey: "0" } });
        await db.sessionAttentionStanding.create({ data: { accountId: owner.id, sessionId: unrelated.id, standing: true } });
        const page = await listSessionsForAccount({
            userId: owner.id, authentication,
            source: { kind: "query", query: {
                v: 1, storage: "active", includeInactive: true, scope: "all_accessible", attention: "any",
                audiences: [], tagIds: [], limit: 1, includeAttention: true, underSessionId: lead.id,
            } },
            rowRepresentabilityWhere: {}, timing: createV2SessionListServerTiming({}),
        });
        expect(page?.sessions.map((row) => row.id)).not.toContain(unrelated.id);
        expect(page?.sessions).toHaveLength(1);
        expect(page?.sessions[0]).toMatchObject({ id: lead.id, reports: { total: 1 } });
    });

    it("counts an inactive report whose own latest turn is still in flight as stalled", async () => {
        const { owner, lead, create } = await fixture();
        const child = await create();
        await db.session.update({ where: { id: child.id }, data: {
            active: false, latestTurnStatus: "in_progress", latestTurnStatusObservedAt: BigInt(0),
            lastActiveAt: new Date(0),
        } });
        await db.sessionReportsTo.create({ data: { sessionId: child.id, leadSessionId: lead.id } });
        const page = await list(owner.id, lead.id);
        expect(page?.sessions.find((row) => row.id === lead.id)).toMatchObject({ reports: {
            total: 1, working: 0, needsYou: 0, stalled: 1,
        } });
    });

    it("does not count an inactive report with a completed turn as stalled", async () => {
        const { owner, lead, create } = await fixture();
        const child = await create();
        await db.session.update({ where: { id: child.id }, data: {
            active: false, latestTurnStatus: "completed", latestTurnStatusObservedAt: BigInt(Date.now()),
        } });
        await db.sessionReportsTo.create({ data: { sessionId: child.id, leadSessionId: lead.id } });
        const page = await list(owner.id, lead.id);
        expect(page?.sessions.find((row) => row.id === lead.id)?.reports)
            .toEqual({ total: 1, working: 0, needsYou: 0, stalled: 0 });
    });

    it("counts an active mid-turn report as working rather than stalled", async () => {
        const { owner, lead, create } = await fixture();
        const child = await create();
        await db.session.update({ where: { id: child.id }, data: {
            active: true, latestTurnStatus: "in_progress", latestTurnStatusObservedAt: BigInt(0),
            lastActiveAt: new Date(0),
        } });
        await db.sessionReportsTo.create({ data: { sessionId: child.id, leadSessionId: lead.id } });
        const page = await list(owner.id, lead.id);
        expect(page?.sessions.find((row) => row.id === lead.id)?.reports)
            .toEqual({ total: 1, working: 1, needsYou: 0, stalled: 0 });
    });

    it("omits a hidden stalled report from list and detail counts and ids", async () => {
        const { owner, lead, create } = await fixture();
        const child = await create();
        const foreign = await fixture();
        for (const sessionId of [child.id, foreign.lead.id]) {
            await db.session.update({ where: { id: sessionId }, data: { active: false, latestTurnStatus: "in_progress" } });
            await db.sessionReportsTo.create({ data: { sessionId, leadSessionId: lead.id } });
        }
        const page = await list(owner.id, lead.id);
        expect(page?.sessions.map((row) => row.id).sort()).toEqual([lead.id, child.id].sort());
        expect(page?.sessions.find((row) => row.id === lead.id)?.reports)
            .toEqual({ total: 1, working: 0, needsYou: 0, stalled: 1 });
        await withAuthenticatedTestApp(registerSessionListingRoutes, async (app) => {
            const headers = { "x-test-user-id": owner.id, "x-happier-account-stored-content-protocol": "2" };
            const detail = await app.inject({ method: "GET", url: `/v2/sessions/${lead.id}?accessProjectionVersion=1`, headers });
            expect(detail.statusCode, detail.body).toBe(200);
            expect(detail.json().session.reports).toEqual({ total: 1, working: 0, needsYou: 0, stalled: 1 });
            const denied = await app.inject({ method: "GET", url: `/v2/sessions/${foreign.lead.id}?accessProjectionVersion=1`, headers });
            expect(denied.statusCode).toBe(404);
        });
    });

    it("counts needs-you by I3's session buckets and suppresses unreadable reports in every bucket", async () => {
        const { owner, lead, create } = await fixture();
        const primaries = ["failed", "permission_required", "action_required", "working", "ready"] as const;
        for (const primary of primaries) {
            const child = await create();
            await db.session.update({ where: { id: child.id }, data: {
                active: true,
                latestTurnStatus: primary === "failed" ? "failed" : primary === "working" ? "in_progress" : "completed",
                latestTurnStatusObservedAt: BigInt(Date.now()),
                pendingPermissionRequestCount: primary === "permission_required" ? 1 : 0,
                pendingUserActionRequestCount: primary === "action_required" ? 1 : 0,
                pendingRequestObservedAt: new Date(),
            } });
            await db.sessionReportsTo.create({ data: { sessionId: child.id, leadSessionId: lead.id } });
        }
        const foreign = await fixture();
        await db.session.update({ where: { id: foreign.lead.id }, data: { active: true, latestTurnStatus: "failed" } });
        await db.sessionReportsTo.create({ data: { sessionId: foreign.lead.id, leadSessionId: lead.id } });
        // Preserve the real UI parity assertion without compiling UI aliases
        // and DOM declarations inside the server's TypeScript project.
        const { resolveWorkStatusTone } = await vi.importActual<{
            resolveWorkStatusTone: (input: { kind: "session"; facts: {
                word: typeof primaries[number]; awareness: { runtime: "unknown";
                    operational: { primary: typeof primaries[number]; reasons: [] } };
            } }) => { bucket: string };
        }>("../../../../../ui/sources/components/work/status/resolveWorkStatusTone");
        const needsYou = primaries.filter((primary) => resolveWorkStatusTone({ kind: "session", facts: {
            word: primary, awareness: { runtime: "unknown", operational: { primary, reasons: [] } },
        } }).bucket === "needs_you").length;
        const page = await list(owner.id, lead.id);
        expect(page?.sessions.find((row) => row.id === lead.id)?.reports)
            .toEqual({ total: primaries.length, working: 1, needsYou, stalled: 0 });
        expect(page?.sessions.map((row) => row.id)).not.toContain(foreign.lead.id);
    });

    it("does not disclose a shared report whose publication tuple is malformed", async () => {
        const { owner, lead } = await fixture();
        const foreign = await fixture();
        await db.session.update({ where: { id: foreign.lead.id }, data: {
            currentStorageState: "snapshot_complete", seq: 0, acceptedThroughServerSeq: 0,
            publishedThroughServerSeq: 0, materializedThroughSourceAt: BigInt(1),
            materializationPublicationId: "   ",
        } });
        await db.sessionShare.create({ data: {
            sessionId: foreign.lead.id, sharedByUserId: foreign.owner.id,
            sharedWithUserId: owner.id, accessLevel: "view",
        } });
        await db.sessionReportsTo.create({ data: { sessionId: foreign.lead.id, leadSessionId: lead.id } });
        const page = await list(owner.id, lead.id);
        expect(page?.sessions.map((row) => row.id)).toEqual([lead.id]);
        expect(page?.sessions[0]).toMatchObject({ reports: { total: 0, working: 0, needsYou: 0, stalled: 0 } });
    });
});
