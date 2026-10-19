import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createOrRejoinLayout1SessionByTag } from "./createOrRejoinLayout1SessionByTag";
import { prepareLayout1SessionCreate } from "./prepareLayout1SessionCreate";

const authentication = createPresentUserSessionAccessAuthentication({ env: {} });

function prepared(accountId: string, managerSessionId: string, tag = randomUUID()) {
    const result = prepareLayout1SessionCreate({
        accountId, tag, metadata: JSON.stringify({ v: 1 }), ownerMetadata: { t: "plain", v: { v: 1 } },
        agentState: null, dataEncryptionKey: null, requestedEncryptionMode: "plain", requestedStorageState: undefined,
        organizationPlacement: undefined, accountEncryptionMode: "plain", storagePolicy: "optional", defaultAccountMode: "plain",
        originKind: "session", originSessionId: managerSessionId, manager: { sessionId: managerSessionId },
    });
    if (!result.ok) throw new Error("Invalid Session creation fixture");
    return result.prepared;
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("tag Session creation under PostgreSQL Account publication", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each(["create", "rejoin", "rejoin-global", "rejoin-empty-access", "rejoin-empty-triggers", "rejoin-empty-team-bindings", "disabled", "mode-change"] as const)("settles %s after a concurrent Account publisher commits", async operation => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const manager = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain", active: true,
        } });
        const input = {
            ...prepared(account.id, manager.id),
            ...(operation === "rejoin-global"
                ? { originKind: "none" as const, originSessionId: undefined, manager: undefined }
                : {}),
        };
        let existingId: string | undefined;
        if (operation.startsWith("rejoin")) {
            const existing = await createOrRejoinLayout1SessionByTag(input, authentication);
            if (existing.kind !== "created") throw new Error("Expected fresh Session fixture");
            existingId = existing.session.id;
            await db.session.update({ where: { id: existingId }, data: { active: false, archivedAt: new Date(123) } });
        }
        // Empty authoring fields introduce no cross-Account admission. Exercise
        // the real archived tag-rejoin lifecycle rather than an isolation stub.
        const request = {
            ...input,
            ...(operation === "rejoin-empty-access" ? { initialAccess: { grants: [] } } : {}),
            ...(operation === "rejoin-empty-triggers" ? { initialTriggers: [] } : {}),
            ...(operation === "rejoin-empty-team-bindings" ? { teamCredentialBindings: [] } : {}),
        };
        await db.accountChange.deleteMany({ where: { accountId: account.id } });
        const transaction = db.$transaction;
        let waits = 0;
        const failures: unknown[] = [];
        // Schedule only the real Prisma transport. Each attempted first Account
        // fence waits on a real durable publication, not an injected SQL error.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                let interleaved = false;
                return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                    if (property !== "$queryRawUnsafe") return Reflect.get(inner, property, innerReceiver);
                    return async (query: string, ...values: unknown[]) => {
                        if (interleaved || !query.includes('FROM "Account"') || !query.includes("FOR ")) {
                            return inner.$queryRawUnsafe(query, ...values);
                        }
                        interleaved = true;
                        const locked = deferred(), release = deferred();
                        const peer = Reflect.apply(transaction, db, [async (peerTx: Tx) => {
                            await markAccountChanged(peerTx, { accountId: account.id, kind: "account", entityId: "publication-peer" });
                            if (operation === "disabled") await peerTx.account.update({ where: { id: account.id }, data: { status: "disabled" } });
                            if (operation === "mode-change") await peerTx.account.update({ where: { id: account.id },
                                data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
                            locked.resolve();
                            await release.promise;
                        }]) as Promise<unknown>;
                        await locked.promise;
                        const waiting = Promise.resolve(inner.$queryRawUnsafe(query, ...values));
                        void waiting.catch(() => undefined);
                        try {
                            for (;;) {
                                const [{ blocked }] = await db.$queryRawUnsafe<Array<{ blocked: boolean }>>(
                                    `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                                        AND wait_event_type = 'Lock' AND query LIKE '%"Account"%') AS blocked`,
                                );
                                if (blocked) { waits++; break; }
                            }
                        } finally { release.resolve(); }
                        await peer;
                        try { return await waiting; }
                        catch (error) { failures.push(error); throw error; }
                    };
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            const result = await createOrRejoinLayout1SessionByTag(request, authentication);
            console.info("DF124_PUBLICATION", { operation, waits, failedStatements: failures.length, outcome: result.kind });
            expect(waits).toBeGreaterThan(0);
            if (operation === "disabled" || operation === "mode-change") {
                expect(result).toEqual({ kind: "rejected", rejection: { reason: operation === "disabled" ? "account-disabled" : "invalid-params" } });
                expect(await db.session.count({ where: { accountId: account.id, tag: input.tag } })).toBe(0);
                expect(await db.accountChange.count({ where: { accountId: account.id, kind: "session" } })).toBe(0);
            } else {
                expect(result.kind).toBe(operation === "create" ? "created" : "rejoined");
                if (result.kind === "rejected") throw new Error("Unexpected Session refusal");
                if (existingId) expect(result.session.id).toBe(existingId);
                expect(result.session).toMatchObject({ accountId: account.id, archivedAt: null, originSessionId: input.originSessionId ?? null });
                const relation = await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: result.session.id } });
                if (input.manager) {
                    expect(relation).toMatchObject({ sourceSessionId: result.session.id, destinationSessionId: manager.id, relation: "manager" });
                } else {
                    expect(relation).toBeNull();
                }
                expect(await db.session.count({ where: { accountId: account.id, tag: input.tag } })).toBe(1);
                expect(await db.accountChange.count({ where: { accountId: account.id, kind: "session", entityId: result.session.id } })).toBeGreaterThan(0);
            }
            expect(failures).toEqual([]);
        } finally {
            db.$transaction = transaction;
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("concurrent identical tags create one child and rejoin the winner without rewriting metadata", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const manager = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        const input = prepared(account.id, manager.id);
        try {
            const results = await Promise.all([1, 2].map(() => createOrRejoinLayout1SessionByTag(input, authentication)));
            expect(results.map(result => result.kind).sort()).toEqual(["created", "rejoined"]);
            const child = await db.session.findUniqueOrThrow({ where: { accountId_tag: { accountId: account.id, tag: input.tag } } });
            expect(results.every(result => result.kind !== "rejected" && result.session.id === child.id)).toBe(true);
            expect(await db.session.count({ where: { accountId: account.id, tag: input.tag } })).toBe(1);
            expect(await db.sessionFollowEdge.count({ where: { managerSourceSessionId: child.id } })).toBe(1);
            const rejoined = await createOrRejoinLayout1SessionByTag({ ...input, metadata: "{\"v\": 1}" }, authentication);
            expect(rejoined.kind).toBe("rejoined");
            expect((await db.session.findUniqueOrThrow({ where: { id: child.id } })).metadata).toBe(input.metadata);
        } finally {
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("rolls back child and publication when the requested manager belongs to an inaccessible Account", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const stranger = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const manager = await db.session.create({ data: { accountId: stranger.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        const input = { ...prepared(owner.id, manager.id), originSessionId: undefined };
        try {
            expect(await createOrRejoinLayout1SessionByTag(input, authentication))
                .toMatchObject({ kind: "rejected", rejection: { reason: "session-manager-invalid" } });
            expect(await db.session.count({ where: { accountId: owner.id } })).toBe(0);
            expect(await db.accountChange.count({ where: { accountId: { in: [owner.id, stranger.id] } } })).toBe(0);
        } finally {
            await db.session.deleteMany({ where: { accountId: { in: [owner.id, stranger.id] } } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, stranger.id] } } });
        }
    });
});
