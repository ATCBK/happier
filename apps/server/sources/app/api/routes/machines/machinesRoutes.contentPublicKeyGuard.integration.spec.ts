import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";
import { randomBytes } from "node:crypto";
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent, signMachineInstallationProof, sealEncryptedDataKeyEnvelopeV1,
    buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { machinesRoutes } from "./machinesRoutes";

describe("machinesRoutes (contentPublicKey guard)", () => {
    let harness: LightSqliteHarness;
    let accountId: string;
    let binding: ReturnType<typeof createSignedAccountContentBinding>;
    let incumbent: Awaited<ReturnType<typeof db.machine.create>>;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: "happier-machine-route-content-", initAuth: false }); }, 120_000);
    beforeEach(async () => {
        harness.resetEnv();
        binding = createSignedAccountContentBinding();
        accountId = (await db.account.create({ data: { ...binding, encryptionMode: "e2ee" } })).id;
        incumbent = await db.machine.create({ data: { id: "m1", accountId, metadata: "meta-old", metadataVersion: 1,
            dataEncryptionKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: randomBytes(32), recipientPublicKey: binding.contentPublicKey, randomBytes }), active: true } });
    });
    afterEach(async () => { await db.machine.deleteMany(); await db.accountChange.deleteMany(); await db.account.deleteMany(); });
    afterAll(async () => { if (harness) await harness.close(); });

    async function invoke(payload: unknown, options: { legacy?: boolean; method?: "GET" | "POST"; path?: string } = {}) {
        let result!: { statusCode: number; body: string; json: () => unknown };
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const response = await app.inject({ method: options.method ?? "POST", url: options.path ?? "/v1/machines", headers: {
                "x-test-user-id": accountId,
                ...(options.legacy ? {} : buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION)),
            }, ...(payload === undefined ? {} : { payload }) });
            result = { statusCode: response.statusCode, body: response.body, json: () => response.json() };
        });
        return result;
    }
    const proposal = () => ({ id: "m1", metadata: "meta-new", dataEncryptionKey: "AAECAw==" });
    const plain = () => ({ id: "m1", metadata: encodePlainMachineStoredContent({ host: "machine-a" }),
        daemonState: encodePlainMachineStoredContent({ status: "running" }), dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    async function makePlain(existing = false) {
        await db.account.update({ where: { id: accountId }, data: { encryptionMode: "plain", publicKey: null, contentPublicKey: null, contentPublicKeySig: null } });
        if (existing) {
            const content = plain();
            return db.machine.update({ where: { id: "m1" }, data: { metadata: content.metadata, daemonState: content.daemonState,
                dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64") } });
        }
        await db.machine.deleteMany();
        return null;
    }
    function expectUpgrade(response: Awaited<ReturnType<typeof invoke>>) {
        expect(response.statusCode, response.body).toBe(426);
        expect(response.json()).toMatchObject({ error: "client-upgrade-required", requirement: { kind: "account-stored-content" } });
    }

    it("allows a DEK proposal without contentPublicKey while preserving the incumbent content basis", async () => {
        const response = await invoke(proposal());
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ machine: { id: "m1", metadata: incumbent.metadata,
            dataEncryptionKey: Buffer.from(incumbent.dataEncryptionKey!).toString("base64") } });
        expect(await db.machine.findUniqueOrThrow({ where: { id: "m1" } })).toEqual(incumbent);
    });

    it("rejects encrypted machine content for a keyless plaintext account before mutation", async () => {
        await makePlain();
        const response = await invoke(proposal());
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid-params", reason: "machine_storage_mode_mismatch" });
        expect(await db.machine.count()).toBe(0);
    });

    it("requires lossless whole-content recovery instead of registration writes to a historical encrypted Machine under a plain Account", async () => {
        await db.account.update({ where: { id: accountId }, data: { encryptionMode: "plain" } });
        const response = await invoke({ ...proposal(), daemonState: "state-new" });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid-params", reason: "machine_storage_mode_mismatch" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: "m1" } })).toEqual(incumbent);
        const snapshot = await invoke(undefined, { method: "GET", path: "/v1/machines/m1/content-key/transition" });
        expect(snapshot.statusCode, snapshot.body).toBe(200);
        expect(snapshot.json()).toMatchObject({ machine: { metadata: incumbent.metadata,
            dataEncryptionKey: Buffer.from(incumbent.dataEncryptionKey!).toString("base64"), storageMode: "e2ee" } });
        // transitionMachineContentKeyInTx.sqlite.composed.integration.spec.ts owns the actual predecessor decryption/CAS proof.
    });

    it("rejects an existing-row identity update when the transactional reread has changed to the plain marker", async () => {
        const installation = tweetnacl.sign.keyPair();
        const installationId = "installation-1";
        await withAuthenticatedTestApp(machinesRoutes, async (app: FastifyInstance) => {
            let observed!: () => void;
            let release!: () => void;
            const read = new Promise<void>(resolve => { observed = resolve; });
            const proceed = new Promise<void>(resolve => { release = resolve; });
            const original = db.machine.findFirst.bind(db.machine);
            let paused = false;
            const readWithBarrier = async (args: Parameters<typeof original>[0]) => {
                const result = await original(args);
                if (!paused && args?.where?.id === "m1" && args.where.accountId === accountId) {
                    paused = true; observed(); await proceed;
                }
                return result;
            };
            // This DB boundary is awaited; the barrier retains the row, not Prisma's unused fluent relations.
            const barrier = vi.spyOn(db.machine, "findFirst").mockImplementation(readWithBarrier as unknown as typeof original);
            const pending = app.inject({ method: "POST", url: "/v1/machines", headers: {
                "x-test-user-id": accountId,
                ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
            }, payload: { ...proposal(), installationId, installationPublicKey: Buffer.from(installation.publicKey).toString("base64url"),
                installationProof: signMachineInstallationProof({ payload: { version: 1, machineId: "m1", accountId, installationId }, privateKey: installation.secretKey }) } }).then(response => response);
            let current;
            try {
                await Promise.race([read, pending.then(response => { throw new Error(`Registration missed the DB barrier: ${response.statusCode} ${response.body}`); })]);
                current = await makePlain(true);
            } finally {
                release();
                await pending;
                barrier.mockRestore();
                // Prisma synthesizes delegate properties; restore its captured real method explicitly.
                db.machine.findFirst = original;
            }
            const response = await pending;
            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({ error: "invalid-params", reason: "machine_storage_mode_mismatch" });
            expect(await db.machine.findUniqueOrThrow({ where: { id: "m1" } })).toEqual(current);
        });
    });

    it("rejects the canonical plain Machine marker for an E2EE account before mutation", async () => {
        const response = await invoke(plain());
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid-params", reason: "machine_storage_mode_mismatch" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: "m1" } })).toEqual(incumbent);
    });

    it("registers canonical plain Machine content without an account content key", async () => {
        await makePlain();
        harness.resetEnv({ HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK: "1" });
        const content = plain();
        const response = await invoke(content);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ machine: content });
        expect(await db.machine.count()).toBe(1);
        expect(await db.machine.findUniqueOrThrow({ where: { id: "m1" } })).toMatchObject({ metadata: content.metadata, daemonState: content.daemonState });
    });

    it("requires current caller support before creating a canonical plain Machine", async () => {
        await makePlain();
        expectUpgrade(await invoke(plain(), { legacy: true }));
        expect(await db.machine.count()).toBe(0);
    });

    it("requires current caller support before returning an idempotent existing plain Machine", async () => {
        const current = await makePlain(true);
        expectUpgrade(await invoke(plain(), { legacy: true }));
        expect(await db.machine.findUniqueOrThrow({ where: { id: "m1" } })).toEqual(current);
    });

    it("requires current caller support before listing any marked Machine row", async () => {
        await makePlain(true);
        const response = await invoke(undefined, { legacy: true, method: "GET" });
        expectUpgrade(response);
        expect(response.json()).not.toHaveProperty("metadata");
    });

    it("keeps the full machine response for an ordinary authenticated session", async () => {
        const response = await invoke(undefined, { method: "GET" });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual([expect.objectContaining({ id: "m1", metadata: incumbent.metadata,
            metadataVersion: incumbent.metadataVersion, daemonState: null, daemonStateVersion: 0,
            dataEncryptionKey: Buffer.from(incumbent.dataEncryptionKey!).toString("base64"), installationId: null,
            installationPublicKey: null, contentPublicKeyFingerprint: null, replacedByMachineId: null, active: true })]);
    });

    it("requires current caller support before returning marked Machine detail", async () => {
        await makePlain(true);
        expectUpgrade(await invoke(undefined, { legacy: true, method: "GET", path: "/v1/machines/m1" }));
    });

    it("returns 400 when contentPublicKey does not match the account contentPublicKey", async () => {
        const response = await invoke({ ...proposal(), contentPublicKey: Buffer.from(tweetnacl.box.keyPair().publicKey).toString("base64") });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid-params", reason: "content_public_key_mismatch" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: "m1" } })).toEqual(incumbent);
    });

    it("returns 400 when strict mode is enabled and contentPublicKey is missing", async () => {
        harness.resetEnv({ HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK: "1" });
        const response = await invoke(proposal());
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid-params", reason: "content_public_key_required" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: "m1" } })).toEqual(incumbent);
    });

    it("does not rewrite a current account contentPublicKey when the client omits its signature (compat)", async () => {
        const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
        const response = await invoke({ ...proposal(), contentPublicKey: Buffer.from(binding.contentPublicKey).toString("base64") });
        expect(response.statusCode, response.body).toBe(200);
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId } })).toEqual(account);
        expect(await db.machine.findUniqueOrThrow({ where: { id: "m1" } })).toEqual(incumbent);
    });

    it.each(["content-key binding", "content-key signature"] as const)("rejects an E2EE account whose persisted %s is missing", async missing => {
        const account = await db.account.update({ where: { id: accountId }, data: missing === "content-key binding"
            ? { contentPublicKey: null, contentPublicKeySig: null } : { contentPublicKeySig: null } });
        const response = await invoke({ ...proposal(), contentPublicKey: Buffer.from(binding.contentPublicKey).toString("base64"),
            contentPublicKeySig: Buffer.from(binding.contentPublicKeySig).toString("base64") });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid-params", reason: "machine_storage_mode_mismatch" });
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId } })).toEqual(account);
        expect(await db.machine.findUniqueOrThrow({ where: { id: "m1" } })).toEqual(incumbent);
    });
});
