import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyRequest } from "fastify";
import type { Socket } from "socket.io";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { applySessionReadCursorOperation, applySessionTurnMutation, updateSessionAgentState, updateSessionMetadata } from "@/app/session/sessionWriteService";
import { createLegacyLayout0SessionInTx } from "@/app/session/create/createLegacyLayout0Session";
import { writeSessionTranscriptMessageInTx } from "@/app/session/sessionTranscriptWrite";
import { registerSessionReadStateRoutes } from "@/app/api/routes/session/registerSessionReadStateRoutes";
import { sessionUpdateHandler } from "@/app/api/socket/sessionUpdateHandler";
import { createAuthenticatedFakeSocket, getSocketHandler } from "@/app/api/testkit/socketHarness";
import { eventRouter, type ClientConnection } from "@/app/events/eventRouter";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";

import {
    advanceCaughtUpViewerReadCursorsInTx,
    applyViewerReadCursorOperation,
    applyViewerReadCursorOperationInTx,
    beginViewerReadTrackingOnFollowEntryInTx,
    initializeSessionOwnerReadStateInTx,
    listRelevantAccountIdsForSessionBadgeRefresh,
    stampViewerUnreadEntryInTx,
} from "./readState";
import { loadSessionViewerProjection } from "./projection";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from "@happier-dev/protocol";
import { decodeBase64 } from "privacy-kit";

const authentication = createPresentUserSessionAccessAuthentication();

describe("private viewer read state (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-viewer-read-state-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.discussionReadState.deleteMany(),
            () => db.discussion.deleteMany(),
            () => db.accountSessionReadState.deleteMany(),
            () => db.sessionShare.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createSharedSession(params: { seq: number }) {
        const [owner, collaborator] = await Promise.all([
            db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } }),
            db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } }),
        ]);
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: crypto.randomUUID(),
                metadata: "{}",
                seq: params.seq,
                currentStorageState: "hosted",
                active: true,
            },
        });
        await db.sessionShare.create({
            data: {
                sessionId: session.id,
                sharedWithUserId: collaborator.id,
                sharedByUserId: owner.id,
                accessLevel: "edit",
            },
        });
        await inTx(async (tx) => {
            await initializeSessionOwnerReadStateInTx(tx, {
                accountId: owner.id,
                sessionId: session.id,
                lastViewedSessionSeq: params.seq,
            });
        });
        return { owner, collaborator, session };
    }

    it.each(["message", "finished_with_message", "failed", "request"] as const)(
        "represents an app-closed owner's committed %s effect through the real personal projection without enrollment",
        async kind => {
            const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
            const session = await inTx(tx => createLegacyLayout0SessionInTx(tx, {
                accountId: owner.id, tag: crypto.randomUUID(), metadata: "{}", agentState: null,
                encryptionMode: "plain", requestedStorageState: undefined, dataEncryptionKey: null,
            }));
            const read = () => loadSessionViewerProjection({ accountId: owner.id, sessionId: session.id, authentication });
            expect(await read()).toMatchObject({ readState: { state: "tracking", lastViewedSessionSeq: 0 },
                attention: { needsAttention: false } });
            const appendOriginal = async () => {
                expect(await inTx(tx => writeSessionTranscriptMessageInTx(tx, {
                    sessionId: session.id, writeAuthority: "hosted", sessionEncryptionMode: "plain", storagePolicy: "optional",
                    content: { t: "plain", v: kind === "finished_with_message"
                        ? { role: "agent", content: { type: "acp", agentId: "codex", data: { type: "task_complete", id: session.id } } }
                        : { role: "user", content: { type: "text", text: "Original source material" } } },
                    localId: crypto.randomUUID(), sidechainId: null, messageRole: kind === "finished_with_message" ? "event" : "user", createdAt: new Date(100),
                }))).toMatchObject({ ok: true });
            };
            if (kind === "message") await appendOriginal();
            else {
                const turnId = crypto.randomUUID();
                const original = { v: 1, sessionId: session.id, turnId };
                expect(await applySessionTurnMutation({ actorUserId: owner.id, authentication,
                    mutation: { ...original, action: "begin", mutationId: crypto.randomUUID(), observedAt: 100 },
                })).toMatchObject({ ok: true, didApply: true });
                if (kind === "finished_with_message") {
                    await appendOriginal();
                    expect(await db.sessionMessage.findFirst({ where: { sessionId: session.id } })).toMatchObject({
                        content: { t: "plain", v: { role: "agent", content: { type: "acp", data: { type: "task_complete" } } } },
                    });
                }
                if (kind === "request") {
                    const requestId = crypto.randomUUID();
                    expect(await updateSessionAgentState({ actorUserId: owner.id, sessionId: session.id, expectedVersion: 0,
                        agentStateCiphertext: JSON.stringify({ requests: { [requestId]: {
                            kind: "user_action", tool: "AskUserQuestion", arguments: {}, createdAt: 150,
                        } } }), pendingUserActionRequestCount: 1,
                        userActionRequiredOccurrences: [{ sourceTurnId: turnId, requestId, requestKind: "user_action", occurredAt: 150 }],
                    })).toMatchObject({ ok: true });
                } else {
                    const mutation = { ...original, mutationId: crypto.randomUUID(), observedAt: 200 };
                    expect(await applySessionTurnMutation({ actorUserId: owner.id, authentication,
                        mutation: kind === "finished_with_message" ? { ...mutation, action: "complete" } : { ...mutation, action: "fail",
                            issue: { v: 1, scope: "primary_session", status: "failed", code: "test_failure", source: "unknown", occurredAt: 200 } },
                    })).toMatchObject({ ok: true, didApply: true });
                }
            }
            const reason = kind === "message" || kind === "finished_with_message" ? "unread"
                : kind === "failed" ? "failed" : "user_action_required";
            expect(await read()).toMatchObject({ attention: { needsAttention: true, reasons: expect.arrayContaining([reason]) } });
            expect(await db.accountSessionFollow.count({ where: { accountId: owner.id, sessionId: session.id } })).toBe(0);
            if (kind === "message" || kind === "finished_with_message") {
                expect(await applyViewerReadCursorOperation({ accountId: owner.id, sessionId: session.id,
                    operation: { kind: "mark-read" }, authentication })).toMatchObject({ ok: true });
                // This source-backed representation is current attention, not historical delivery custody.
                expect(await read()).toMatchObject({ attention: { needsAttention: false } });
            }
        },
    );

    it("lets a tracked view-only reader change its own frontier without changing another Account", async () => {
        const { owner, collaborator, session } = await createSharedSession({ seq: 5 });
        await db.sessionShare.updateMany({ where: { sessionId: session.id, sharedWithUserId: collaborator.id }, data: { accessLevel: "view" } });
        await db.accountSessionFollow.create({ data: { accountId: collaborator.id, sessionId: session.id, following: true, notificationLevel: "none" } });
        await inTx(async (tx) => {
            await beginViewerReadTrackingOnFollowEntryInTx({
                tx,
                accountId: collaborator.id,
                sessionId: session.id,
                wasTracked: false,
            });
        });
        await db.session.update({ where: { id: session.id }, data: { seq: 9 } });

        const marked = await applyViewerReadCursorOperation({
            accountId: collaborator.id,
            sessionId: session.id,
            operation: { kind: "mark-read" },
            authentication,
        });
        expect(marked.ok).toBe(true);

        const rows = await db.accountSessionReadState.findMany({
            where: { sessionId: session.id },
            orderBy: { accountId: "asc" },
        });
        const byAccount = new Map(rows.map((row) => [row.accountId, row.lastViewedSessionSeq]));
        expect(byAccount.get(collaborator.id)).toBe(9);
        expect(byAccount.get(owner.id)).toBe(5);
    });

    it("lets an accessible untracked reader mark its own frontier without enrolling it in attention", async () => {
        const { owner, collaborator, session } = await createSharedSession({ seq: 5 });
        await db.sessionShare.updateMany({ where: { sessionId: session.id, sharedWithUserId: collaborator.id }, data: { accessLevel: "view" } });

        const marked = await applyViewerReadCursorOperation({
            accountId: collaborator.id,
            sessionId: session.id,
            operation: { kind: "mark-unread" },
            authentication,
        });

        expect(marked).toMatchObject({ ok: true, didChange: true, readState: "unread", lastViewedSessionSeq: 4 });
        const rows = await db.accountSessionReadState.findMany({ where: { sessionId: session.id } });
        expect(rows.find((row) => row.accountId === collaborator.id)).toMatchObject({ lastViewedSessionSeq: 4 });
        expect(rows.find((row) => row.accountId === collaborator.id)?.unreadSince).toBeInstanceOf(Date);
        expect(rows.find((row) => row.accountId === owner.id)).toMatchObject({ lastViewedSessionSeq: 5, unreadSince: null });

        // The reader's own frontier is visible to that reader; owner-or-Follow
        // tracking still decides attention, badge membership and automatic stamping.
        const viewer = await loadSessionViewerProjection({ accountId: collaborator.id, sessionId: session.id, authentication });
        expect(viewer?.readState).toEqual({ state: "tracking", lastViewedSessionSeq: 4, unreadSince: expect.any(Number) });
        expect(viewer?.attention.needsAttention).toBe(false);
        expect(await listRelevantAccountIdsForSessionBadgeRefresh(session.id)).toEqual([owner.id]);

        const read = await applyViewerReadCursorOperation({
            accountId: collaborator.id, sessionId: session.id, operation: { kind: "mark-read" }, authentication,
        });
        expect(read).toMatchObject({ ok: true, didChange: true, readState: "read", lastViewedSessionSeq: 5 });
    });

    it("seeds only the main frontier when an untracked reader marks a Session that has Discussions", async () => {
        const { owner, collaborator, session } = await createSharedSession({ seq: 5 });
        await db.sessionShare.updateMany({ where: { sessionId: session.id, sharedWithUserId: collaborator.id }, data: { accessLevel: "view" } });
        await db.discussion.create({
            data: {
                ownerAccountId: owner.id, encryptionMode: "plain", dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
                anchorSessionId: session.id, anchorV1: { kind: "session", sessionId: session.id },
                creationLocalId: crypto.randomUUID(),
                creationEqualityEvidenceV1: { kind: "plainDigest", digest: crypto.randomUUID() },
                createdByAccountId: owner.id,
                titleContent: { t: "plain", v: { v: 1, title: "Topic" } },
                messageSeq: 1,
                lastMessageAt: new Date(),
            },
        });

        const marked = await applyViewerReadCursorOperation({
            accountId: collaborator.id,
            sessionId: session.id,
            operation: { kind: "mark-unread" },
            authentication,
        });

        expect(marked).toMatchObject({ ok: true, didChange: true, lastViewedSessionSeq: 4 });
        // Session read operations cannot enroll an independent Discussion reader.
        expect(await db.discussionReadState.count({
            where: { accountId: collaborator.id, discussion: { anchorSessionId: session.id } },
        })).toBe(0);
    });

    it("never enrolls an untracked reader through an automatic advance or a composed acknowledgement", async () => {
        const { collaborator, session } = await createSharedSession({ seq: 5 });

        expect(await applyViewerReadCursorOperation({
            accountId: collaborator.id, sessionId: session.id, operation: { kind: "advance", lastViewedSessionSeq: 5 }, authentication,
        })).toEqual({ ok: false, error: "session-not-tracked" });
        expect(await inTx((tx) => applyViewerReadCursorOperationInTx(tx, {
            accountId: collaborator.id, sessionId: session.id, operation: { kind: "mark-read" }, authentication,
        }))).toEqual({ ok: false, error: "session-not-tracked" });
        expect(await db.accountSessionReadState.count({
            where: { sessionId: session.id, accountId: collaborator.id },
        })).toBe(0);
    });

    it("serializes the acting viewer on HTTP read success for owners and accessible readers alike", async () => {
        const { owner, collaborator, session } = await createSharedSession({ seq: 5 });
        await db.session.update({ where: { id: session.id }, data: { seq: 9 } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        let authenticatedAccountId = owner.id;
        // Authentication is the network boundary; all access, cursor and projection owners stay real.
        app.decorate("authenticate", async (request: FastifyRequest) => {
            request.userId = authenticatedAccountId;
            request.authTokenKind = "account";
            request.authAuthority = "present_user";
        });
        registerSessionReadStateRoutes(app);
        try {
            const url = `/v2/sessions/${session.id}/read-state`;
            const marked = await app.inject({ method: "POST", url, payload: { state: "read" } });
            expect(marked.statusCode).toBe(200);
            expect(marked.json()).toMatchObject({
                success: true, state: "read", lastViewedSessionSeq: 9, didChange: true,
                viewer: { readState: { state: "tracking", lastViewedSessionSeq: 9, unreadSince: null } },
            });
            authenticatedAccountId = collaborator.id;
            const untracked = await app.inject({ method: "POST", url, payload: { state: "unread" } });
            expect(untracked.statusCode).toBe(200);
            expect(untracked.json()).toMatchObject({
                success: true, state: "unread", lastViewedSessionSeq: 8, didChange: true,
                viewer: { readState: { state: "tracking", lastViewedSessionSeq: 8 }, attention: { needsAttention: false } },
            });
            expect(await db.accountSessionReadState.count({ where: { accountId: collaborator.id, sessionId: session.id } })).toBe(1);
            expect(await db.accountSessionReadState.findUnique({
                where: { accountId_sessionId: { accountId: owner.id, sessionId: session.id } },
            })).toMatchObject({ lastViewedSessionSeq: 9, unreadSince: null });
        } finally {
            await app.close();
        }
    });

    it("returns private viewer socket acknowledgements for advance and deliberate read operations", async () => {
        const { owner, collaborator, session } = await createSharedSession({ seq: 5 });
        await db.session.update({ where: { id: session.id }, data: { seq: 9 } });
        // The Socket transport is the boundary; the service, access and projection are real.
        const socket = createAuthenticatedFakeSocket();
        const transport = socket as unknown as Socket;
        sessionUpdateHandler(owner.id, transport, {
            connectionType: "session-scoped", socket: transport, userId: owner.id, sessionId: session.id,
        });
        const handler = getSocketHandler(socket, "update-read-cursor");
        const callback = vi.fn();

        await handler({ sid: session.id, lastViewedSessionSeq: 99 }, callback);
        expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({
            result: "success", lastViewedSessionSeq: 9,
            viewer: expect.objectContaining({ readState: { state: "tracking", lastViewedSessionSeq: 9, unreadSince: null } }),
        }));
        await handler({ sid: session.id, operation: "mark-unread", lastViewedSessionSeq: 99 }, callback);
        expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({
            result: "success", lastViewedSessionSeq: 8, didChange: true, readState: "unread",
            viewer: expect.objectContaining({ readState: { state: "tracking", lastViewedSessionSeq: 8, unreadSince: expect.any(Number) } }),
        }));
        await handler({ sid: session.id, operation: "mark-read" }, callback);
        expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({
            result: "success", lastViewedSessionSeq: 9, didChange: true, readState: "read",
        }));
        expect(await db.accountSessionReadState.count({ where: { accountId: collaborator.id, sessionId: session.id } })).toBe(0);
        expect(await db.accountChange.count({ where: { accountId: collaborator.id, sessionId: session.id } })).toBe(0);
    });

    it("does not repair missing tracking initialization through an automatic or composed cursor write", async () => {
        const { owner, session } = await createSharedSession({ seq: 5 });
        await db.accountSessionReadState.deleteMany({ where: { accountId: owner.id, sessionId: session.id } });

        const result = await applyViewerReadCursorOperation({
            accountId: owner.id, sessionId: session.id, operation: { kind: "advance", lastViewedSessionSeq: 5 }, authentication,
        });

        expect(result).toEqual({ ok: false, error: "internal" });
        expect(await inTx((tx) => applyViewerReadCursorOperationInTx(tx, {
            accountId: owner.id, sessionId: session.id, operation: { kind: "mark-read" }, authentication,
        }))).toEqual({ ok: false, error: "internal" });
        expect(await db.accountSessionReadState.count({ where: { sessionId: session.id } })).toBe(0);
        expect(await db.accountChange.count({ where: { accountId: owner.id } })).toBe(0);
    });

    it("starts a fresh Follow at the current ceiling rather than replaying the interval away", async () => {
        const { collaborator, session } = await createSharedSession({ seq: 5 });
        await inTx(async (tx) => {
            await beginViewerReadTrackingOnFollowEntryInTx({
                tx, accountId: collaborator.id, sessionId: session.id, wasTracked: false,
            });
        });
        await db.session.update({ where: { id: session.id }, data: { seq: 40 } });
        await inTx(async (tx) => {
            await beginViewerReadTrackingOnFollowEntryInTx({
                tx, accountId: collaborator.id, sessionId: session.id, wasTracked: false,
            });
        });

        const row = await db.accountSessionReadState.findUnique({
            where: { accountId_sessionId: { accountId: collaborator.id, sessionId: session.id } },
        });
        expect(row?.lastViewedSessionSeq).toBe(40);
        expect(row?.unreadSince).toBeNull();
    });

    it("preserves an already tracked frontier when Follow entry is re-applied", async () => {
        const { owner, session } = await createSharedSession({ seq: 5 });
        await db.session.update({ where: { id: session.id }, data: { seq: 12 } });
        await inTx(async (tx) => {
            await beginViewerReadTrackingOnFollowEntryInTx({
                tx, accountId: owner.id, sessionId: session.id, wasTracked: true,
            });
        });

        const row = await db.accountSessionReadState.findUnique({
            where: { accountId_sessionId: { accountId: owner.id, sessionId: session.id } },
        });
        expect(row?.lastViewedSessionSeq).toBe(5);
    });

    it("advances only caught-up cursors on a non-unread message and never creates a row", async () => {
        const { owner, collaborator, session } = await createSharedSession({ seq: 5 });
        await inTx(async (tx) => {
            await beginViewerReadTrackingOnFollowEntryInTx({
                tx, accountId: collaborator.id, sessionId: session.id, wasTracked: false,
            });
        });
        await db.accountSessionReadState.update({
            where: { accountId_sessionId: { accountId: collaborator.id, sessionId: session.id } },
            data: { lastViewedSessionSeq: 2, unreadSince: new Date(1_000) },
        });
        await db.session.update({ where: { id: session.id }, data: { seq: 7 } });

        const advanced = await inTx(async (tx) => await advanceCaughtUpViewerReadCursorsInTx(tx, {
            sessionId: session.id,
            previousVisibleSeq: 5,
            nextVisibleSeq: 7,
        }));

        expect(advanced).toBe(1);
        const rows = await db.accountSessionReadState.findMany({ where: { sessionId: session.id } });
        const byAccount = new Map(rows.map((row) => [row.accountId, row.lastViewedSessionSeq]));
        expect(byAccount.get(owner.id)).toBe(7);
        expect(byAccount.get(collaborator.id)).toBe(2);
        expect(rows).toHaveLength(2);
    });

    it("never regresses a cursor already beyond a non-unread publication transition", async () => {
        const { owner, session } = await createSharedSession({ seq: 12 });

        const advanced = await inTx(tx => advanceCaughtUpViewerReadCursorsInTx(tx, {
            sessionId: session.id,
            previousVisibleSeq: 9,
            nextVisibleSeq: 10,
        }));

        const row = await db.accountSessionReadState.findUniqueOrThrow({
            where: { accountId_sessionId: { accountId: owner.id, sessionId: session.id } },
        });
        expect(row.lastViewedSessionSeq).toBe(12);
        expect(advanced).toBe(0);
    });

    it("stamps the unread-entry instant once per read-to-unread transition", async () => {
        const { owner, session } = await createSharedSession({ seq: 5 });
        await db.session.update({ where: { id: session.id }, data: { seq: 6 } });

        const first = new Date(10_000);
        const second = new Date(20_000);
        await inTx(async (tx) => await stampViewerUnreadEntryInTx(tx, {
            sessionId: session.id, visibleSessionSeq: 6, at: first,
        }));
        await inTx(async (tx) => await stampViewerUnreadEntryInTx(tx, {
            sessionId: session.id, visibleSessionSeq: 7, at: second,
        }));

        const row = await db.accountSessionReadState.findUnique({
            where: { accountId_sessionId: { accountId: owner.id, sessionId: session.id } },
        });
        expect(row?.unreadSince?.getTime()).toBe(first.getTime());
        expect(row?.lastViewedSessionSeq).toBe(5);
    });

    it("lowers a manual unread frontier and stamps a fresh instant", async () => {
        const { owner, session } = await createSharedSession({ seq: 5 });

        const result = await applyViewerReadCursorOperation({
            accountId: owner.id,
            sessionId: session.id,
            operation: { kind: "mark-unread" },
            authentication,
        });

        expect(result.ok).toBe(true);
        const row = await db.accountSessionReadState.findUnique({
            where: { accountId_sessionId: { accountId: owner.id, sessionId: session.id } },
        });
        expect(row?.lastViewedSessionSeq).toBeLessThan(5);
        expect(row?.unreadSince).not.toBeNull();
    });

    it("wakes only the acting Account, never the other reader", async () => {
        const { owner, collaborator, session } = await createSharedSession({ seq: 5 });
        await db.session.update({ where: { id: session.id }, data: { seq: 9 } });
        await db.accountChange.deleteMany();

        const result = await applySessionReadCursorOperation({
            actorUserId: owner.id,
            sessionId: session.id,
            operation: { kind: "mark-read" },
            authentication,
        });

        expect(result.ok).toBe(true);
        const ownerRead = await db.accountSessionReadState.findUnique({
            where: { accountId_sessionId: { accountId: owner.id, sessionId: session.id } },
        });
        expect(ownerRead?.lastViewedSessionSeq).toBe(9);
        const changes = await db.accountChange.findMany({ select: { accountId: true } });
        expect(changes.map((change) => change.accountId)).toEqual([owner.id]);
        expect(changes.some((change) => change.accountId === collaborator.id)).toBe(false);
    });

    it("schedules badge refresh only for Accounts that personally track the Session", async () => {
        const { owner, collaborator, session } = await createSharedSession({ seq: 5 });

        const accountIds = await listRelevantAccountIdsForSessionBadgeRefresh(session.id);

        expect(accountIds).toEqual([owner.id]);
        expect(accountIds).not.toContain(collaborator.id);
    });

    it("initializes owner tracking in the released creation transaction", async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const socket = createAuthenticatedFakeSocket();
        const connection: ClientConnection = {
            connectionType: "user-scoped", userId: owner.id, socket: socket as unknown as Socket,
        };
        eventRouter.addConnection(owner.id, connection);
        try {
            const session = await inTx(tx => createLegacyLayout0SessionInTx(tx, {
                accountId: owner.id, tag: crypto.randomUUID(), metadata: "{}", agentState: null,
                encryptionMode: "plain", requestedStorageState: undefined, dataEncryptionKey: null,
            }));
            expect(await db.accountSessionReadState.findUnique({
                where: { accountId_sessionId: { accountId: owner.id, sessionId: session.id } },
            })).toMatchObject({ lastViewedSessionSeq: 0, unreadSince: null });
            expect(socket.emit).toHaveBeenCalledWith("update", expect.objectContaining({
                body: expect.objectContaining({ t: "new-session", id: session.id,
                    viewer: expect.objectContaining({ readState: { state: "tracking", lastViewedSessionSeq: 0, unreadSince: null } }),
                }),
            }));
        } finally {
            eventRouter.removeConnection(owner.id, connection);
        }
    });

    it("leaves a retained unfollowed frontier inert on source mutations", async () => {
        const { owner, collaborator, session } = await createSharedSession({ seq: 5 });
        await inTx(tx => beginViewerReadTrackingOnFollowEntryInTx({
            tx, accountId: collaborator.id, sessionId: session.id, wasTracked: false,
        }));
        await inTx(tx => advanceCaughtUpViewerReadCursorsInTx(tx, {
            sessionId: session.id, previousVisibleSeq: 5, nextVisibleSeq: 6,
        }));
        await inTx(tx => stampViewerUnreadEntryInTx(tx, {
            sessionId: session.id, visibleSessionSeq: 7, at: new Date(42_000),
        }));
        const rows = await db.accountSessionReadState.findMany({ where: { sessionId: session.id } });
        expect(rows.find(row => row.accountId === collaborator.id)).toMatchObject({ lastViewedSessionSeq: 5, unreadSince: null });
        expect(rows.find(row => row.accountId === owner.id)).toMatchObject({ lastViewedSessionSeq: 6, unreadSince: new Date(42_000) });
    });

    it("routes the released owner metadata cursor hint to the private frontier", async () => {
        const { owner, collaborator, session } = await createSharedSession({ seq: 5 });
        await db.session.update({ where: { id: session.id }, data: { encryptionMode: "plain", seq: 9 } });
        await db.accountChange.deleteMany();
        const result = await updateSessionMetadata({
            actorUserId: owner.id, sessionId: session.id, expectedVersion: session.metadataVersion,
            metadataCiphertext: "{}", readCursorHintV1: { lastViewedSessionSeq: 9 },
            authentication,
        });
        expect(result.ok).toBe(true);
        expect(await db.accountSessionReadState.findUnique({
            where: { accountId_sessionId: { accountId: owner.id, sessionId: session.id } },
        })).toMatchObject({ lastViewedSessionSeq: 9 });
        expect(await db.accountChange.count({ where: { accountId: collaborator.id } })).toBe(0);
    });

    it("updates tracked unread at the canonical hosted transcript insert without reading new content", async () => {
        const { owner, collaborator, session } = await createSharedSession({ seq: 5 });
        await db.accountSessionFollow.create({ data: { accountId: collaborator.id, sessionId: session.id, following: true, notificationLevel: "none" } });
        await inTx(tx => beginViewerReadTrackingOnFollowEntryInTx({ tx, accountId: collaborator.id, sessionId: session.id, wasTracked: false }));
        const at = new Date(42_000);
        const result = await inTx(tx => writeSessionTranscriptMessageInTx(tx, {
            sessionId: session.id, writeAuthority: "hosted", sessionEncryptionMode: "plain", storagePolicy: "optional",
            content: { t: "plain", v: { role: "user", content: { type: "text", text: "new material" } } },
            localId: crypto.randomUUID(), sidechainId: null, messageRole: "user", createdAt: at,
        }));
        expect(result.ok).toBe(true);
        const rows = await db.accountSessionReadState.findMany({ where: { sessionId: session.id } });
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.lastViewedSessionSeq).toBe(5);
            expect(row.unreadSince).toEqual(at);
        }
        expect(rows.map(row => row.accountId)).toEqual(expect.arrayContaining([owner.id, collaborator.id]));
    });
});
