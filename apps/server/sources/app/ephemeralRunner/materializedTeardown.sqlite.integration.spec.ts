import { inTx } from "@/storage/inTx";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createSessionMachineAccessKeyInTx } from "@/app/accessKeys/sessionMachineAccessKeyMutations";
import { deleteOwnedSession } from "@/app/session/delete/deleteOwnedSession";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("materialized ephemeral Runner Session deletion (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-runner-teardown-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        if (harness) await harness.close();
    });

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.accessKey.deleteMany(),
            () => db.ephemeralRunnerActivation.deleteMany(),
            () => db.session.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function fixture() {
        const account = await db.account.create({ data: { publicKey: "runner-owner", encryptionMode: "plain" } });
        const session = await db.session.create({
            data: {
                id: "runner-session",
                accountId: account.id,
                tag: "runner-session-tag",
                metadata: "{}",
                encryptionMode: "plain",
            },
        });
        const machine = await db.machine.create({
            data: {
                id: "runner-machine",
                accountId: account.id,
                metadata: "{}",
                kind: "ephemeral_session_runner",
                installationId: "runner-installation",
                installationPublicKey: new Uint8Array(32).fill(7),
            },
        });
        const accessKey = await inTx(tx => createSessionMachineAccessKeyInTx(tx, {
            accountId: account.id,
            machineId: machine.id,
            sessionId: session.id,
            data: "runner-access-key",
        }));
        expect(accessKey.ok).toBe(true);
        const activation = await db.ephemeralRunnerActivation.create({
            data: {
                id: "00000000-0000-4000-8000-000000000013",
                creatorAccountId: account.id,
                creatorTokenEpoch: 0,
                draftId: "runner-draft",
                sessionId: session.id,
                machineId: machine.id,
                state: "materialized",
                workspacePolicy: "choose_on_endpoint",
                activationExpiresAt: null,
                homeServerIdentityId: "runner-home",
                activationSigningPublicKey: "a".repeat(43),
                authoringCommitment: "b".repeat(43),
                artifact: { product: "happier-runner", version: "0.3.0", target: "linux-x64", sha256: "c".repeat(64) },
                endpointFactsRecipient: { mode: "plain", creatorAccountId: account.id },
            },
        });
        return { account, activation, session, machine };
    }

    it("hard-deletes the retained activation and ephemeral Machine through the canonical Session delete owner", async () => {
        const seeded = await fixture();

        await expect(deleteOwnedSession({
            reason: "user_request",
            ownerAccountId: seeded.account.id,
            sessionId: seeded.session.id,
        })).resolves.toEqual({ ok: true });

        expect(await db.session.findUnique({ where: { id: seeded.session.id } })).toBeNull();
        expect(await db.ephemeralRunnerActivation.findUnique({ where: { id: seeded.activation.id } })).toBeNull();
        expect(await db.machine.findUnique({ where: { id: seeded.machine.id } })).toBeNull();
        expect(await db.accessKey.count({ where: { machineId: seeded.machine.id } })).toBe(0);
    });

    it("deletes an ordinary Session AccessKey without deleting its unrelated ordinary Machine", async () => {
        const account = await db.account.create({
            data: { publicKey: "ordinary-owner", encryptionMode: "plain" },
        });
        const session = await db.session.create({
            data: {
                id: "ordinary-session",
                accountId: account.id,
                tag: "ordinary-session-tag",
                metadata: "{}",
                encryptionMode: "plain",
            },
        });
        const machine = await db.machine.create({
            data: {
                id: "ordinary-machine",
                accountId: account.id,
                metadata: "{}",
                kind: "persistent",
            },
        });
        const accessKey = await inTx(tx => createSessionMachineAccessKeyInTx(tx, {
            accountId: account.id,
            machineId: machine.id,
            sessionId: session.id,
            data: "ordinary-access-key",
        }));
        expect(accessKey.ok).toBe(true);

        await expect(deleteOwnedSession({
            reason: "user_request",
            ownerAccountId: account.id,
            sessionId: session.id,
        })).resolves.toEqual({ ok: true });

        expect(await db.session.findUnique({ where: { id: session.id } })).toBeNull();
        expect(await db.accessKey.count({ where: { machineId: machine.id } })).toBe(0);
        expect(await db.machine.findUnique({ where: { id: machine.id } })).toMatchObject({
            id: machine.id,
            accountId: account.id,
            kind: "persistent",
        });
    });
});
