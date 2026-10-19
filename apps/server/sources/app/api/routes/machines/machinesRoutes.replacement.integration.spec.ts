import { inTx } from "@/storage/inTx";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent, signMachineInstallationProof,
    computeContentPublicKeyFingerprint, serializeAutomationStoredWorkflowDefinitionRecipeV2,
    buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { eventRouter } from "@/app/events/eventRouter";
import { activityCache } from "@/app/presence/sessionCache";
import { createSessionMachineAccessKeyInTx } from "@/app/accessKeys/sessionMachineAccessKeyMutations";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { machinesRoutes } from "./machinesRoutes";

describe("machinesRoutes machine replacement", () => {
    let harness: LightSqliteHarness;
    let accountId: string;
    let installation: ReturnType<typeof tweetnacl.sign.keyPair>;
    let fingerprint: string;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: "happier-machine-route-replacement-", initAuth: false }); }, 120_000);
    beforeEach(async () => {
        harness.resetEnv();
        const binding = createSignedAccountContentBinding();
        accountId = (await db.account.create({ data: { ...binding, encryptionMode: "e2ee" } })).id;
        installation = tweetnacl.sign.keyPair();
        fingerprint = computeContentPublicKeyFingerprint(binding.contentPublicKey);
        await db.machine.create({ data: { id: "m1", accountId, metadata: "old-meta", installationId: "install-1",
            installationPublicKey: new Uint8Array(installation.publicKey), contentPublicKeyFingerprint: fingerprint } });
    });
    afterEach(async () => {
        eventRouter.clearIo();
        activityCache.invalidateMachine("m1"); activityCache.invalidateMachine("m2");
        await db.accessKey.deleteMany(); await db.automationAssignment.deleteMany(); await db.automation.deleteMany();
        await db.session.deleteMany(); await db.machine.deleteMany(); await db.accountChange.deleteMany(); await db.account.deleteMany();
    });
    afterAll(async () => { if (harness) await harness.close(); });

    function proposal(replacesMachineId?: string, key = installation) {
        const payload = { version: 1 as const, installationId: "install-1", machineId: "m2", accountId,
            contentPublicKeyFingerprint: fingerprint, ...(replacesMachineId ? { replacesMachineId, replacementReason: "reauth" as const } : {}) };
        return { id: "m2", metadata: "new-meta", dataEncryptionKey: null, installationId: payload.installationId,
            installationPublicKey: Buffer.from(key.publicKey).toString("base64url"), contentPublicKeyFingerprint: fingerprint,
            installationProof: signMachineInstallationProof({ payload, privateKey: key.secretKey }),
            ...(replacesMachineId ? { replacesMachineId, replacementReason: "reauth" } : {}) };
    }
    async function invoke(payload: unknown, options: { method?: "POST" | "DELETE"; path?: string; legacy?: boolean } = {}) {
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
    async function readyReplacement(plain = false) {
        if (plain) {
            await db.account.update({ where: { id: accountId }, data: { encryptionMode: "plain" } });
            await db.machine.update({ where: { id: "m1" }, data: { metadata: encodePlainMachineStoredContent({ host: "old" }),
                dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64"), contentPublicKeyFingerprint: null } });
        }
        await db.machine.create({ data: { id: "m2", accountId, metadata: plain ? encodePlainMachineStoredContent({ host: "new" }) : "new-meta",
            dataEncryptionKey: plain ? Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64") : null,
            contentPublicKeyFingerprint: plain ? null : fingerprint, active: true, lastActiveAt: new Date() } });
    }

    it("creates machines with installation identity and replacement fields serialized", async () => {
        const response = await invoke(proposal());
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ machine: { id: "m2", installationId: "install-1",
            installationPublicKey: Buffer.from(installation.publicKey).toString("base64"), contentPublicKeyFingerprint: fingerprint, replacedByMachineId: null } });
        expect(await db.machine.findUniqueOrThrow({ where: { id: "m2" } })).toMatchObject({ installationId: "install-1",
            installationPublicKey: installation.publicKey, contentPublicKeyFingerprint: fingerprint });
    });

    it("rejects malformed content public key fingerprints before machine writes", async () => {
        const response = await invoke({ id: "m2", metadata: "meta", dataEncryptionKey: null,
            contentPublicKeyFingerprint: "content-public-key-sha256:not-valid" });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid-params", reason: "content_public_key_fingerprint_invalid" });
        expect(await db.machine.count({ where: { id: "m2" } })).toBe(0);
        expect(await db.accountChange.count({ where: { accountId } })).toBe(0);
    });

    it("applies explicit automatic replacement when creating a new machine", async () => {
        const session = await db.session.create({ data: { accountId, tag: "retained-session", metadata: "encrypted-session", encryptionMode: "e2ee" } });
        expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId, machineId: "m1", sessionId: session.id, data: "sealed-access-key" }))).toMatchObject({ ok: true });
        const recipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({ v: 2, templateVersion: 1, triggerEvidence: null,
            workflow: { t: "encrypted", c: "encrypted-workflow" } });
        if (recipe.kind !== "available") throw new Error("Canonical encrypted Automation fixture was rejected");
        const automation = await db.automation.create({ data: { accountId, name: "Retained workflow", enabled: true,
            templateCiphertext: recipe.serialized, templateVersion: 1 } });
        const assignment = await db.automationAssignment.create({ data: { automationId: automation.id, machineId: "m1", enabled: true } });
        const disconnected: string[] = [];
        // Socket.IO is the external transport boundary; actual replacement, cache and Automation owners run.
        eventRouter.setIo({ to: rooms => ({ emit: () => undefined,
            disconnectSockets: () => disconnected.push(...(Array.isArray(rooms) ? rooms : [rooms])) }) });
        activityCache.seedMachineValidity({ machineId: "m1", userId: accountId, active: true, lastActiveAt: new Date() });
        expect(await activityCache.isMachineValid("m1", accountId)).toBe(true);
        const response = await invoke(proposal("m1"));
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ machineReplacement: { status: "applied", replacesMachineId: "m1" } });
        expect(await db.machine.findUniqueOrThrow({ where: { id: "m1" } })).toMatchObject({ active: false, replacedByMachineId: "m2",
            replacementReason: "reauth", replacementSource: "automatic", replacementActorUserId: null });
        expect(await activityCache.isMachineValid("m1", accountId)).toBe(false);
        expect(disconnected).toEqual(expect.arrayContaining([`machine:m1:${accountId}`, `session:${session.id}:machine:m1:${accountId}`]));
        expect(await db.automation.findUniqueOrThrow({ where: { id: automation.id } })).toEqual(automation);
        expect(await db.automationAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).toEqual(assignment);
        expect(await db.accessKey.count({ where: { accountId, machineId: "m1", sessionId: session.id } })).toBe(1);
    });

    it("rejects existing machine registration when the installation id matches but the installation public key differs", async () => {
        const machine = await db.machine.create({ data: { id: "m2", accountId, metadata: "incumbent", installationId: "install-1",
            installationPublicKey: new Uint8Array(installation.publicKey), contentPublicKeyFingerprint: fingerprint } });
        const response = await invoke(proposal("m1", tweetnacl.sign.keyPair()));
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid-params", reason: "installation_public_key_mismatch" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: "m2" } })).toEqual(machine);
        expect((await db.machine.findUniqueOrThrow({ where: { id: "m1" } })).replacedByMachineId).toBeNull();
        expect(await db.accountChange.count({ where: { accountId } })).toBe(0);
    });

    it("exposes manual replacement and undo routes", async () => {
        await readyReplacement();
        const response = await invoke({ replacementMachineId: "m2", confirmActiveOldMachine: true }, { path: "/v1/machines/m1/replacement" });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ machine: { active: false, replacedByMachineId: "m2", replacementSource: "manual", replacementActorUserId: accountId } });
        const undo = await invoke(undefined, { method: "DELETE", path: "/v1/machines/m1/replacement" });
        expect(undo.statusCode, undo.body).toBe(200);
        expect(await db.machine.findUniqueOrThrow({ where: { id: "m1" } })).toMatchObject({ replacedByMachineId: null,
            replacedAt: null, replacementReason: null, replacementSource: null, replacementActorUserId: null });
    });

    it("does not apply manual replacement for a marked Machine when the caller is legacy", async () => {
        await readyReplacement(true);
        const before = await db.machine.findUniqueOrThrow({ where: { id: "m1" } });
        const response = await invoke({ replacementMachineId: "m2", confirmActiveOldMachine: true }, { path: "/v1/machines/m1/replacement", legacy: true });
        expect(response.statusCode, response.body).toBe(426);
        expect(response.json()).toMatchObject({ error: "client-upgrade-required" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: "m1" } })).toEqual(before);
        expect(await db.accountChange.count({ where: { accountId } })).toBe(0);
    });

    it("does not undo replacement for a marked Machine when the caller is legacy", async () => {
        await readyReplacement(true);
        const before = await db.machine.update({ where: { id: "m1" }, data: { replacedByMachineId: "m2", replacementSource: "manual" } });
        const response = await invoke(undefined, { method: "DELETE", path: "/v1/machines/m1/replacement", legacy: true });
        expect(response.statusCode, response.body).toBe(426);
        expect(response.json()).toMatchObject({ error: "client-upgrade-required" });
        expect(await db.machine.findUniqueOrThrow({ where: { id: "m1" } })).toEqual(before);
        expect(await db.accountChange.count({ where: { accountId } })).toBe(0);
    });
});
