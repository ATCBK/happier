import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as ioClient, type Socket } from "socket.io-client";
import { startSocket } from "@/app/api/socket";
import type { Fastify as AppFastify } from "@/app/api/types";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { SessionHumanPresenceSnapshotV1Schema, type SessionHumanPresenceSnapshotV1 } from "@happier-dev/protocol/sessions";
import { inTx } from "@/storage/inTx";
import { deleteSessionAccessGrantInTx, putSessionAccessGrantInTx } from "@/app/session/access/sessionAccessGrantService";
import { notifySessionHumanPresenceAccessChanged } from "./sessionHumanPresenceService";

const visibleEvent = "session-human-presence:visible-replace";
const snapshotEvent = "session-human-presence:snapshot";
// The real client declares under its existing 7.5s socket acknowledgement deadline.
// Staying below it keeps this a meaningful bound while absorbing the first cold
// Prisma/SQLite access query, which a 1s budget could not.
const ACK_TIMEOUT_MS = 5_000;
const ownerAuthentication = () => ({ env: process.env, authority: "present_user" as const, authenticationEvidence: [] });

function deferred<T = void>(): Readonly<{
    promise: Promise<T>;
    resolve: (value: T) => void;
}> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

/**
 * Pauses the real SQLite Discussion delegate after the first matching row has
 * been read. The third matching read is the next projection cycle only when
 * the active cycle performed a final pre-emit currentness read first.
 */
function installDiscussionPresenceReadBarrier(input: Readonly<{
    sessionId: string;
    discussionId: string;
}>): Readonly<{
    firstRead: Promise<void>;
    nextProjectionRead: Promise<void>;
    releaseFirst: () => void;
    restore: () => void;
}> {
    const firstRead = deferred();
    const releaseFirst = deferred();
    const nextProjectionRead = deferred();
    const originalDelegate = db.sessionDiscussion;
    const originalFindFirst = originalDelegate.findFirst;
    let matchingReadCount = 0;
    let restored = false;

    const delegate = new Proxy(originalDelegate, {
        get(target, property, receiver) {
            if (property !== "findFirst") {
                const value: unknown = Reflect.get(target, property, receiver);
                return typeof value === "function" ? value.bind(target) : value;
            }
            return async (...args: Parameters<typeof originalFindFirst>) => {
                const result = await Reflect.apply(originalFindFirst, target, args);
                const candidate = args[0] as Readonly<{
                    where?: Readonly<{ id?: unknown; sessionId?: unknown }>;
                }> | undefined;
                if (candidate?.where?.id === input.discussionId
                    && candidate.where.sessionId === input.sessionId) {
                    matchingReadCount += 1;
                    if (matchingReadCount === 1) {
                        firstRead.resolve();
                        await releaseFirst.promise;
                    } else if (matchingReadCount === 3) {
                        nextProjectionRead.resolve();
                    }
                }
                return result;
            };
        },
    }) as typeof originalDelegate;
    Reflect.set(db, "sessionDiscussion", delegate);

    return {
        firstRead: firstRead.promise,
        nextProjectionRead: nextProjectionRead.promise,
        releaseFirst: () => releaseFirst.resolve(),
        restore: () => {
            if (restored) return;
            restored = true;
            releaseFirst.resolve();
            Reflect.set(db, "sessionDiscussion", originalDelegate);
        },
    };
}

describe("authenticated human presence over real memory-adapter sockets", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-human-presence-", initAuth: true, initEncrypt: true,
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("negotiates on the actual visible replacement, admits readable sessions, replaces and clears rooms", async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), name: "Owner" } });
        const other = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        // One real Socket.IO declaration deliberately exceeds the retired
        // Lane-local 16-Session ceiling. The transport's actual byte bound still
        // applies, but presence must not invent a smaller item-count boundary.
        const sessions = await Promise.all([...Array.from({ length: 20 }, () => owner.id), other.id].map(accountId => db.session.create({
            data: { accountId, tag: crypto.randomUUID(), metadata: "{}" },
        })));
        const token = await auth.createToken(owner.id, undefined, { kind: "account", authority: "present_user" });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP listener");
        const clients: Socket[] = [];
        const connect = async () => {
            const client = ioClient(`http://127.0.0.1:${address.port}`, {
                path: "/v1/updates", transports: ["websocket"], reconnection: false, autoConnect: false, auth: { token },
            });
            clients.push(client);
            await new Promise<void>((resolve, reject) => {
                client.once("connect", resolve);
                client.once("connect_error", reject);
                client.connect();
            });
            return client;
        };
        // A bare acknowledgement timeout names only Socket.IO internals, so each
        // declaration carries the step that actually stalled.
        const declare = async (step: string, client: Socket, payload: unknown): Promise<unknown> => {
            try {
                return await client.timeout(ACK_TIMEOUT_MS).emitWithAck(visibleEvent, payload);
            } catch (error) {
                throw new Error(`Human presence declaration "${step}" was not acknowledged: ${String(error)}`);
            }
        };
        try {
            const client = await connect();
            const snapshots: Array<{ sessionId: string; viewers: Array<{ account: { accountId: string }; typing: boolean }> }> = [];
            client.on(snapshotEvent, value => snapshots.push(value));
            const ids = sessions.slice(0, 20).map(session => session.id).sort();
            expect(await declare("initial", client, { v: 1, sessionIds: sessions.map(session => session.id) }))
                .toEqual({ v: 1, ok: true, admittedSessionIds: ids });
            await expect.poll(() => snapshots.some(value => value.sessionId === ids[0]
                && value.viewers.length === 1 && value.viewers[0].account.accountId === owner.id), {
                // Presence is best effort. Reuse the real client acknowledgement
                // budget here rather than inventing Vitest's implicit one-second
                // product deadline for the first cold SQLite projection.
                timeout: ACK_TIMEOUT_MS,
            }).toBe(true);
            const observer = await connect();
            const observed: Array<{ sessionId: string; viewers: unknown[] }> = [];
            observer.on(snapshotEvent, value => observed.push(value));
            // Declared while the first client's projections are still in flight: a second
            // tab must be admitted promptly instead of starving behind awareness reads.
            await declare("observer", observer, { v: 1, sessionIds: [ids[0]] });
            await expect.poll(() => observed.at(-1)?.viewers.length).toBe(1);
            expect(await declare("replace", client, { v: 1, sessionIds: [ids[1]] }))
                .toEqual({ v: 1, ok: true, admittedSessionIds: [ids[1]] });
            expect(await declare("empty", client, { v: 1, sessionIds: [] }))
                .toEqual({ v: 1, ok: true, admittedSessionIds: [] });
            expect(await declare("unsupported version", observer, { v: 2, sessionIds: [] }))
                .toEqual({ v: 1, ok: false, errorCode: "UNSUPPORTED_VERSION" });
            expect(await declare("malformed id", observer, { v: 1, sessionIds: [""] }))
                .toEqual({ v: 1, ok: false, errorCode: "INVALID_REQUEST" });
        } finally {
            clients.forEach(client => client.close());
            await app.close();
        }
    }, 30_000);

    it("isolates simultaneous Session and two-discussion declarations through replacement, revocation, and deletion", async () => {
        const [owner, sessionViewer, discussionAViewer, discussionBViewer, everywhereViewer] = await Promise.all([
            "Owner", "Session viewer", "Discussion A viewer", "Discussion B viewer", "Everywhere viewer",
        ].map(name => db.account.create({
            data: { publicKey: crypto.randomUUID(), name, encryptionMode: "plain" },
        })));
        const session = await db.session.create({ data: {
            accountId: owner.id,
            tag: crypto.randomUUID(),
            encryptionMode: "plain",
            metadata: JSON.stringify({ t: "plain", v: {} }),
        } });
        const [discussionA, discussionB] = await Promise.all(["Discussion A", "Discussion B"].map(title =>
            db.sessionDiscussion.create({ data: {
                sessionId: session.id,
                creationLocalId: crypto.randomUUID(),
                creationEqualityEvidenceV1: {},
                createdByAccountId: owner.id,
                titleContent: { t: "plain", v: { v: 1, title } },
                lastMessageAt: new Date(),
            } })));
        // Access is granted and later revoked through the real grant owner, whose
        // committed transition is the production publisher of the presence recheck.
        for (const account of [sessionViewer, discussionAViewer, discussionBViewer, everywhereViewer]) {
            await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: account.id, status: "friend" } });
            expect(await inTx(tx => putSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id,
                sessionId: session.id,
                subject: { kind: "account", accountId: account.id },
                grant: { accessLevel: "edit", canApprovePermissions: false },
                authentication: ownerAuthentication(),
            }))).toMatchObject({ ok: true, changed: true });
        }
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP listener");
        const clients: Socket[] = [];
        const observations = new Map<Socket, SessionHumanPresenceSnapshotV1[]>();
        const connect = async (accountId: string) => {
            const token = await auth.createToken(accountId, undefined, { kind: "account", authority: "present_user" });
            const client = ioClient(`http://127.0.0.1:${address.port}`, {
                path: "/v1/updates",
                transports: ["websocket"],
                reconnection: false,
                autoConnect: false,
                auth: { token },
            });
            clients.push(client);
            observations.set(client, []);
            client.on(snapshotEvent, value => observations.get(client)!.push(SessionHumanPresenceSnapshotV1Schema.parse(value)));
            await new Promise<void>((resolve, reject) => {
                client.once("connect", resolve);
                client.once("connect_error", reject);
                client.connect();
            });
            return client;
        };
        const locationA = { sessionId: session.id, discussionId: discussionA.id };
        const locationB = { sessionId: session.id, discussionId: discussionB.id };
        const sortedLocations = [locationA, locationB].sort((left, right) =>
            left.discussionId.localeCompare(right.discussionId));
        const declare = (
            client: Socket,
            sessionIds: readonly string[],
            locations: readonly Readonly<{ sessionId: string; discussionId: string }>[],
        ) => client.timeout(ACK_TIMEOUT_MS).emitWithAck(visibleEvent, { v: 1, sessionIds, locations });
        const latestAccountIds = (client: Socket, discussionId?: string) => observations.get(client)!
            .filter(value => value.sessionId === session.id && value.discussionId === discussionId)
            .at(-1)?.viewers.map(value => value.account.accountId).sort();
        const expectLocation = async (client: Socket, accountIds: readonly string[], discussionId?: string) => {
            await expect.poll(() => latestAccountIds(client, discussionId), { timeout: ACK_TIMEOUT_MS })
                .toEqual([...accountIds].sort());
        };
        try {
            const observerSocket = await connect(owner.id);
            const sessionSocket = await connect(sessionViewer.id);
            const discussionASocket = await connect(discussionAViewer.id);
            const discussionBSocket = await connect(discussionBViewer.id);
            const everywhereSocket = await connect(everywhereViewer.id);

            expect(await declare(observerSocket, [session.id], [locationA, locationB])).toEqual({
                v: 1,
                ok: true,
                admittedSessionIds: [session.id],
                admittedLocations: sortedLocations,
            });
            await Promise.all([
                declare(sessionSocket, [session.id], []),
                declare(discussionASocket, [], [locationA]),
                declare(discussionBSocket, [], [locationB]),
                declare(everywhereSocket, [session.id], [locationA, locationB]),
            ]);
            await expectLocation(observerSocket, [owner.id, sessionViewer.id, everywhereViewer.id]);
            await expectLocation(observerSocket, [owner.id, discussionAViewer.id, everywhereViewer.id], discussionA.id);
            await expectLocation(observerSocket, [owner.id, discussionBViewer.id, everywhereViewer.id], discussionB.id);

            expect(await declare(sessionSocket, [], [locationA])).toEqual({
                v: 1,
                ok: true,
                admittedSessionIds: [],
                admittedLocations: [locationA],
            });
            await expectLocation(observerSocket, [owner.id, everywhereViewer.id]);
            await expectLocation(
                observerSocket,
                [owner.id, sessionViewer.id, discussionAViewer.id, everywhereViewer.id],
                discussionA.id,
            );
            await expectLocation(observerSocket, [owner.id, discussionBViewer.id, everywhereViewer.id], discussionB.id);
            expect(await declare(sessionSocket, [], [locationB])).toEqual({
                v: 1,
                ok: true,
                admittedSessionIds: [],
                admittedLocations: [locationB],
            });
            await expectLocation(observerSocket, [owner.id, discussionAViewer.id, everywhereViewer.id], discussionA.id);
            await expectLocation(
                observerSocket,
                [owner.id, sessionViewer.id, discussionBViewer.id, everywhereViewer.id],
                discussionB.id,
            );
            expect(await declare(sessionSocket, [], [])).toEqual({
                v: 1,
                ok: true,
                admittedSessionIds: [],
                admittedLocations: [],
            });
            await expectLocation(observerSocket, [owner.id, discussionAViewer.id, everywhereViewer.id], discussionA.id);
            await expectLocation(observerSocket, [owner.id, discussionBViewer.id, everywhereViewer.id], discussionB.id);

            expect(await everywhereSocket.timeout(ACK_TIMEOUT_MS).emitWithAck(visibleEvent, {
                v: 2,
                sessionIds: [],
            })).toEqual({ v: 1, ok: false, errorCode: "UNSUPPORTED_VERSION" });
            expect(await everywhereSocket.timeout(ACK_TIMEOUT_MS).emitWithAck(visibleEvent, {
                v: 1,
                sessionIds: [],
                locations: [{ sessionId: session.id, discussionId: " " }],
            })).toEqual({ v: 1, ok: false, errorCode: "INVALID_REQUEST" });
            notifySessionHumanPresenceAccessChanged({ sessionId: session.id });
            await expectLocation(observerSocket, [owner.id, everywhereViewer.id]);
            await expectLocation(observerSocket, [owner.id, discussionAViewer.id, everywhereViewer.id], discussionA.id);
            await expectLocation(observerSocket, [owner.id, discussionBViewer.id, everywhereViewer.id], discussionB.id);

            expect(await inTx(tx => deleteSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id,
                sessionId: session.id,
                subject: { kind: "account", accountId: everywhereViewer.id },
                authentication: ownerAuthentication(),
            }))).toMatchObject({ ok: true, changed: true });
            await expectLocation(observerSocket, [owner.id]);
            await expectLocation(observerSocket, [owner.id, discussionAViewer.id], discussionA.id);
            await expectLocation(observerSocket, [owner.id, discussionBViewer.id], discussionB.id);

            const discussionBSnapshotCount = observations.get(observerSocket)!
                .filter(value => value.discussionId === discussionB.id).length;
            await db.sessionDiscussion.delete({ where: { id: discussionA.id } });
            const discussionADeletedAt = Date.now();
            notifySessionHumanPresenceAccessChanged({ sessionId: session.id });
            await expect.poll(() => observations.get(observerSocket)!
                .filter(value => value.discussionId === discussionB.id).length, { timeout: ACK_TIMEOUT_MS })
                .toBeGreaterThan(discussionBSnapshotCount);
            expect(observations.get(observerSocket)!
                .filter(value => value.discussionId === discussionA.id && value.observedAt > discussionADeletedAt)).toEqual([]);
            expect(await declare(observerSocket, [session.id], [locationA, locationB])).toEqual({
                v: 1,
                ok: true,
                admittedSessionIds: [session.id],
                admittedLocations: [locationB],
            });
        } finally {
            clients.forEach(client => client.close());
            await app.close();
        }
    }, 30_000);

    it("does not emit a Discussion snapshot after deletion commits during projection", async () => {
        const owner = await db.account.create({ data: {
            publicKey: crypto.randomUUID(), name: "Discussion deletion owner", encryptionMode: "plain",
        } });
        const session = await db.session.create({ data: {
            accountId: owner.id,
            tag: crypto.randomUUID(),
            encryptionMode: "plain",
            metadata: JSON.stringify({ t: "plain", v: {} }),
        } });
        const discussion = await db.sessionDiscussion.create({ data: {
            sessionId: session.id,
            creationLocalId: crypto.randomUUID(),
            creationEqualityEvidenceV1: {},
            createdByAccountId: owner.id,
            titleContent: { t: "plain", v: { v: 1, title: "Delete during projection" } },
            lastMessageAt: new Date(),
        } });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP listener");
        const token = await auth.createToken(owner.id, undefined, { kind: "account", authority: "present_user" });
        const client = ioClient(`http://127.0.0.1:${address.port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: { token },
        });
        const observations: SessionHumanPresenceSnapshotV1[] = [];
        const staleSnapshot = deferred<SessionHumanPresenceSnapshotV1>();
        client.on(snapshotEvent, value => {
            const snapshot = SessionHumanPresenceSnapshotV1Schema.parse(value);
            observations.push(snapshot);
            if (snapshot.sessionId === session.id && snapshot.discussionId === discussion.id) {
                staleSnapshot.resolve(snapshot);
            }
        });
        await new Promise<void>((resolve, reject) => {
            client.once("connect", resolve);
            client.once("connect_error", reject);
            client.connect();
        });
        const barrier = installDiscussionPresenceReadBarrier({
            sessionId: session.id,
            discussionId: discussion.id,
        });
        try {
            const location = { sessionId: session.id, discussionId: discussion.id };
            expect(await client.timeout(ACK_TIMEOUT_MS).emitWithAck(visibleEvent, {
                v: 1,
                sessionIds: [],
                locations: [location],
            })).toEqual({
                v: 1,
                ok: true,
                admittedSessionIds: [],
                admittedLocations: [location],
            });
            await barrier.firstRead;

            await db.sessionDiscussion.delete({ where: { id: discussion.id } });
            notifySessionHumanPresenceAccessChanged({ sessionId: session.id });
            barrier.releaseFirst();

            const outcome = await Promise.race([
                barrier.nextProjectionRead.then(() => ({ kind: "current" as const })),
                staleSnapshot.promise.then(snapshot => ({ kind: "stale_snapshot" as const, snapshot })),
            ]);
            expect(outcome).toEqual({ kind: "current" });
            expect(observations.filter(snapshot => snapshot.sessionId === session.id
                && snapshot.discussionId === discussion.id)).toEqual([]);
        } finally {
            barrier.restore();
            client.close();
            await app.close();
        }
    }, 30_000);

    it("names authorized guests, checks input separately, expires typing and evicts after committed revocation", async () => {
        const [owner, editor, viewer, guest] = await Promise.all(["Owner", "Editor", "Viewer", "Named guest"].map(name =>
            db.account.create({ data: { publicKey: crypto.randomUUID(), name, encryptionMode: "plain" } })));
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: JSON.stringify({ t: "plain", v: {} }),
        } });
        const otherSession = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: JSON.stringify({ t: "plain", v: {} }),
        } });
        const discussion = await db.sessionDiscussion.create({ data: {
            sessionId: session.id,
            creationLocalId: crypto.randomUUID(),
            creationEqualityEvidenceV1: {},
            createdByAccountId: owner.id,
            titleContent: { t: "plain", v: { v: 1, title: "Presence" } },
            lastMessageAt: new Date(),
        } });
        const putDirect = (accountId: string, accessLevel: "view" | "edit") => inTx(tx => putSessionAccessGrantInTx(tx, {
            actorAccountId: owner.id,
            sessionId: session.id,
            subject: { kind: "account", accountId },
            grant: { accessLevel, canApprovePermissions: false },
            authentication: ownerAuthentication(),
        }));
        for (const account of [editor, viewer]) {
            await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: account.id, status: "friend" } });
        }
        expect(await putDirect(editor.id, "edit")).toMatchObject({ ok: true, changed: true });
        expect(await putDirect(viewer.id, "view")).toMatchObject({ ok: true, changed: true });
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: guest.id, role: "guest" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Guests", nameKey: "guests" } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id } });
        await db.sessionGroupGrant.create({ data: { sessionId: session.id, teamGroupId: group.id, accessLevel: "edit", effectiveAt: new Date() } });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP listener");
        const clients: Socket[] = [];
        const observations = new Map<Socket, SessionHumanPresenceSnapshotV1[]>();
        const connect = async (accountId: string, scope?: "session-scoped") => {
            const token = await auth.createToken(accountId, undefined, { kind: "account", authority: "present_user" });
            const client = ioClient(`http://127.0.0.1:${address.port}`, {
                path: "/v1/updates", transports: ["websocket"], reconnection: false, autoConnect: false,
                auth: { token, ...(scope ? { clientType: scope, sessionId: session.id } : {}) },
            });
            clients.push(client);
            observations.set(client, []);
            client.on(snapshotEvent, value => observations.get(client)!.push(SessionHumanPresenceSnapshotV1Schema.parse(value)));
            await new Promise<void>((resolve, reject) => {
                client.once("connect", resolve);
                client.once("connect_error", reject);
                client.connect();
            });
            return client;
        };
        const declare = (
            client: Socket,
            sessionIds = [session.id],
            locations: readonly Readonly<{ sessionId: string; discussionId: string }>[] = [],
        ) => client.timeout(ACK_TIMEOUT_MS).emitWithAck(visibleEvent, {
            v: 1,
            sessionIds,
            ...(locations.length > 0 ? { locations } : {}),
        });
        try {
            const ownerSocket = await connect(owner.id);
            const editorSocket = await connect(editor.id);
            const viewerSocket = await connect(viewer.id);
            const guestSocket = await connect(guest.id);
            const secondGuestSocket = await connect(guest.id);
            const publisherSocket = await connect(owner.id, "session-scoped");
            const beforeReadStates = await db.accountSessionReadState.count();
            const beforeFollows = await db.accountSessionFollow.count();
            const beforeChanges = await db.accountChange.count();
            const last = () => observations.get(ownerSocket)!
                .filter(value => value.sessionId === session.id && value.discussionId === undefined).at(-1);
            for (const client of [ownerSocket, editorSocket, viewerSocket, guestSocket, secondGuestSocket]) {
                expect(await declare(client, [session.id], [
                    { sessionId: session.id, discussionId: discussion.id },
                    // The discussion id is real, but the qualified pair is not.
                    { sessionId: otherSession.id, discussionId: discussion.id },
                ])).toEqual({
                    v: 1,
                    ok: true,
                    admittedSessionIds: [session.id],
                    admittedLocations: [{ sessionId: session.id, discussionId: discussion.id }],
                });
            }
            await expect.poll(() => last()?.viewers.length).toBe(4);
            const lastDiscussion = () => observations.get(ownerSocket)!
                .filter(value => value.discussionId === discussion.id).at(-1);
            await expect.poll(() => lastDiscussion()?.viewers.length).toBe(4);
            expect(last()?.viewers.find(value => value.account.accountId === guest.id)?.account.firstName).toBe("Named guest");
            await expect(publisherSocket.timeout(200).emitWithAck(visibleEvent, { v: 1, sessionIds: [session.id] })).rejects.toThrow();
            expect(observations.get(publisherSocket)).toEqual([]);

            viewerSocket.emit("session-human-presence:typing-set", {
                v: 1, sessionId: session.id, discussionId: discussion.id, typing: true,
            });
            await declare(viewerSocket, [session.id], [{ sessionId: session.id, discussionId: discussion.id }]);
            editorSocket.emit("session-human-presence:typing-set", {
                v: 1, sessionId: session.id, discussionId: discussion.id, typing: true,
            });
            await expect.poll(() => lastDiscussion()?.viewers.find(value => value.account.accountId === editor.id)?.typing).toBe(true);
            expect(lastDiscussion()?.viewers.find(value => value.account.accountId === viewer.id)?.typing).toBe(false);
            // Discussion typing is scoped to that exact location and must not
            // leak into the neighboring Session composer snapshot.
            expect(last()?.viewers.find(value => value.account.accountId === editor.id)?.typing).toBe(false);
            await expect.poll(() => lastDiscussion()?.viewers.find(value => value.account.accountId === editor.id)?.typing, { timeout: 8_000 }).toBe(false);

            editorSocket.emit("session-human-presence:typing-set", {
                v: 1, sessionId: session.id, discussionId: discussion.id, typing: true,
            });
            await expect.poll(() => lastDiscussion()?.viewers.find(value => value.account.accountId === editor.id)?.typing).toBe(true);
            // Presence itself writes no read state, Follow or AccountChange; the
            // grant transitions below legitimately do, so the invariant is checked
            // around each presence-only phase.
            expect(await db.accountSessionReadState.count()).toBe(beforeReadStates);
            expect(await db.accountSessionFollow.count()).toBe(beforeFollows);
            expect(await db.accountChange.count()).toBe(beforeChanges);
            expect(await putDirect(editor.id, "view")).toMatchObject({ ok: true, changed: true });
            await expect.poll(() => lastDiscussion()?.viewers.find(value => value.account.accountId === editor.id)?.typing).toBe(false);
            expect(last()?.viewers.some(value => value.account.accountId === editor.id)).toBe(true);
            expect(await inTx(tx => deleteSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id,
                sessionId: session.id,
                subject: { kind: "account", accountId: editor.id },
                authentication: ownerAuthentication(),
            }))).toMatchObject({ ok: true, changed: true });
            await expect.poll(() => last()?.viewers.some(value => value.account.accountId === editor.id)).toBe(false);
            await expect.poll(() => lastDiscussion()?.viewers.some(value => value.account.accountId === editor.id)).toBe(false);
            const afterRevocationReadStates = await db.accountSessionReadState.count();
            const afterRevocationFollows = await db.accountSessionFollow.count();
            const afterRevocationChanges = await db.accountChange.count();
            expect(await declare(editorSocket, [session.id], [{ sessionId: session.id, discussionId: discussion.id }]))
                .toEqual({ v: 1, ok: true, admittedSessionIds: [], admittedLocations: [] });
            expect(await declare(guestSocket, [])).toEqual({ v: 1, ok: true, admittedSessionIds: [] });
            secondGuestSocket.close();
            await expect.poll(() => last()?.viewers.some(value => value.account.accountId === guest.id)).toBe(false);
            expect(await db.accountSessionReadState.count()).toBe(afterRevocationReadStates);
            expect(await db.accountSessionFollow.count()).toBe(afterRevocationFollows);
            expect(await db.accountChange.count()).toBe(afterRevocationChanges);
        } finally {
            clients.forEach(client => client.close());
            await app.close();
        }
    }, 30_000);
});
