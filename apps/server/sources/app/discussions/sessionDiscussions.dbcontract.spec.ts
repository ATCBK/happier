import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DiscussionCreateRequestV1 } from "@happier-dev/protocol";
import { buildDiscussionMutationRequestBodyV1, DiscussionCreateResponseV1Schema, DISCUSSION_HTTP_PATHS_V1 } from '@happier-dev/protocol/discussions/api';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import type { Fastify } from '@/app/api/types';
import { registerDiscussionRoutes } from '@/app/api/routes/discussions/registerDiscussionRoutes';
import { inTx } from '@/storage/inTx';
import { observePendingSessionFollowForDestinationInTx, acknowledgeDiscussionFollowInputInTx } from '@/app/session/follow/sessionFollowEdgeService';
import { deriveDiscussionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { DEFAULT_PENDING_REQUESTED_ACTION_V1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { createSessionInputReplyProgressInTx } from '@/app/session/messages/sessionMessageReply';
import { deleteOwnedSession } from '@/app/session/delete/deleteOwnedSession';
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { db, initDbMysql, initDbPostgres, requireDbProviderFromEnv, shutdownDbClient } from "@/storage/db";

import { createDiscussion, postDiscussionMessage } from "./mutations";

const authentication = createPresentUserSessionAccessAuthentication();

describe("Discussion provider contract", () => {
    let connected = false;

    beforeAll(async () => {
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS__ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        if (!process.env.DATABASE_URL) throw new Error("The disposable DB-contract DATABASE_URL is required");
        const provider = requireDbProviderFromEnv(process.env, "postgres");
        if (provider === "mysql") await initDbMysql();
        else if (provider === "postgres") initDbPostgres();
        else throw new Error("This DB-contract lane requires postgres or mysql; SQLite has its own integration suite");
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (connected) await shutdownDbClient();
        vi.unstubAllEnvs();
    });

    it.each([false, true])('commits atomic first-message addressing through HTTP and Follow (addressed: %s)', async addressed => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const sessions = await Promise.all([0, 1, 2].map(() => db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}',
        } })));
        const [selected, unaddressed, uninvited] = sessions;
        const app: Fastify = createAuthenticatedTestApp();
        registerDiscussionRoutes(app);
        await app.ready();
        const content = { v: 1 as const, parts: [...(addressed ? [{ t: 'mention' as const,
            participant: { kind: 'session' as const, sessionId: selected.id } }] : []), { t: 'text' as const, text: 'Initial question' }] };
        const request = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: randomUUID(),
            titleContent: { t: 'plain', v: { v: 1, title: 'Atomic first addressing' } },
            participants: [{ kind: 'session', sessionId: selected.id }, { kind: 'session', sessionId: unaddressed.id }],
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: content }, authoredContent: content,
                mentionedAccountIds: [], mentionedSessionIds: addressed ? [selected.id] : [] } });
        const send = (payload: DiscussionCreateRequestV1) => app.inject({ method: 'POST', url: DISCUSSION_HTTP_PATHS_V1.collection,
            headers: { 'x-test-user-id': owner.id }, payload });
        try {
            const response = await send(request);
            expect(response.statusCode, response.body).toBe(200);
            const created = DiscussionCreateResponseV1Schema.parse(response.json());
            expect(created).toMatchObject({ discussion: { messageSeq: 1 }, firstMessage: { seq: 1,
                addressingV1: { throughSeq: 1, participantSessionIds: addressed ? [selected.id] : [] } } });
            const observe = (destinationSessionId: string) => inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
                principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId,
            }));
            const observations = (await observe(selected.id)).observations;
            expect(observations).toEqual(addressed ? [expect.objectContaining({ addressing: { discussionId: created.discussion.id,
                messageId: created.firstMessage.id, throughSeq: 1, participantSessionId: selected.id } })] : []);
            expect((await observe(unaddressed.id)).observations).toEqual([]);
            const cursor = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            const replay = await send(request);
            expect(replay.statusCode, replay.body).toBe(200);
            expect(DiscussionCreateResponseV1Schema.parse(replay.json())).toEqual(created);
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(cursor);
            expect((await observe(selected.id)).observations).toEqual(observations);
            if (addressed) {
                const addressing = { discussionId: created.discussion.id, messageId: created.firstMessage.id, throughSeq: 1,
                    participantSessionId: selected.id };
                const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
                await inTx(async tx => {
                    const progress = await createSessionInputReplyProgressInTx(tx, { accountId: owner.id, reply: { mode: 'return', discussion: addressing } });
                    if (!progress) throw new Error('Initial original reply custody unavailable');
                    await tx.sessionPendingMessage.create({ data: { sessionId: selected.id, localId, position: 1,
                        content: { t: 'plain', v: {} }, requestedAction: DEFAULT_PENDING_REQUESTED_ACTION_V1, replyProgress: progress,
                        inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', discussionAddressing: addressing,
                            admittedTarget: { homeId: 'home', accountId: owner.id, sessionId: selected.id, machineId: 'machine', installationId: 'installation' } } } });
                    await acknowledgeDiscussionFollowInputInTx(tx, { addressing, localInputId: localId });
                });
                expect((await observe(selected.id)).observations).toEqual([]);
                expect((await send(request)).statusCode).toBe(200);
                expect((await observe(selected.id)).observations).toEqual([]);
                expect(await db.sessionFollowEdge.findFirst({ where: { sourceDiscussionId: created.discussion.id,
                    destinationSessionId: selected.id } })).toMatchObject({ deliveredTranscriptSeq: 1 });
            }
            for (const sessionId of [uninvited.id, randomUUID()]) {
                const invalidContent = { v: 1 as const, parts: [{ t: 'mention' as const, participant: { kind: 'session' as const, sessionId } }] };
                const invalid = buildDiscussionMutationRequestBodyV1({ kind: 'create', titleContent: request.titleContent,
                    participants: request.participants, creationLocalId: randomUUID(),
                    firstMessage: { localId: randomUUID(), content: { t: 'plain', v: invalidContent }, authoredContent: invalidContent,
                        mentionedAccountIds: [], mentionedSessionIds: [sessionId] } });
                const rejected = await send(invalid);
                expect(rejected.statusCode, rejected.body).toBe(400);
                expect(rejected.json()).toEqual({ error: 'discussion_invalid_mention' });
                expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(cursor);
            }
            expect(await db.discussion.count({ where: { ownerAccountId: owner.id } })).toBe(1);
            expect(await db.discussionMessage.count({ where: { discussion: { ownerAccountId: owner.id } } })).toBe(1);
            expect(await db.discussionParticipant.count({ where: { discussion: { ownerAccountId: owner.id } } })).toBe(2);
            expect(await db.sessionFollowEdge.count({ where: { sourceDiscussionId: created.discussion.id } })).toBe(2);
            expect(await db.discussionKeyEnvelope.count({ where: { discussion: { ownerAccountId: owner.id } } })).toBe(0);
            expect(await db.discussionReadState.count({ where: { discussion: { ownerAccountId: owner.id } } })).toBe(1);
        } finally {
            await app.close();
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it.each(['session', 'message'] as const)('invites through HTTP after the source %s is deleted, but never bypasses a live private source', async deleted => {
        const [owner, reader, outsider] = await Promise.all([0, 1, 2].map(() => db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } })));
        const source = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const answer = await db.sessionMessage.create({ data: { sessionId: source.id, seq: 1, messageRole: 'agent', content: { t: 'plain', v: { text: 'Private source answer' } } } });
        const reviewer = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const sourceShare = await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: 'view' } });
        await db.sessionShare.create({ data: { sessionId: reviewer.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: 'view' } });
        const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Private source answer' }] };
        const request = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: randomUUID(),
            anchor: { kind: 'session', sessionId: source.id, messageId: answer.id },
            titleContent: { t: 'plain', v: { v: 1, title: 'Retained source' } }, participants: [{ kind: 'account', accountId: reader.id }],
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: content }, authoredContent: content, mentionedAccountIds: [] } });
        const app: Fastify = createAuthenticatedTestApp();
        registerDiscussionRoutes(app);
        await app.ready();
        try {
            const created = await createDiscussion({ authentication, actorAccountId: owner.id, request });
            if (!created.ok) throw new Error(created.error);
            const discussionId = created.value.discussion.id;
            const invite = (participant: { kind: 'session'; sessionId: string } | { kind: 'account'; accountId: string }) => app.inject({ method: 'POST',
                url: DISCUSSION_HTTP_PATHS_V1.invite.replace(':discussionId', discussionId), headers: { 'x-test-user-id': owner.id }, payload: { participant } });
            const target = { kind: 'session' as const, sessionId: reviewer.id };
            const person = { kind: 'account' as const, accountId: outsider.id };
            await db.sessionShare.delete({ where: { id: sourceShare.id } });
            for (const participant of [target, person]) {
                const denied = await invite(participant);
                expect(denied.statusCode, denied.body).toBe(403);
                expect(denied.json()).toEqual({ error: 'discussion_access_forbidden' });
            }
            expect(await db.discussionParticipant.count({ where: { discussionId } })).toBe(0);
            expect(await db.sessionFollowEdge.count({ where: { sourceDiscussionId: discussionId } })).toBe(0);
            if (deleted === 'session') expect(await deleteOwnedSession({ sessionId: source.id, ownerAccountId: owner.id, reason: 'user_request' })).toEqual({ ok: true });
            else await db.sessionMessage.delete({ where: { id: answer.id } });
            const accepted = await invite(target);
            expect(accepted.statusCode, accepted.body).toBe(200);
            expect(accepted.json()).toMatchObject({ changed: true });
            expect(accepted.body).not.toContain('Private source answer');
            expect((await invite(target)).json()).toMatchObject({ changed: false });
            expect((await invite(person)).statusCode).toBe(200);
            expect(await db.discussionParticipant.count({ where: { discussionId, sessionId: reviewer.id } })).toBe(1);
            expect(await db.sessionFollowEdge.findFirst({ where: { sourceDiscussionId: discussionId, destinationSessionId: reviewer.id } }))
                .toMatchObject({ sourceSessionId: null, deliveredTranscriptSeq: 1 });
            expect(await db.sessionShare.count({ where: { sessionId: source.id } })).toBe(0);
            expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(1);
            expect((await db.discussion.findUniqueOrThrow({ where: { id: discussionId } })).messageSeq).toBe(1);
        } finally {
            await app.close();
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, reader.id, outsider.id] } } });
        }
    });

    it("allocates concurrent sequences, retains erased authors and survives source deletion", async () => {
        const owner = await db.account.create({
            data: { publicKey: `discussion-contract-owner-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const author = await db.account.create({
            data: { publicKey: `discussion-contract-author-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `discussion-contract-${randomUUID()}`,
                encryptionMode: "plain",
                metadata: "{}",
            },
            select: { id: true },
        });
        await db.sessionShare.create({
            data: {
                sessionId: session.id,
                sharedByUserId: owner.id,
                sharedWithUserId: author.id,
                accessLevel: "edit",
            },
        });

        try {
            const createRequest = {
                creationLocalId: `create-${randomUUID()}`,
                anchor: { kind: 'session', sessionId: session.id },
                participants: [{ kind: 'account', accountId: author.id }],
                titleContent: { t: "plain", v: { v: 1, title: "Provider contract" } },
                firstMessage: {
                    localId: `message-${randomUUID()}`,
                    content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "First" }] } },
                    mentionedAccountIds: [author.id],
                },
            } satisfies DiscussionCreateRequestV1;
            const created = await createDiscussion({
                authentication,
                actorAccountId: owner.id,
                request: createRequest,
            });
            expect(created.ok).toBe(true);
            if (!created.ok) return;

            const posts = await Promise.all(["second", "third"].map(async (text) => postDiscussionMessage({
                authentication,
                actorAccountId: author.id,
                discussionId: created.value.discussion.id,
                request: {
                    localId: `${text}-${randomUUID()}`,
                    content: { t: "plain", v: { v: 1, parts: [{ t: "text", text }] } },
                    mentionedAccountIds: [],
                },
            })));
            expect(posts.every((post) => post.ok)).toBe(true);
            expect((await db.discussionMessage.findMany({
                where: { discussionId: created.value.discussion.id },
                orderBy: { seq: "asc" },
                select: { seq: true },
            })).map((row) => row.seq)).toEqual([1, 2, 3]);
            expect(await db.discussionMessageMention.count({
                where: {
                    accountId: author.id,
                    message: { discussionId: created.value.discussion.id },
                },
            })).toBe(1);

            await db.sessionShare.deleteMany({ where: { sessionId: session.id, sharedWithUserId: author.id } });
            await db.account.delete({ where: { id: author.id } });
            expect(await db.discussionMessage.count({
                where: { discussionId: created.value.discussion.id, authorAccountId: null },
            })).toBe(2);
            expect(await db.discussionMessageMention.count({
                where: { message: { discussionId: created.value.discussion.id } },
            })).toBe(0);
            await db.session.delete({ where: { id: session.id } });
            expect(await db.discussion.count({ where: { id: created.value.discussion.id } })).toBe(1);
            expect(await db.discussionMessage.count({
                where: { discussionId: created.value.discussion.id },
            })).toBe(3);
        } finally {
            await db.session.deleteMany({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, author.id] } } });
        }
    });
});
