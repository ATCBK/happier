import { randomBytes, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { formatPluginWebhookEndpointIdV1 } from "@happier-dev/protocol/plugins/webhooks/endpointV1";

import { initEncrypt } from "@/modules/encrypt";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { acrossAccountCursorCommit, databaseLatch } from "@/testkit/postgresAccountCursorContention";
import { configurePluginWebhookEndpointCredentialV1 } from "./endpointActions";
import { createInitialPluginWebhookCredentialV1, finishPluginWebhookCredentialRotationV1, retireExpiredPluginWebhookCredentialsV1 } from "./credentialStore";
import { revokePluginWebhookEndpointV1 } from "./endpointStore";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("webhook endpoint writes with a hot Account cursor", () => {
    const accountIds: string[] = [];
    const routeIds: string[] = [];
    let connected = false;

    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error("Use the disposable PostgreSQL DB-contract harness");
        vi.stubEnv("HAPPIER_DB_TX_RETRY_BASE_DELAY_MS", "0");
        vi.stubEnv("HAPPIER_DB_TX_RETRY_MAX_DELAY_MS", "0");
        vi.stubEnv("HAPPIER_DB_TX_RETRY_JITTER_FACTOR", "0");
        vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
        vi.stubEnv("HANDY_MASTER_SECRET", "webhook-contention-test-master-secret");
        initDbPostgres();
        await db.$connect();
        connected = true;
        await initEncrypt();
    });

    afterAll(async () => {
        if (connected) {
            await db.pluginWebhookRoute.updateMany({ where: { id: { in: routeIds } },
                data: { currentCredentialId: null, previousCredentialId: null, accountEndpointId: null } });
            await db.pluginWebhookCredential.deleteMany({ where: { routeId: { in: routeIds } } });
            await db.pluginWebhookEndpoint.deleteMany({ where: { accountId: { in: accountIds } } });
            await db.pluginWebhookRoute.deleteMany({ where: { id: { in: routeIds } } });
            await db.account.deleteMany({ where: { id: { in: accountIds } } });
            await db.$disconnect();
        }
        vi.unstubAllEnvs();
    });

    async function fixture(previous = false) {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        accountIds.push(account.id);
        const route = await db.pluginWebhookRoute.create({ data: {
            opaqueRouteId: `wh_route_${randomUUID()}`, verifierKind: "github_hmac_sha256_v1", routingKind: "accountEndpoint",
        } });
        routeIds.push(route.id);
        const endpoint = await db.pluginWebhookEndpoint.create({ data: {
            id: formatPluginWebhookEndpointIdV1(randomBytes(16)), accountId: account.id, routeId: route.id,
            pluginId: "acme.github", webhookContributionId: "events", handlerActionId: "handle",
            sourceInstanceId: randomUUID(), routingKind: "accountEndpoint", setupKind: "accountEndpointV1",
        } });
        await db.pluginWebhookRoute.update({ where: { id: route.id }, data: { accountEndpointId: endpoint.id } });
        const previousVersion = `wh_cred_${randomUUID()}`;
        if (previous) {
            const current = await db.pluginWebhookCredential.create({ data: { routeId: route.id,
                credentialVersionId: `wh_cred_${randomUUID()}`, verifierKind: "github_hmac_sha256_v1",
                encryptedSecret: Buffer.from("opaque-current"), state: "current" } });
            const old = await db.pluginWebhookCredential.create({ data: { routeId: route.id,
                credentialVersionId: previousVersion, verifierKind: "github_hmac_sha256_v1",
                encryptedSecret: Buffer.from("opaque-previous"), state: "previous", acceptUntil: new Date(0) } });
            await db.pluginWebhookRoute.update({ where: { id: route.id }, data: {
                currentCredentialId: current.id, previousCredentialId: old.id,
            } });
        }
        return { accountId: account.id, routeId: route.id, endpointId: endpoint.id, previousVersion };
    }

    it.each(["initial", "configure", "expire", "finish", "revoke"] as const)("commits %s without weakening credential or revision custody", async operation => {
        const f = await fixture(operation === "expire" || operation === "finish");
        const idempotencyKey = randomUUID();
        if (operation === "finish") {
            expect(await finishPluginWebhookCredentialRotationV1({ routeId: f.routeId,
                expectedPreviousCredentialVersionId: `wh_cred_${randomUUID()}` })).toEqual({ kind: "credentialChanged" });
            expect(await db.pluginWebhookCredential.count({ where: { routeId: f.routeId } })).toBe(2);
        }
        if (operation === "expire") {
            expect(await retireExpiredPluginWebhookCredentialsV1({ now: new Date(-1) })).toEqual({ retired: 0 });
            expect(await db.pluginWebhookCredential.count({ where: { routeId: f.routeId } })).toBe(2);
        }
        const result = await acrossAccountCursorCommit(f.accountId, async () => {
            if (operation === "initial") return await createInitialPluginWebhookCredentialV1({ routeId: f.routeId,
                credentialVersionId: `wh_cred_${randomUUID()}`, secret: "server-generated-test-secret" });
            if (operation === "configure") return await configurePluginWebhookEndpointCredentialV1({ accountId: f.accountId,
                input: { webhookEndpointId: f.endpointId, expectedRevision: 1 } });
            if (operation === "expire") return await retireExpiredPluginWebhookCredentialsV1({ now: new Date() });
            if (operation === "finish") return await finishPluginWebhookCredentialRotationV1({ routeId: f.routeId,
                expectedPreviousCredentialVersionId: f.previousVersion });
            return await revokePluginWebhookEndpointV1({ accountId: f.accountId, webhookEndpointId: f.endpointId,
                expectedRevision: 1, idempotencyKey });
        });
        const route = await db.pluginWebhookRoute.findUniqueOrThrow({ where: { id: f.routeId },
            include: { currentCredential: true, previousCredential: true } });
        const endpoint = await db.pluginWebhookEndpoint.findUniqueOrThrow({ where: { id: f.endpointId } });
        if (operation === "initial" || operation === "configure") {
            expect(route.currentCredential?.state).toBe("current");
            expect(route.previousCredentialId).toBeNull();
            expect(await db.pluginWebhookCredential.count({ where: { routeId: f.routeId } })).toBe(1);
            if (operation === "configure") {
                expect(endpoint.revision).toBe(2);
                const repeat = await configurePluginWebhookEndpointCredentialV1({ accountId: f.accountId,
                    input: { webhookEndpointId: f.endpointId, expectedRevision: 1 } });
                expect(repeat).toMatchObject({ kind: "alreadyConfigured", revision: 2 });
                expect(repeat).not.toHaveProperty("oneTimeGeneratedSecret");
            }
        } else if (operation === "expire" || operation === "finish") {
            expect(result).toMatchObject(operation === "expire" ? { retired: 1 } : { kind: "retired" });
            expect(route.previousCredentialId).toBeNull();
            expect(route.currentCredential?.state).toBe("current");
            expect(await db.pluginWebhookCredential.count({ where: { routeId: f.routeId } })).toBe(1);
        } else {
            expect(result).toMatchObject({ kind: "revoked", revision: 2 });
            expect(endpoint.enabled).toBe(false);
            expect(route.enabled).toBe(false);
            expect(await revokePluginWebhookEndpointV1({ accountId: f.accountId, webhookEndpointId: f.endpointId,
                expectedRevision: 1, idempotencyKey })).toEqual(result);
            await expect(revokePluginWebhookEndpointV1({ accountId: f.accountId, webhookEndpointId: f.endpointId,
                expectedRevision: 1, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "idempotency_conflict" });
        }
    });

    it.each(["initial", "configure"] as const)("rolls back the losing %s credential when two writers observed an empty route", async operation => {
        const f = await fixture();
        const read = databaseLatch(), resume = databaseLatch();
        const delayedScope = new AsyncLocalStorage<boolean>();
        const original = db.$transaction;
        // Schedule the returned real database read before any credential FK
        // is acquired, avoiding an FK-upgrade deadlock as a false CAS proof.
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function" || !delayedScope.getStore()) return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [(tx: Tx) => callback(new Proxy(tx, { get(transaction, property, txReceiver) {
                if (property !== "pluginWebhookRoute") return Reflect.get(transaction, property, txReceiver);
                return new Proxy(transaction.pluginWebhookRoute, { get(model, method, modelReceiver) {
                    if (method !== "findUnique") return Reflect.get(model, method, modelReceiver);
                    return async (...queryArgs: Parameters<typeof model.findUnique>) => {
                        const result = await model.findUnique(...queryArgs);
                        read.release();
                        await resume.promise;
                        return result;
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        const write = async () => operation === "initial"
            ? await createInitialPluginWebhookCredentialV1({ routeId: f.routeId,
                credentialVersionId: `wh_cred_${randomUUID()}`, secret: "server-generated-race-secret" })
            : await configurePluginWebhookEndpointCredentialV1({ accountId: f.accountId,
                input: { webhookEndpointId: f.endpointId, expectedRevision: 1 } });
        const delayed = delayedScope.run(true, write);
        const delayedOutcome = Promise.allSettled([delayed]);
        try {
            await Promise.race([read.promise, delayed.then(() => { throw new Error("Writer bypassed empty-route read"); })]);
            await write();
        } finally {
            resume.release();
            await delayedOutcome;
            db.$transaction = original;
        }
        const [outcome] = await delayedOutcome;
        expect(outcome.status).toBe("rejected");
        const route = await db.pluginWebhookRoute.findUniqueOrThrow({ where: { id: f.routeId } });
        const credentials = await db.pluginWebhookCredential.findMany({ where: { routeId: f.routeId } });
        expect(credentials).toHaveLength(1);
        expect(route.currentCredentialId).toBe(credentials[0].id);
        expect(route.previousCredentialId).toBeNull();
        expect((await db.pluginWebhookEndpoint.findUniqueOrThrow({ where: { id: f.endpointId } })).revision)
            .toBe(operation === "configure" ? 2 : 1);
    });
});
