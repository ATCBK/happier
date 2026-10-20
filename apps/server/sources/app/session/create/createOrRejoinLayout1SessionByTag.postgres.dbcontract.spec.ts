import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createOrRejoinLayout1SessionByTag } from "./createOrRejoinLayout1SessionByTag";
import { prepareLayout1SessionCreate } from "./prepareLayout1SessionCreate";
import { deleteSessionOrganizationFolder, deleteSessionOrganizationTag } from "@/app/session/organization/organizationMutations";

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

    it.each(["create", "create-placement", "create-placement-private", "rejoin", "rejoin-global", "rejoin-empty-access", "rejoin-empty-triggers", "rejoin-empty-team-bindings", "disabled", "mode-change"] as const)("settles %s after a concurrent Account publisher commits", async operation => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const manager = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain", active: true,
        } });
        const input = {
            ...prepared(account.id, manager.id),
            ...(operation === "rejoin-global" || operation === "create-placement-private"
                ? { originKind: "none" as const, originSessionId: undefined, manager: undefined }
                : {}),
        };
        const folder = operation.startsWith("create-placement") ? await db.sessionOrganizationFolder.create({ data: {
            accountId: account.id, folderKey: "intake", folderHash: "intake",
        } }) : undefined;
        const tag = operation.startsWith("create-placement") ? await db.sessionOrganizationTag.create({ data: {
            accountId: account.id, tagKey: "incoming", tagHash: "incoming",
        } }) : undefined;
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
            ...(folder && tag ? { organizationPlacement: { folderId: folder.id, tagIds: [tag.id] } } : {}),
            ...(operation === "rejoin-empty-access" ? { initialAccess: { grants: [] } } : {}),
            ...(operation === "rejoin-empty-triggers" ? { initialTriggers: [] } : {}),
            ...(operation === "rejoin-empty-team-bindings" ? { teamCredentialBindings: [] } : {}),
        };
        await db.accountChange.deleteMany({ where: { accountId: account.id } });
        const transaction = db.$transaction;
        let publications = 0;
        const failures: unknown[] = [];
        // Schedule only the real Prisma transport. Each attempt establishes its
        // Account read before a real managed publication commits. KEY SHARE is
        // compatible with the publisher's NO KEY UPDATE; SSI must not certify
        // this unrelated cursor write as part of placement admission.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                let interleaved = false;
                return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                    if (property !== "$queryRawUnsafe") return Reflect.get(inner, property, innerReceiver);
                    return (query: string, ...values: unknown[]) => {
                        const native = inner.$queryRawUnsafe(query, ...values);
                        const admission = !interleaved && query.includes('FROM "Account"') && query.includes("FOR KEY SHARE");
                        if (!admission) return native;
                        interleaved = true;
                        let scheduled: Promise<unknown> | undefined;
                        // Preserve Prisma's lazy boundary: inTx must apply its
                        // statement budget before the native query starts.
                        const run = () => scheduled ??= (async () => {
                            try {
                                // Content-key replacement must win before our
                                // incompatible Account content admission.
                                const admitted = operation === "mode-change" ? undefined : await native;
                                await inTx(async peerTx => {
                                    await markAccountChanged(peerTx, { accountId: account.id, kind: "account", entityId: "publication-peer" });
                                    if (operation === "disabled") await peerTx.account.update({ where: { id: account.id }, data: { status: "disabled" } });
                                    if (operation === "mode-change") await peerTx.account.update({ where: { id: account.id },
                                        data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
                                });
                                publications++;
                                return operation === "mode-change" ? await native : admitted;
                            } catch (error) { failures.push(error); throw error; }
                        })();
                        return new Proxy(native, { get(target, method, queryReceiver) {
                            if (method !== "then" && method !== "catch" && method !== "finally") {
                                return Reflect.get(target, method, queryReceiver);
                            }
                            return (...args: unknown[]) => {
                                const promise = run();
                                return Reflect.apply(Reflect.get(promise, method, promise), promise, args);
                            };
                        } });
                    };
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            const result = await createOrRejoinLayout1SessionByTag(request, authentication);
            console.info("DF124_PUBLICATION", { operation, publications, failedStatements: failures.length, outcome: result.kind });
            expect(publications).toBeGreaterThan(0);
            if (operation === "disabled" || operation === "mode-change") {
                expect(result).toEqual({ kind: "rejected", rejection: { reason: operation === "disabled" ? "account-disabled" : "invalid-params" } });
                expect(await db.session.count({ where: { accountId: account.id, tag: input.tag } })).toBe(0);
                expect(await db.accountChange.count({ where: { accountId: account.id, kind: "session" } })).toBe(0);
            } else {
                expect(result.kind).toBe(operation.startsWith("create") ? "created" : "rejoined");
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
                if (folder && tag) {
                    expect(result.organizationPlacement).toEqual({ folderId: folder.id, tagIds: [tag.id] });
                    const rejoined = await createOrRejoinLayout1SessionByTag(request, authentication);
                    expect(rejoined).toMatchObject({ kind: "rejoined", session: { id: result.session.id } });
                    expect(await db.session.count({ where: { accountId: account.id, tag: input.tag } })).toBe(1);
                }
                expect(await db.accountChange.count({ where: { accountId: account.id, kind: "session", entityId: result.session.id } })).toBeGreaterThan(0);
            }
            expect(failures).toEqual([]);
        } finally {
            db.$transaction = transaction;
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each(["folder", "tag"] as const)("does not leave a birth assignment behind a concurrent %s deletion", async resource => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const manager = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        const folder = await db.sessionOrganizationFolder.create({ data: { accountId: account.id, folderKey: "intake", folderHash: "intake" } });
        const tag = await db.sessionOrganizationTag.create({ data: { accountId: account.id, tagKey: "incoming", tagHash: "incoming" } });
        const input = { ...prepared(account.id, manager.id), organizationPlacement: { folderId: folder.id, tagIds: [tag.id] } };
        const transaction = db.$transaction;
        let deletion: Promise<unknown> | undefined;
        let deletionSettled = false;
        // Hold the real insertion open while the real organization owner starts
        // deleting its resource. No domain result or SQL failure is injected.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                const delegate = Reflect.get(inner, property, innerReceiver);
                if (property !== (resource === "folder" ? "sessionFolderAssignment" : "sessionTagAssignment")) return delegate;
                return new Proxy(delegate, { get(model, method, modelReceiver) {
                    const operation = Reflect.get(model, method, modelReceiver);
                    if (method !== (resource === "folder" ? "create" : "createMany")) return operation;
                    return async (...values: unknown[]) => {
                        const result = await Reflect.apply(operation, model, values);
                        if (!deletion) {
                            deletion = resource === "folder"
                                ? deleteSessionOrganizationFolder({ accountId: account.id, request: { folderId: folder.id } })
                                : deleteSessionOrganizationTag({ accountId: account.id, request: { tagId: tag.id } });
                            void deletion.then(() => { deletionSettled = true; }, () => { deletionSettled = true; });
                            while (!deletionSettled) {
                                const [{ blocked }] = await db.$queryRawUnsafe<Array<{ blocked: boolean }>>(
                                    `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                                        AND wait_event_type = 'Lock'
                                        AND (query LIKE '%SessionOrganization%' OR query LIKE '%"Account"%')) AS blocked`);
                                if (blocked) break;
                            }
                        }
                        return result;
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            const created = await createOrRejoinLayout1SessionByTag(input, authentication);
            expect(deletion).toBeDefined();
            await deletion;
            const count = resource === "folder"
                ? await db.sessionFolderAssignment.count({ where: { accountId: account.id, folderId: folder.id } })
                : await db.sessionTagAssignment.count({ where: { accountId: account.id, tagId: tag.id } });
            expect(count).toBe(0);
            if (created.kind === "rejected") {
                expect(created.rejection.reason).toBe("invalid-organization-placement");
                expect(await db.session.count({ where: { accountId: account.id, tag: input.tag } })).toBe(0);
            } else {
                expect(await createOrRejoinLayout1SessionByTag(input, authentication))
                    .toMatchObject({ kind: "rejoined", session: { id: created.session.id } });
                expect(await db.session.count({ where: { accountId: account.id, tag: input.tag } })).toBe(1);
            }
        } finally {
            db.$transaction = transaction;
            await deletion;
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each([false, true])("concurrent identical tags create one child and rejoin the winner without rewriting metadata (placement=%s)", async placement => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const manager = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        const folder = placement ? await db.sessionOrganizationFolder.create({ data: {
            accountId: account.id, folderKey: "intake", folderHash: "intake",
        } }) : undefined;
        const tag = placement ? await db.sessionOrganizationTag.create({ data: {
            accountId: account.id, tagKey: "incoming", tagHash: "incoming",
        } }) : undefined;
        const input = { ...prepared(account.id, manager.id),
            ...(folder && tag ? { organizationPlacement: { folderId: folder.id, tagIds: [tag.id] } } : {}) };
        try {
            const results = await Promise.all([1, 2].map(() => createOrRejoinLayout1SessionByTag(input, authentication)));
            expect(results.map(result => result.kind).sort()).toEqual(["created", "rejoined"]);
            const child = await db.session.findUniqueOrThrow({ where: { accountId_tag: { accountId: account.id, tag: input.tag } } });
            expect(results.every(result => result.kind !== "rejected" && result.session.id === child.id)).toBe(true);
            expect(await db.session.count({ where: { accountId: account.id, tag: input.tag } })).toBe(1);
            expect(await db.sessionFollowEdge.count({ where: { managerSourceSessionId: child.id } })).toBe(1);
            if (folder && tag) {
                expect(await db.sessionFolderAssignment.findUnique({ where: {
                    accountId_sessionId: { accountId: account.id, sessionId: child.id },
                } })).toMatchObject({ folderId: folder.id });
                expect(await db.sessionTagAssignment.findMany({ where: { accountId: account.id, sessionId: child.id },
                    select: { tagId: true } })).toEqual([{ tagId: tag.id }]);
            }
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
