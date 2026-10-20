import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";
import { encodeBase64 } from "privacy-kit";
import { sealEncryptedDataKeyEnvelopeV1, type DiscussionCreateRequestV1 } from "@happier-dev/protocol";

import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { applySessionDataKeyEnvelopes } from "@/app/session/encryption/sessionDataKeyEnvelopeService";
import { db, initDbPostgres, shutdownDbClient } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { bindDiscussionParticipantSessionInTx, inviteDiscussionParticipant, removeDiscussionParticipant } from "./accessService";
import { createDiscussion } from "./mutations";

const authentication = createPresentUserSessionAccessAuthentication();

/** Observe the actual public writer waiting, not a test-injected internal gate. */
async function whileSessionParentIsHeld<T>(input: Readonly<{
    sessionId: string;
    write: () => Promise<T>;
    probe: (tx: Tx) => Promise<unknown>;
}>): Promise<T> {
    let writer: Promise<T> | undefined;
    try {
        await db.$transaction(async holder => {
            const [{ pid }] = await holder.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            // Physical deletion takes this parent mode. The public writer must
            // wait before touching a child that the same deletion can cascade.
            await holder.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${input.sessionId} FOR UPDATE`;
            let finished = false;
            writer = input.write().finally(() => { finished = true; });
            void writer.catch(() => undefined);
            let waiting = false;
            while (!finished && !waiting) {
                const [row] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                    SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                        AND ${pid} = ANY(pg_blocking_pids(pid))) AS waiting
                `;
                waiting = row.waiting;
            }
            expect(waiting).toBe(true);
            // This is a diagnostic transport probe, not a product mutation:
            // inTx intentionally retries 55P03 and would hide NOWAIT evidence.
            await db.$transaction(input.probe);
        });
        if (!writer) throw new Error("The public writer did not start");
        return await writer;
    } finally {
        if (writer) await Promise.allSettled([writer]);
    }
}

function createRequest(sessionIds: readonly string[]): DiscussionCreateRequestV1 {
    return {
        creationLocalId: randomUUID(),
        participants: sessionIds.map(sessionId => ({ kind: "session", sessionId })),
        titleContent: { t: "plain", v: { v: 1, title: "Parent publication order" } },
        firstMessage: {
            localId: randomUUID(),
            content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "First" }] } },
            mentionedAccountIds: [],
        },
    };
}

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Session child publication parent order (PostgreSQL)", () => {
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing disposable DATABASE_URL");
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await shutdownDbClient(); });

    it("admits every initial Discussion Session before attaching the first participant", async () => {
        const prefix = randomUUID();
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const held = await db.session.create({ data: {
            id: `${prefix}-a-held`, accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        const first = await db.session.create({ data: {
            id: `${prefix}-z-first`, accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        try {
            const result = await whileSessionParentIsHeld({
                sessionId: held.id,
                write: () => createDiscussion({ actorAccountId: owner.id, authentication, request: createRequest([first.id, held.id]) }),
                probe: async peer => {
                    expect(await peer.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${first.id} FOR UPDATE NOWAIT`)
                        .toEqual([{ id: first.id }]);
                },
            });
            expect(result).toMatchObject({ ok: true });
            if (!result.ok) throw new Error(result.error);
            expect(await db.sessionFollowEdge.count({ where: { sourceDiscussionId: result.value.discussion.id } })).toBe(2);
        } finally {
            await db.session.deleteMany({ where: { id: { in: [held.id, first.id] } } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it.each(["session", "model"] as const)("waits for the participant Session before deleting its Discussion Follow child (%s)", async kind => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        try {
            const created = await createDiscussion({ actorAccountId: owner.id, authentication,
                request: createRequest(kind === "session" ? [session.id] : []) });
            expect(created).toMatchObject({ ok: true });
            if (!created.ok) throw new Error(created.error);
            const discussionId = created.value.discussion.id;
            const participantSlotId = randomUUID();
            if (kind === "model") {
                const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: "{}" } });
                const launch = { executionTarget: { serverId: "home", machineId: machine.id },
                    directory: { kind: "path" as const, path: "/tmp" },
                    agentTarget: { kind: "agent" as const, identity: { pluginId: "happier.agent.claude", localId: "claude" } },
                    modelSelection: { v: 1 as const, ref: { agentTargetKey: "happier.agent.claude/claude",
                        providerConnectionId: null, modelId: "selected-model" }, updatedAt: 1 } };
                expect(await inviteDiscussionParticipant({ actorAccountId: owner.id, authentication, discussionId,
                    request: { participant: { kind: "model", participantSlotId, launch } } })).toMatchObject({ ok: true });
                await db.session.update({ where: { id: session.id }, data: { originKind: "discussion",
                    originDiscussionId: discussionId, originDiscussionParticipantSlotId: participantSlotId } });
                expect(await inTx(tx => bindDiscussionParticipantSessionInTx(tx, { accountId: owner.id,
                    discussionParticipant: { discussionId, participantSlotId }, launch, sessionId: session.id })))
                    .toMatchObject({ ok: true });
            }
            // Force this publication to exercise its real Session FK insert,
            // rather than update an already coalesced AccountChange row.
            await db.accountChange.deleteMany({ where: { accountId: owner.id, kind: "session", entityId: session.id } });
            const result = await whileSessionParentIsHeld({
                sessionId: session.id,
                write: () => removeDiscussionParticipant({ actorAccountId: owner.id, authentication, discussionId,
                    request: { participant: kind === "session" ? { kind: "session", sessionId: session.id }
                        : { kind: "model", participantSlotId } } }),
                probe: async peer => {
                    expect(await peer.$queryRaw`SELECT "destinationSessionId" FROM "SessionFollowEdge"
                        WHERE "sourceDiscussionId" = ${discussionId} AND "destinationSessionId" = ${session.id} FOR UPDATE NOWAIT`)
                        .toEqual([{ destinationSessionId: session.id }]);
                },
            });
            expect(result).toMatchObject({ ok: true, value: { changed: true } });
            expect(await db.sessionFollowEdge.count({ where: { sourceDiscussionId: discussionId, destinationSessionId: session.id } })).toBe(0);
            expect(await db.accountChange.count({ where: { accountId: owner.id, kind: "session", entityId: session.id } })).toBe(1);
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.machine.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it("waits for the Session before replacing an existing recipient key-envelope child", async () => {
        const binding = createSignedAccountContentBinding();
        const owner = await db.account.create({ data: {
            ...binding, contentPublicKey: Buffer.from(binding.contentPublicKey),
            contentPublicKeySig: Buffer.from(binding.contentPublicKeySig), encryptionMode: "e2ee",
        } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: JSON.stringify({ t: "encrypted", c: "" }), encryptionMode: "e2ee",
        } });
        const envelope = () => sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
            recipientPublicKey: binding.contentPublicKey, randomBytes: length => tweetnacl.randomBytes(length) });
        const replacement = new Uint8Array(envelope());
        await db.sessionDataKeyEnvelope.create({ data: {
            sessionId: session.id, recipientAccountId: owner.id, encryptedDataKey: Buffer.from(envelope()),
        } });
        try {
            const result = await whileSessionParentIsHeld({
                sessionId: session.id,
                write: () => applySessionDataKeyEnvelopes({ actorAccountId: owner.id, sessionId: session.id, authentication,
                    entries: [{ recipientAccountId: owner.id, encryptedDataKey: encodeBase64(replacement) }] }),
                probe: async peer => {
                    expect(await peer.$queryRaw`SELECT "recipientAccountId" FROM "SessionDataKeyEnvelope"
                        WHERE "sessionId" = ${session.id} AND "recipientAccountId" = ${owner.id} FOR UPDATE NOWAIT`)
                        .toEqual([{ recipientAccountId: owner.id }]);
                },
            });
            expect(result).toEqual({ ok: true, appliedCount: 1 });
            const stored = await db.sessionDataKeyEnvelope.findUniqueOrThrow({
                where: { sessionId_recipientAccountId: { sessionId: session.id, recipientAccountId: owner.id } },
            });
            expect(new Uint8Array(stored.encryptedDataKey)).toEqual(replacement);
            expect(await db.accountChange.count({ where: { accountId: owner.id, kind: "session", entityId: session.id } })).toBe(1);
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });
});
