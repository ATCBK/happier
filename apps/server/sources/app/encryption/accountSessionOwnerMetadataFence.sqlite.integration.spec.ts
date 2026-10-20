import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { inTx } from "@/storage/inTx";
import { db } from "@/storage/db";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { acquireAccountEncryptionTransitionFenceInTx, applyAccountEncryptionTransitionInTx } from "./accountEncryptionTransition";
import { acquireAccountEncryptionTransitionCoordinatorFenceInTx } from "./accountEncryptionTransitionCoordinator";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "./accountSessionOwnerMetadataFence";

function deferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("Account Session owner-metadata fence (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-session-owner-fence-",
            sqliteConnectionLimit: 2,
        });
    }, 120_000);

    afterEach(async () => {
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("holds the SQLite writer reservation and leaves Account.updatedAt unchanged", async () => {
        const initialUpdatedAt = new Date("2020-01-02T03:04:05.000Z");
        const account = await db.account.create({
            data: {
                settingsVersion: 7,
                updatedAt: initialUpdatedAt,
            },
            select: { id: true },
        });
        const firstAcquired = deferred();
        const releaseFirst = deferred();
        let secondAcquired = false;

        const first = inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "content");
            firstAcquired.resolve();
            await releaseFirst.promise;
        });
        await firstAcquired.promise;

        const second = inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "content");
            secondAcquired = true;
        });

        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(secondAcquired).toBe(false);

        releaseFirst.resolve();
        await first;
        await second;

        await expect(db.account.findUnique({
            where: { id: account.id },
            select: {
                settingsVersion: true,
                updatedAt: true,
            },
        })).resolves.toEqual({
            settingsVersion: 7,
            updatedAt: initialUpdatedAt,
        });
    }, 30_000);

    it("denies a fresh or prepared encryption activation after Account suspension, retaining cleanup access", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const before = await inTx((tx) => acquireAccountEncryptionTransitionCoordinatorFenceInTx(tx, account.id));
        expect(before.status).toBe("ready");
        await db.account.update({ where: { id: account.id }, data: { status: "suspended" } });

        await expect(inTx((tx) => acquireAccountEncryptionTransitionCoordinatorFenceInTx(tx, account.id)))
            .rejects.toMatchObject({ code: "account-disabled" });
        await expect(inTx((tx) => applyAccountEncryptionTransitionInTx(tx, {
            accountId: account.id, expectedVersion: account.seq, toMode: "plain", contentKey: { kind: "preserve" },
        }))).rejects.toThrow();
        // Erasure and retained-state cleanup use the key-currentness fence and
        // must still inspect an inactive Account without granting activation.
        await expect(inTx((tx) => acquireAccountEncryptionTransitionFenceInTx(tx, account.id, "exclusive")))
            .resolves.toMatchObject({ status: "ready" });
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).encryptionModeUpdatedAt)
            .toEqual(account.encryptionModeUpdatedAt);
    });

    it("reports a missing Account through the transition fence without leaking the raw lock failure", async () => {
        await expect(inTx((tx) => (
            acquireAccountEncryptionTransitionFenceInTx(tx, "missing-account", "exclusive")
        ))).resolves.toEqual({
            status: "account_not_found",
        });
    });
});
