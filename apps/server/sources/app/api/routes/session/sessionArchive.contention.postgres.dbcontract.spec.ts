import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { markSessionProjectionRecipientsChanged } from "@/app/session/changeTracking/markSessionProjectionRecipientsChanged";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { registerSessionArchiveRoutes } from "./registerSessionArchiveRoutes";
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Session archive HTTP owner under parent publication", () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it.each(["archive", "unarchive"] as const)("refuses an unauthorized %s without changing Session state or publishing", async operation => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const outsider = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain", active: false,
            archivedAt: operation === "unarchive" ? new Date(123) : null,
        } });
        try {
            await withAuthenticatedTestApp(registerSessionArchiveRoutes, async app => {
                const response = await app.inject({ method: "POST", url: `/v2/sessions/${session.id}/${operation}`,
                    headers: { "x-test-user-id": outsider.id } });
                expect(response.statusCode, response.body).toBe(403);
                expect(response.json()).toEqual({ error: "Forbidden" });
                expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toEqual(session);
                expect(await db.accountChange.count({ where: { accountId: { in: [owner.id, outsider.id] } } })).toBe(0);
            });
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, outsider.id] } } });
        }
    });

    it.each(["archive", "unarchive"] as const)("commits %s while the live manager keeps publishing", async operation => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const parent = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain", active: true,
        } });
        const child = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain", active: false,
            archivedAt: operation === "unarchive" ? new Date(123) : null, seq: 9,
            originKind: "session", originSessionId: parent.id,
        } });
        await db.sessionFollowEdge.create({ data: { sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: child.id }),
            sourceSessionId: child.id, destinationSessionId: parent.id, relation: 'manager', managerSourceSessionId: child.id,
            policyJson: JSON.stringify({ preset: 'important' }), deliveredTranscriptSeq: 2 } });
        await db.sessionFollowEdge.create({ data: { sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: parent.id }),
            sourceSessionId: parent.id, destinationSessionId: child.id, policyJson: JSON.stringify({ preset: 'quiet' }), deliveredTranscriptSeq: 0 } });
        const voiceFrontier = JSON.stringify({ v: 1, transcriptSeq: 2, readyEventSeq: 0, agentStateVersion: 0, turn: null });
        await db.accountSessionFollow.create({ data: {
            accountId: owner.id, sessionId: child.id, following: true, includeInVoice: true, voiceDeliveredFrontier: voiceFrontier,
        } });
        await db.accountSessionReadState.create({ data: { accountId: owner.id, sessionId: child.id, lastViewedSessionSeq: 2 } });
        let stop = false;
        let publications = 0;
        let ready!: () => void;
        const started = new Promise<void>(resolve => { ready = resolve; });
        const writer = (async () => {
            while (!stop) {
                await inTx(async tx => {
                    await acquireSessionAccountCursorLocksInTx(tx, [parent.id]);
                    const row = await tx.session.update({ where: { id: parent.id }, data: {
                        seq: { increment: 1 }, lastActiveAt: new Date(), thinking: true, thinkingAt: new Date(),
                    } });
                    await tx.sessionMessage.create({ data: {
                        sessionId: parent.id, seq: row.seq, localId: randomUUID(),
                        content: { t: "plain", v: { role: "assistant", content: "streaming" } },
                    } });
                    await markSessionProjectionRecipientsChanged({ tx, sessionId: parent.id, hint: { lastMessageSeq: row.seq } });
                });
                publications += 1;
                ready();
            }
        })();
        const writerOutcome = Promise.allSettled([writer]);
        const originalTransaction = db.$transaction;
        const failedStatements: string[] = [];
        // Observe the real Prisma transport; queries and internal owners still
        // run unchanged against PostgreSQL, with no injected failure or delay.
        db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                get(inner, property, innerReceiver) {
                    if (property !== "$queryRawUnsafe") return Reflect.get(inner, property, innerReceiver);
                    return async (query: string, ...values: unknown[]) => {
                        try { return await inner.$queryRawUnsafe(query, ...values); }
                        catch (error) { failedStatements.push(query); throw error; }
                    };
                },
            })), ...args.slice(1)]);
        } });
        try {
            await Promise.race([started, writer]);
            await withAuthenticatedTestApp(registerSessionArchiveRoutes, async app => {
                const before = publications;
                const response = await app.inject({ method: "POST", url: `/v2/sessions/${child.id}/${operation}`,
                    headers: { "x-test-user-id": owner.id } });
                stop = true;
                await writer;
                console.info("DF114B_CONTENTION", JSON.stringify({ operation, status: response.statusCode,
                    publications: publications - before, failedStatements }));
                expect(response.statusCode, response.body).toBe(200);
                expect(publications).toBeGreaterThan(before);
                expect((await db.session.findUniqueOrThrow({ where: { id: child.id } })).archivedAt === null).toBe(operation === "unarchive");
                expect(await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: child.id } })).toMatchObject({
                    destinationSessionId: parent.id, deliveredTranscriptSeq: operation === "unarchive" ? 9 : 2,
                });
                const edge = await db.sessionFollowEdge.findUniqueOrThrow({ where: { destinationSessionId_sourceSessionId_relation: {
                    destinationSessionId: child.id, sourceSessionId: parent.id, relation: 'follower',
                } } });
                if (operation === "unarchive") {
                    expect(edge.deliveredTranscriptSeq).toBeGreaterThan(0);
                    expect(edge.deliveredTranscriptSeq).toBeLessThanOrEqual(
                        (await db.session.findUniqueOrThrow({ where: { id: parent.id } })).seq,
                    );
                } else {
                    expect(edge.deliveredTranscriptSeq).toBe(0);
                }
                expect(await db.accountSessionFollow.findUniqueOrThrow({ where: { accountId_sessionId: {
                    accountId: owner.id, sessionId: child.id,
                } } })).toMatchObject({ following: true, includeInVoice: true,
                    voiceDeliveredFrontier: operation === "unarchive" ? null : voiceFrontier });
                expect(await db.accountSessionReadState.findUniqueOrThrow({ where: { accountId_sessionId: {
                    accountId: owner.id, sessionId: child.id,
                } } })).toMatchObject({ lastViewedSessionSeq: 2 });
                expect(await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
                    accountId: owner.id, kind: "session", entityId: child.id,
                } } })).toMatchObject({ sessionId: child.id });
            });
        } finally {
            stop = true;
            await writerOutcome;
            db.$transaction = originalTransaction;
            await db.sessionMessage.deleteMany({ where: { sessionId: parent.id } });
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });
});
