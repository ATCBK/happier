import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPresentUserSessionAccessAuthentication } from "./access/sessionAccessAuthentication.testkit";
import { createSessionMessage } from "./sessionWriteService";
import { writeHistoricalSessionMessageBatch, writeSessionTranscriptMessageInTx } from "./sessionTranscriptWrite";
import { createSessionMessageFromPending } from "./pending/pendingMessageTranscriptCommit";
import { enqueuePendingMessage, updatePendingMessage } from "./pending/pendingMessageService";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const authentication = createPresentUserSessionAccessAuthentication();
const content = (text: string) => ({ t: "plain" as const, v: { role: "user", content: { type: "text", text } } });

describe("NUL normalization at Session storage owners", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-message-nul-", initAuth: false,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });
    async function fixture() {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: "plain", metadata: "{}" } });
        return { actorUserId: account.id, sessionId: session.id, authentication };
    }

    it("normalizes direct writes before persistence and local-id retries", async () => {
        const base = await fixture();
        const input = { ...base, localId: randomUUID(), inputAdmission: "authenticatedAccount" as const, content: content("a\u0000b") };
        expect(await createSessionMessage(input)).toMatchObject({ ok: true, didWrite: true, message: { content: content("ab") } });
        expect(await createSessionMessage(input)).toMatchObject({ ok: true, didWrite: false, message: { content: content("ab") } });
        expect(await createSessionMessage({ ...input, content: content("ab") })).toMatchObject({ ok: true, didWrite: false });
        expect(await createSessionMessage({ ...input, localId: randomUUID(), content: { t: "plain", v: { "key\u0000": 1 } } })).toEqual({ ok: false, error: "invalid-params" });
    });

    it("normalizes pending enqueue, retry and edit before equality evidence", async () => {
        const base = await fixture();
        const input = { ...base, localId: randomUUID(), requestedAction: { v: 1 as const, kind: "enqueue" as const }, content: content("a\u0000b") };
        expect(await enqueuePendingMessage(input)).toMatchObject({ ok: true });
        const read = () => db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: base.sessionId, localId: input.localId } } });
        expect((await read()).content).toEqual(content("ab"));
        expect(await enqueuePendingMessage({ ...input, content: content("ab") })).toMatchObject({ ok: true });
        expect(await updatePendingMessage({ ...base, localId: input.localId, content: content("c\u0000d") })).toMatchObject({ ok: true });
        expect((await read()).content).toEqual(content("cd"));
    });

    it("normalizes pending transcript commitment before retries", async () => {
        const base = await fixture();
        const params = { sessionId: base.sessionId, sessionEncryptionMode: "plain" as const, storagePolicy: "optional" as const,
            localId: randomUUID(), messageRole: "user" as const, content: content("a\u0000b") };
        expect(await inTx(tx => createSessionMessageFromPending(tx, params))).toMatchObject({
            ok: true, didWrite: true, message: { content: content("ab") },
        });
        expect(await inTx(tx => createSessionMessageFromPending(tx, params))).toMatchObject({ ok: true, didWrite: false });
    });

    it("normalizes historical items before duplicate and stored-row comparisons", async () => {
        const base = await fixture();
        const item = { localId: randomUUID(), sidechainId: null, messageRole: "user" as const, content: content("a\u0000b") };
        await db.session.update({ where: { id: base.sessionId }, data: { currentStorageState: "machine_only" } });
        const input = { sessionId: base.sessionId, storagePolicy: "optional" as const, items: [item, { ...item, content: content("ab") }] };
        expect(await writeHistoricalSessionMessageBatch(input)).toMatchObject({ ok: true, didWrite: true, messages: [{ content: content("ab") }] });
        expect(await writeHistoricalSessionMessageBatch(input)).toMatchObject({ ok: true, didWrite: false });
    });

    it("normalizes callers reaching the shared transcript insert directly", async () => {
        const base = await fixture();
        const result = await inTx(tx => writeSessionTranscriptMessageInTx(tx, {
            sessionId: base.sessionId, writeAuthority: "hosted", sessionEncryptionMode: "plain", storagePolicy: "optional",
            localId: randomUUID(), sidechainId: null, messageRole: "agent", content: content("a\u0000b"),
        }));
        expect(result).toMatchObject({ ok: true, message: { content: content("ab") } });
    });

});
