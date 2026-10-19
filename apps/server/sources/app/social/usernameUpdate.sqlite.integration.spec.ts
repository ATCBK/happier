import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Context } from "@/context";
import { eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { usernameUpdate, UsernameTakenError } from "./usernameUpdate";

describe("Username Account publication (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-username-publication-", initAuth: false });
    }, 120_000);

    afterAll(async () => { if (harness) await harness.close(); });

    it("commits the username and publishes its allocated numeric Account cursor", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const emit = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
        try {
            await usernameUpdate(Context.create(account.id), "newname");
            const updated = await db.account.findUniqueOrThrow({ where: { id: account.id } });
            const change = await db.accountChange.findFirstOrThrow({ where: { accountId: account.id, kind: "account", entityId: "self" } });
            expect(updated.username).toBe("newname");
            expect(change.cursor).toBe(updated.seq);
            expect(emit).toHaveBeenCalledWith(expect.objectContaining({
                userId: account.id,
                payload: expect.objectContaining({ seq: change.cursor, body: expect.objectContaining({ t: "update-account", username: "newname" }) }),
            }));
        } finally {
            emit.mockRestore();
        }
    });

    it("rejects a taken username without changing the Account or publishing", async () => {
        await db.account.create({ data: { encryptionMode: "plain", username: "taken" } });
        const account = await db.account.create({ data: { encryptionMode: "plain", username: "retained" } });
        await expect(usernameUpdate(Context.create(account.id), "taken")).rejects.toBeInstanceOf(UsernameTakenError);
        expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ username: "retained", seq: account.seq });
        expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
    });
});
