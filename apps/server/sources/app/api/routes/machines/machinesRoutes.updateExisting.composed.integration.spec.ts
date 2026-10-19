import { randomBytes, randomUUID } from "node:crypto";
import tweetnacl from "tweetnacl";
import { encodeHex } from "privacy-kit";
import { openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1";
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encryptWithDataKey, decryptWithDataKey } from "../../../../../../cli/src/api/encryption";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { machinesRoutes } from "./machinesRoutes";
import { registerAccountEncryptionMigrateRoutes } from "../account/registerAccountEncryptionMigrateRoutes";
import { attachAccountEncryptionMigrateProofSignatureV1, createAccountEncryptionMigrateProofSigningInputV1, type AccountEncryptionMigrateUnsignedRequest } from "@happier-dev/protocol/account/encryptionMigrate";
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from "@happier-dev/protocol/account/encryptionKeyFingerprintV1";
import { signAccountContentKeyBindingV1 } from "@happier-dev/protocol/crypto/accountContentKeyBindingV1";

describe("machinesRoutes canonical repeated registration (SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-machine-registration-", initAuth: false });
    }, 120_000);
    afterEach(async () => {
        await db.machine.deleteMany();
        await db.accountChange.deleteMany();
        await db.account.deleteMany();
    });
    afterAll(async () => { if (harness) await harness.close(); });

    it("returns the winning envelope and matching ciphertexts without replacing user edits with a distinct proposal", async () => {
        const recipient = tweetnacl.box.keyPair();
        const binding = createSignedAccountContentBinding(recipient.publicKey);
        const account = await db.account.create({ data: { ...binding, encryptionMode: "e2ee" } });
        const winningKey = randomBytes(32);
        const proposedKey = randomBytes(32);
        const seal = (key: Uint8Array) => sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: recipient.publicKey, randomBytes });
        const encode = (value: unknown, key: Uint8Array) => Buffer.from(encryptWithDataKey(value, key)).toString("base64");
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id,
            metadata: encode({ host: "host", displayName: "User name" }, winningKey), metadataVersion: 4,
            daemonState: encode({ status: "running" }, winningKey), daemonStateVersion: 8,
            dataEncryptionKey: seal(winningKey),
        } });
        await withAuthenticatedTestApp(machinesRoutes, async (app) => {
            const response = await app.inject({ method: "POST", url: "/v1/machines", headers: { "x-test-user-id": account.id }, payload: {
                id: machine.id, metadata: encode({ host: "bootstrap" }, proposedKey),
                daemonState: encode({ status: "starting" }, proposedKey), dataEncryptionKey: Buffer.from(seal(proposedKey)).toString("base64"),
                contentPublicKey: Buffer.from(binding.contentPublicKey).toString("base64"),
            } });
            expect(response.statusCode).toBe(200);
            const published = response.json().machine;
            expect(published.dataEncryptionKey).toBe(Buffer.from(machine.dataEncryptionKey!).toString("base64"));
            expect(openEncryptedDataKeyEnvelopeV1({
                envelope: Buffer.from(published.dataEncryptionKey, "base64"),
                recipientSecretKeyOrSeed: recipient.secretKey,
            })).toEqual(new Uint8Array(winningKey));
            expect(published.storageMode).toBe("e2ee");
            expect(published.metadataVersion).toBe(4);
            expect(published.daemonStateVersion).toBe(8);
            expect(decryptWithDataKey(Buffer.from(published.metadata, "base64"), winningKey)).toEqual({ host: "host", displayName: "User name" });
            expect(decryptWithDataKey(Buffer.from(published.daemonState, "base64"), winningKey)).toEqual({ status: "running" });
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).toEqual(machine);
        });
    });

    it("projects the persistent Machine envelope and custodian mode to authenticated SDK bootstrap", async () => {
        const binding = createSignedAccountContentBinding();
        const account = await db.account.create({ data: { ...binding, encryptionMode: "e2ee" } });
        const envelope = sealEncryptedDataKeyEnvelopeV1({ dataKey: randomBytes(32), recipientPublicKey: binding.contentPublicKey, randomBytes });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, metadata: "opaque", dataEncryptionKey: envelope,
        } });
        await withAuthenticatedTestApp(machinesRoutes, async (app) => {
            const result = await app.inject({ method: "GET", url: "/v1/machines", headers: {
                "x-test-user-id": account.id, "x-test-auth-token-kind": "api_token",
            } });
            expect(result.statusCode).toBe(200);
            expect(result.json()).toEqual([expect.objectContaining({ id: machine.id, dataEncryptionKey: Buffer.from(envelope).toString("base64"), access: expect.objectContaining({ resourceMode: "e2ee", accessState: "ready" }) })]);
            expect(result.json()[0]).not.toHaveProperty("metadata");
        });
    });

    it("adopts one complete winner when distinct registration proposals race", async () => {
        const recipient = tweetnacl.box.keyPair();
        const binding = createSignedAccountContentBinding(recipient.publicKey);
        const account = await db.account.create({ data: { ...binding, encryptionMode: "e2ee" } });
        const id = randomUUID();
        const proposals = ["first", "second"].map((label) => {
            const key = randomBytes(32);
            return {
                id,
                metadata: Buffer.from(encryptWithDataKey({ host: label }, key)).toString("base64"),
                daemonState: Buffer.from(encryptWithDataKey({ status: label }, key)).toString("base64"),
                dataEncryptionKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: recipient.publicKey, randomBytes })).toString("base64"),
                contentPublicKey: Buffer.from(recipient.publicKey).toString("base64"),
            };
        });
        await withAuthenticatedTestApp(machinesRoutes, async (app) => {
            const responses = await Promise.all(proposals.map((payload) => app.inject({ method: "POST", url: "/v1/machines", headers: { "x-test-user-id": account.id }, payload })));
            responses.forEach((response) => expect(response.statusCode).toBe(200));
            const stored = await db.machine.findUniqueOrThrow({ where: { id } });
            const winner = proposals.find((proposal) => proposal.dataEncryptionKey === Buffer.from(stored.dataEncryptionKey!).toString("base64"));
            expect(winner).toBeDefined();
            expect(stored).toMatchObject({ metadata: winner!.metadata, daemonState: winner!.daemonState, metadataVersion: 1, daemonStateVersion: 1 });
            responses.forEach((response) => expect(response.json().machine).toMatchObject({
                metadata: winner!.metadata, daemonState: winner!.daemonState, dataEncryptionKey: winner!.dataEncryptionKey,
                metadataVersion: 1, daemonStateVersion: 1,
            }));
        });
    });

    it("withholds contradictory owner content while projecting the persisted custodian mode", async () => {
        const binding = createSignedAccountContentBinding();
        const account = await db.account.create({ data: { ...binding, encryptionMode: "e2ee" } });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: "private-host" }),
            daemonState: encodePlainMachineStoredContent({ status: "running" }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64")),
        } });
        await withAuthenticatedTestApp(machinesRoutes, async (app) => {
            const result = await app.inject({ method: "GET", url: `/v1/machines/${machine.id}`, headers: { "x-test-user-id": account.id } });
            expect(result.statusCode).toBe(200);
            expect(result.json().machine).toMatchObject({ storageMode: "e2ee", metadata: null, daemonState: null,
                dataEncryptionKey: null, access: { resourceMode: "e2ee", accessState: "refused" } });
            const registration = await app.inject({ method: "POST", url: "/v1/machines", headers: { "x-test-user-id": account.id }, payload: {
                id: machine.id, metadata: machine.metadata, daemonState: machine.daemonState,
            } });
            expect(registration.statusCode).toBe(400);
            expect(registration.json()).toMatchObject({ reason: "machine_storage_mode_mismatch" });
        });
    });

    it("rejects a plaintext registration whose Account enabled E2EE after the registration mode read", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional", HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1" });
        const signing = tweetnacl.sign.keyPair();
        const content = tweetnacl.box.keyPair();
        const account = await db.account.create({ data: {
            publicKey: encodeHex(signing.publicKey), encryptionMode: "plain",
        } });
        const request: AccountEncryptionMigrateUnsignedRequest = {
            toMode: "e2ee", expectedAccountVersion: account.seq,
            expectedSigningKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(signing.publicKey),
            expectedContentKeyFingerprint: null, expectedSettingsVersion: 0, settingsContent: null,
            connectedServices: { action: "assert_empty" }, automations: { action: "assert_empty" },
            machines: { action: "assert_empty" }, todos: { action: "assert_empty" },
            artifacts: { action: "assert_empty" }, sessions: { action: "assert_empty" },
            reviewComments: { action: "assert_empty" }, sessionOrganization: { action: "assert_empty" }, pets: { action: "assert_empty" },
            keyProof: { v: 1, publicKey: Buffer.from(signing.publicKey).toString("base64"),
                contentPublicKey: Buffer.from(content.publicKey).toString("base64"),
                contentPublicKeySig: Buffer.from(signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: content.publicKey })).toString("base64"),
            },
        };
        const signingInput = createAccountEncryptionMigrateProofSigningInputV1({ request, accountId: account.id, sourceMode: "plain" });
        const migration = attachAccountEncryptionMigrateProofSignatureV1({ request,
            signature: Buffer.from(tweetnacl.sign.detached(signingInput, signing.secretKey)).toString("base64"),
        });
        await withAuthenticatedTestApp((app) => {
            machinesRoutes(app);
            registerAccountEncryptionMigrateRoutes(app);
        }, async (app) => {
            let observed!: () => void;
            let release!: () => void;
            const accountObserved = new Promise<void>(resolve => { observed = resolve; });
            const registrationMayContinue = new Promise<void>(resolve => { release = resolve; });
            const originalRead = db.account.findUnique.bind(db.account);
            let paused = false;
            // The real database result is unchanged; the DB boundary only controls the interleaving.
            const barrier = vi.spyOn(db.account, "findUnique").mockImplementation(async (args) => {
                const result = await originalRead(args);
                if (!paused && args.where.id === account.id && args.select?.encryptionMode && args.select.contentPublicKeySig) {
                    paused = true;
                    observed();
                    await registrationMayContinue;
                }
                return result;
            });
            const machineId = randomUUID();
            const headers = { "x-test-user-id": account.id, "x-happier-account-stored-content-protocol": "4" };
            const registration = app.inject({ method: "POST", url: "/v1/machines", headers, payload: {
                id: machineId, metadata: encodePlainMachineStoredContent({ host: "host" }),
                dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            } }).then(response => response);
            try {
                await Promise.race([accountObserved, registration.then(response => {
                    throw new Error(`Registration finished before its Account read barrier: ${response.statusCode} ${response.body}`);
                })]);
                const transition = await app.inject({ method: "POST", url: "/v1/account/encryption/migrate", headers, payload: migration });
                expect(transition.statusCode, transition.body).toBe(200);
                expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).encryptionMode).toBe("e2ee");
            } finally {
                release();
                barrier.mockRestore();
                await registration;
            }
            const response = await registration;
            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toMatchObject({ reason: "machine_storage_mode_mismatch" });
            expect(await db.machine.count({ where: { id: machineId } })).toBe(0);
        });
    });
});
