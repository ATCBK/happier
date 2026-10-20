import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { encodeAutomationSessionLifecycleConfiguration } from "@/app/automations/automationSessionLifecycleConfigurationCodec";
import { acquireSessionAccountCursorLocksInTx, prepareSessionAccountCursorLocks } from "./acquireSessionAccountCursorLocksInTx";
import { markSessionProjectionRecipientsChanged } from "./markSessionProjectionRecipientsChanged";
import { sourceKeyForSessionFollowSourceV1 } from "@/app/session/follow/sessionFollowSourceIdentity";
import { markAccountChangesForSessionAccounts } from "./markAccountChangesForSessionAccounts";
import { prepareLayout1SessionCreate } from "@/app/session/create/prepareLayout1SessionCreate";
import { createOrRejoinLayout1SessionByTag } from "@/app/session/create/createOrRejoinLayout1SessionByTag";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Prepared Session cursor audience", () => {
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

    it("creates initial foreign access through the complete publication admission cohort", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        try {
            await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: recipient.id, status: "friend" } });
            const prepared = prepareLayout1SessionCreate({
                accountId: owner.id, tag: randomUUID(), metadata: JSON.stringify({ v: 1 }),
                ownerMetadata: { t: "plain", v: { v: 1 } }, agentState: null, dataEncryptionKey: null,
                requestedEncryptionMode: undefined, requestedStorageState: undefined, organizationPlacement: undefined,
                accountEncryptionMode: "plain", storagePolicy: "optional", defaultAccountMode: "plain",
                initialAccess: { grants: [{ subject: { kind: "account", accountId: recipient.id },
                    accessLevel: "view", canApprovePermissions: false }] },
            });
            if (!prepared.ok) throw new Error(`Unexpected preparation refusal: ${prepared.rejection.reason}`);
            const outcome = await createOrRejoinLayout1SessionByTag(prepared.prepared, createPresentUserSessionAccessAuthentication());
            expect(outcome.kind).toBe("created");
            if (outcome.kind !== "created") throw new Error("Expected a new Session");
            expect(await db.sessionShare.findUnique({ where: { sessionId_sharedWithUserId: {
                sessionId: outcome.session.id, sharedWithUserId: recipient.id,
            } }, select: { accessLevel: true } })).toEqual({ accessLevel: "view" });
            const changes = await db.accountChange.findMany({ where: { kind: "session", entityId: outcome.session.id },
                orderBy: { accountId: "asc" }, select: { accountId: true, cursor: true } });
            expect(changes.map(change => change.accountId)).toEqual([owner.id, recipient.id].sort());
            expect(changes.every(change => Number.isSafeInteger(change.cursor) && change.cursor > 0)).toBe(true);
        } finally {
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } });
        }
    });

    it("replays an audience that grows after domain admission before terminal publication", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        let attempts = 0;
        try {
            await inTx(async tx => {
                attempts += 1;
                const recipients = await acquireSessionAccountCursorLocksInTx(tx, [session.id]);
                if (attempts === 1) {
                    await db.sessionShare.create({ data: {
                        sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: recipient.id,
                    } });
                }
                await tx.session.update({ where: { id: session.id }, data: { seq: { increment: 1 } } });
                await markAccountChangesForSessionAccounts({ tx, sessionId: session.id, accountIds: recipients });
            }, { isolationLevel: "ReadCommitted" });
            expect(attempts).toBe(2);
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { seq: true } }))
                .toEqual({ seq: 1 });
            expect(await db.accountChange.findMany({ where: { sessionId: session.id },
                orderBy: { accountId: "asc" }, select: { accountId: true, cursor: true } }))
                .toEqual([owner.id, recipient.id].sort().map(accountId => ({ accountId, cursor: 1 })));
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } });
        }
    });

    it.each(["Serializable", "ReadCommitted"] as const)("replays a changed follower audience and fences outgoing, incoming and Archive lifecycle Accounts at %s", async isolationLevel => {
        const accounts = await Promise.all(Array.from({ length: 6 }, () => db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        })));
        const followerOwner = await db.account.create({ data: {
            id: `000-follow-${randomUUID()}`, publicKey: randomUUID(), encryptionMode: "plain",
        } });
        accounts.push(followerOwner);
        const [sourceOwner, leadOwner, childOwner, automationOwner, scopeOwner, recipient] = accounts;
        try {
            const createSession = (accountId: string) => db.session.create({ data: {
                accountId, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
            } });
            const source = await createSession(sourceOwner.id);
            const lead = await createSession(leadOwner.id);
            const child = await createSession(childOwner.id);
            const follower = await createSession(followerOwner.id);
            const scope = await createSession(scopeOwner.id);
            await db.sessionFollowEdge.createMany({ data: [
                { sourceSessionId: source.id, destinationSessionId: lead.id, relation: 'manager', managerSourceSessionId: source.id },
                { sourceSessionId: source.id, destinationSessionId: lead.id, relation: 'follower' },
                { sourceSessionId: child.id, destinationSessionId: source.id, relation: 'manager', managerSourceSessionId: child.id },
                { sourceSessionId: source.id, destinationSessionId: follower.id, relation: 'follower' },
            ].map(edge => ({ ...edge, policyJson: JSON.stringify({ preset: 'important' }),
                sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: edge.sourceSessionId }) })) });
            const automation = await db.automation.create({ data: {
                accountId: automationOwner.id, name: "Archive audience", templateCiphertext: "{}", scopeSessionId: scope.id,
            } });
            await db.automationTrigger.create({ data: {
                automationId: automation.id, kind: "sessionLifecycle",
                ...encodeAutomationSessionLifecycleConfiguration({
                    kind: "sessionLifecycle", sourceSessionId: source.id,
                    events: ["sessionArchived"], policy: { kind: "everyMatch" },
                }),
            } });
            let preparations = 0;
            await inTx(async tx => {
                expect(preparations).toBe(2);
                expect(await tx.$queryRaw<Array<{ isolation: string }>>`
                    SELECT current_setting('transaction_isolation') AS isolation
                `).toEqual([{ isolation: isolationLevel === "Serializable" ? "serializable" : "read committed" }]);
                // Each independent contender must observe the actual row fence;
                // checking a union would hide a missing later audience member.
                for (const account of accounts) {
                    await expect(db.$queryRaw`
                        SELECT id FROM "Account" WHERE id = ${account.id} FOR UPDATE NOWAIT
                    `).rejects.toMatchObject({ code: "P2010", meta: { code: "55P03" } });
                    await expect(db.$queryRaw`
                        SELECT id FROM "Account" WHERE id = ${account.id} FOR NO KEY UPDATE NOWAIT
                    `).resolves.toEqual([{ id: account.id }]);
                }
                await tx.session.update({ where: { id: source.id }, data: { seq: { increment: 1 } } });
                await markSessionProjectionRecipientsChanged({ tx, sessionId: source.id });
                expect(await tx.accountChange.findMany({ where: { sessionId: follower.id },
                    orderBy: { accountId: 'asc' }, select: { accountId: true, hint: true } }))
                    .toEqual([]);
                expect(await tx.account.findUniqueOrThrow({ where: { id: leadOwner.id }, select: { seq: true } }))
                    .toEqual({ seq: 0 });
            }, {
                isolationLevel,
                prepare: async () => {
                    preparations += 1;
                    const fence = await prepareSessionAccountCursorLocks([source.id], [], { includeLifecyclePublications: true });
                    if (preparations === 1) {
                        // A real committed grant between discovery and mutation
                        // must refresh the whole sorted fence, never extend it.
                        await db.sessionShare.create({ data: {
                            sessionId: follower.id, sharedByUserId: followerOwner.id, sharedWithUserId: recipient.id,
                        } });
                    }
                    return fence;
                },
            });
            expect(await db.accountChange.findMany({ where: { sessionId: follower.id },
                orderBy: { accountId: 'asc' }, select: { accountId: true, hint: true } }))
                .toEqual([followerOwner.id, recipient.id].sort().map(accountId => ({ accountId, hint: null })));
            expect(await db.account.findUniqueOrThrow({ where: { id: leadOwner.id }, select: { seq: true } }))
                .toEqual({ seq: 1 });
        } finally {
            await db.session.deleteMany({ where: { accountId: { in: accounts.map(account => account.id) } } });
            await db.account.deleteMany({ where: { id: { in: accounts.map(account => account.id) } } });
        }
    });
});
