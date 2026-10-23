import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LightMyRequestResponse } from "fastify";

import { db } from "@/storage/db";
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { getAccountSessionFollow } from '@/app/session/follow/accountFollowService';
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionArchiveRoutes } from "./registerSessionArchiveRoutes";
import { SESSION_TRANSCRIPT_PUBLICATION_RECIPIENT_PROJECTION_SELECT } from "@/app/session/sessionTranscriptPublicationPolicy";

const frontier = (transcriptSeq: number) => JSON.stringify({ v: 1, transcriptSeq, readyEventSeq: 0, agentStateVersion: 0, turn: null });

describe("Follow at the Session archive HTTP owner", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-follow-archive-", initAuth: false });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it.each(["archive", "unarchive"] as const)("acknowledges the committed %s while publication is blocked, even if it later fails", async operation => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(),
            metadata: "{}", encryptionMode: "plain", active: false,
            archivedAt: operation === "unarchive" ? new Date() : null } });
        let enterPublication!: () => void;
        let releasePublication!: () => void;
        let settlePublication!: () => void;
        const entered = new Promise<void>(resolve => { enterPublication = resolve; });
        const release = new Promise<void>(resolve => { releasePublication = resolve; });
        const settled = new Promise<void>(resolve => { settlePublication = resolve; });
        const delegate = db.session;
        const originalFindUnique = delegate.findUnique;
        const findUnique = originalFindUnique.bind(delegate);
        // Hold only the post-commit database read. Access, transaction, Follow
        // effects, cursor writes and HTTP serialization use their real owners.
        const publicationRead = vi.spyOn(delegate, "findUnique").mockImplementation(args => {
            if (args.where.id === session.id && args.select === SESSION_TRANSCRIPT_PUBLICATION_RECIPIENT_PROJECTION_SELECT) {
                enterPublication();
                // This database fault never resolves a row or exposes Prisma's
                // relation methods; only the query's rejecting thenable is used.
                return release.then(() => { settlePublication(); throw new Error("Publication database unavailable"); }) as ReturnType<typeof delegate.findUnique>;
            }
            return findUnique(args);
        });
        try {
            await withAuthenticatedTestApp(registerSessionArchiveRoutes, async app => {
                let status: number | undefined;
                const response = app.inject({ method: "POST", url: `/v2/sessions/${session.id}/${operation}`,
                    headers: { "x-test-user-id": owner.id } }).then((result: LightMyRequestResponse) => { status = result.statusCode; return result; });
                await entered;
                try {
                    await expect.poll(() => status).toBe(200);
                    const result = await response;
                    expect(result.json()).toMatchObject({ success: true,
                        archivedAt: operation === "archive" ? expect.any(Number) : null });
                    const persisted = await findUnique({ where: { id: session.id } });
                    expect(persisted?.archivedAt === null).toBe(operation === "unarchive");
                } finally {
                    releasePublication();
                    await settled;
                    await response;
                }
            });
        } finally {
            releasePublication();
            publicationRead.mockRestore();
            delegate.findUnique = originalFindUnique;
        }
    });

    it("retains private choices and unread while restoring Voice at current, only once", async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const suppressed = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const source = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain", seq: 9,
        } });
        const destination = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain", archivedAt: new Date(),
        } });
        const where = { accountId_sessionId: { accountId: owner.id, sessionId: source.id } };
        await db.accountSessionFollow.create({ data: { accountId: owner.id, sessionId: source.id,
            following: true, followPolicy: JSON.stringify({ preset: 'important', voice: true }), includeInVoice: false, voiceDeliveredFrontier: frontier(9) } });
        await db.accountSessionFollow.create({ data: { accountId: suppressed.id, sessionId: source.id,
            following: false, followPolicy: null, includeInVoice: false } });
        const readFollow = async (accountId = owner.id) => {
            const rows = await db.$queryRaw<Array<{ following: boolean; includeInVoice: boolean; followPolicy: string | null; voiceDeliveredFrontier: string | null }>>`
                SELECT following, includeInVoice, followPolicy, voiceDeliveredFrontier FROM AccountSessionFollow
                WHERE accountId = ${accountId} AND sessionId = ${source.id}`;
            return rows[0];
        };
        await db.accountSessionReadState.create({ data: { accountId: owner.id, sessionId: source.id, lastViewedSessionSeq: 2 } });
        const edgeWhere = { destinationSessionId_sourceSessionId_relation: { destinationSessionId: destination.id, sourceSessionId: source.id, relation: 'follower' } };
        await db.sessionFollowEdge.create({ data: { policyJson: '{"preset":"important"}', sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: source.id }), sourceSessionId: source.id, destinationSessionId: destination.id, deliveredTranscriptSeq: 1 } });
        await withAuthenticatedTestApp(registerSessionArchiveRoutes, async (app) => {
            const post = async (sessionId: string, action: string) => {
                const response = await app.inject({ method: "POST", url: `/v2/sessions/${sessionId}/${action}`, headers: { "x-test-user-id": owner.id } });
                expect(response.statusCode).toBe(200);
            };
            await post(source.id, "archive");
            expect(await readFollow()).toMatchObject({ voiceDeliveredFrontier: frontier(9) });
            await db.session.update({ where: { id: source.id }, data: { seq: 12 } });
            // A database failure at the Follow write must roll back the owning archive transaction.
            await db.$executeRawUnsafe(`CREATE TRIGGER reject_follow_restore BEFORE UPDATE ON AccountSessionFollow
                WHEN NEW.voiceDeliveredFrontier IS NULL BEGIN SELECT RAISE(ABORT, 'test restore failure'); END`);
            try {
                const failed = await app.inject({ method: "POST", url: `/v2/sessions/${source.id}/unarchive`, headers: { "x-test-user-id": owner.id } });
                expect(failed.statusCode).toBe(500);
                expect((await db.session.findUniqueOrThrow({ where: { id: source.id } })).archivedAt).not.toBeNull();
                expect(await readFollow()).toMatchObject({ voiceDeliveredFrontier: frontier(9) });
            } finally {
                await db.$executeRawUnsafe("DROP TRIGGER reject_follow_restore");
            }
            await post(source.id, "unarchive");
            expect(await readFollow()).toMatchObject({ following: true, includeInVoice: false,
                followPolicy: JSON.stringify({ preset: 'important', voice: true }), voiceDeliveredFrontier: null });
            expect(await getAccountSessionFollow({ accountId: owner.id, sessionId: source.id,
                authentication: { env: process.env, authority: 'present_user', authenticationEvidence: undefined } }))
                .toMatchObject({ ok: true, value: { follow: { following: true, includeInVoice: true,
                    policy: { preset: 'important', voice: true } }, voiceInitialSnapshotPending: true } });
            expect(await db.sessionFollowEdge.findUnique({ where: edgeWhere })).toMatchObject({ deliveredTranscriptSeq: 1 });
            await post(destination.id, "unarchive");
            expect(await db.sessionFollowEdge.findUnique({ where: edgeWhere })).toMatchObject({ deliveredTranscriptSeq: 12 });
            await db.$executeRaw`UPDATE AccountSessionFollow SET voiceDeliveredFrontier = ${frontier(12)} WHERE accountId = ${owner.id} AND sessionId = ${source.id}`;
            await db.session.update({ where: { id: source.id }, data: { seq: 13 } });
            await post(source.id, "unarchive");
            expect(await readFollow()).toMatchObject({ voiceDeliveredFrontier: frontier(12) });
            expect(await getAccountSessionFollow({ accountId: owner.id, sessionId: source.id,
                authentication: { env: process.env, authority: 'present_user', authenticationEvidence: undefined } }))
                .toMatchObject({ ok: true, value: { follow: { includeInVoice: true }, voiceInitialSnapshotPending: false } });
            expect(await db.sessionFollowEdge.findUnique({ where: edgeWhere })).toMatchObject({ deliveredTranscriptSeq: 12 });
        });
        expect(await db.accountSessionReadState.findUnique({ where })).toMatchObject({ lastViewedSessionSeq: 2 });
        expect(await readFollow(suppressed.id)).toMatchObject({ following: false });
    });
});
