import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionExternalShareableMessagesPageV1Schema } from "@happier-dev/protocol/sessions/messages/sessionMessagesPageV1";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionMessageRoutes } from "@/app/api/routes/session/registerSessionMessageRoutes";
import { backfillSessionTurnTranscriptAnchorProjectionPage, initializeSessionTurnTranscriptAnchorProjection } from "./sessionTurnTranscriptAnchorProjectionBackfill";

describe("automatic Session turn transcript-anchor conversion", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-turn-anchor-startup-",
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" },
        });
    }, 120_000);
    afterAll(async () => { await harness.close(); });

    it.each([1, 0])("projects v%s turns after automatic initialization without operator state", async (version) => {
        const account = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain", seq: 2,
        } });
        const turn = await db.sessionTurn.create({ data: {
            sessionId: session.id, turnId: "completed-turn", status: "completed",
            startedAt: 1n, updatedAt: 2n, terminalAt: 2n,
            transcriptAnchorsJson: JSON.stringify({
                startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1,
                endSeqInclusive: 2, finalAssistantMessageSeq: 2,
            }),
            transcriptAnchorProjectionVersion: version,
            ...(version === 1 ? { transcriptAnchorMinSeq: 1, transcriptAnchorMaxSeq: 2 } : {}),
        } });
        await db.sessionMessage.create({ data: {
            sessionId: session.id, seq: 1, messageRole: "user",
            content: { t: "plain", v: { role: "user", content: { type: "text", text: "question" } } },
            inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" },
        } });
        await db.sessionMessage.create({ data: {
            sessionId: session.id, seq: 2, messageRole: "agent",
            content: { t: "plain", v: { role: "agent", content: { type: "text", text: "answer" } } },
        } });
        await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
            const read = async () => {
                const response = await app.inject({ method: "GET",
                    url: `/v1/sessions/${session.id}/messages?afterSeq=0&projection=externalShareableV1`,
                    headers: { "x-test-user-id": account.id, "x-happier-account-stored-content-protocol": "4" },
                });
                expect(response.statusCode).toBe(200);
                return SessionExternalShareableMessagesPageV1Schema.parse(response.json());
            };
            if (version === 0) {
                const blocked = await read();
                expect(blocked).toMatchObject({ hasMore: true,
                    externalShareableSnapshot: { turns: [], turnSettlementBlockedFromSeq: 1 } });
            }
            await initializeSessionTurnTranscriptAnchorProjection();
            expect(await db.sessionTurn.findUniqueOrThrow({ where: { id: turn.id } })).toMatchObject({
                transcriptAnchorProjectionVersion: 1, transcriptAnchorMinSeq: 1, transcriptAnchorMaxSeq: 2,
            });
            const projected = await read();
            expect(projected).toMatchObject({ hasMore: false,
                externalShareableSnapshot: { turns: [expect.objectContaining({ turnId: "completed-turn", status: "completed" })] } });
            expect(projected.externalShareableSnapshot).not.toHaveProperty("turnSettlementBlockedFromSeq");
            // Restart/resume is idempotent and does not require a marker.
            await initializeSessionTurnTranscriptAnchorProjection();
            expect(await read()).toEqual(projected);
            // An unconverted row introduced later still blocks this Session.
            await db.sessionTurn.update({ where: { id: turn.id }, data: {
                transcriptAnchorProjectionVersion: 0, transcriptAnchorMinSeq: null, transcriptAnchorMaxSeq: null,
            } });
            expect(await read()).toMatchObject({ hasMore: true,
                externalShareableSnapshot: { turns: [], turnSettlementBlockedFromSeq: 1 } });
        });
    });

    it("resumes committed page conversion and drains beyond one page without a manual cursor", async () => {
        const account = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        await db.sessionTurn.createMany({ data: Array.from({ length: 101 }, (_, index) => ({
            id: `automatic-anchor-${String(index).padStart(3, "0")}`,
            sessionId: session.id, turnId: `turn-${index}`, status: "completed", startedAt: 1n, updatedAt: 2n,
            transcriptAnchorsJson: JSON.stringify({ startSeqInclusive: 1, endSeqInclusive: 2 }),
        })) });
        await inTx(tx => backfillSessionTurnTranscriptAnchorProjectionPage({ db: tx, limit: 1 }));
        expect(await db.sessionTurn.count({ where: { sessionId: session.id, transcriptAnchorProjectionVersion: 1 } })).toBe(1);
        const controller = new AbortController();
        const interrupted = new Error("startup interrupted");
        controller.abort(interrupted);
        await expect(initializeSessionTurnTranscriptAnchorProjection(controller.signal)).rejects.toBe(interrupted);
        expect(await db.sessionTurn.count({ where: { sessionId: session.id, transcriptAnchorProjectionVersion: 1 } })).toBe(1);
        await initializeSessionTurnTranscriptAnchorProjection();
        expect(await db.sessionTurn.count({ where: {
            sessionId: session.id, transcriptAnchorProjectionVersion: 1,
            transcriptAnchorMinSeq: 1, transcriptAnchorMaxSeq: 2,
        } })).toBe(101);
    });
});
