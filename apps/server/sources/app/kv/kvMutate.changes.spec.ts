import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { AccountJsonKvStoredContentModeMismatchError } from "./accountJsonKvStoredContent";
import { kvMutate } from "./kvMutate";

describe("kvMutate (AccountChange integration)", () => {
    let harness: LightSqliteHarness;
    const socketEmit = vi.fn<(event: string, payload: unknown) => void>();

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-kv-publication-", initAuth: false });
    }, 120_000);
    afterAll(async () => { eventRouter.clearIo(); await harness.close(); });
    beforeEach(() => {
        harness.resetEnv();
        socketEmit.mockClear();
        // Socket.IO is the system boundary; CAS, fences and publication are real.
        eventRouter.setIo({ to: () => ({ emit: socketEmit }) } as unknown as Parameters<typeof eventRouter.setIo>[0]);
    });
    afterEach(async () => {
        eventRouter.clearIo();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(), () => db.userKVStore.deleteMany(), () => db.account.deleteMany(),
        ]);
    });

    it.each([2, 51])("publishes the committed row versions, cursor and bounded hint for %i keys", async keyCount => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const mutations = Array.from({ length: keyCount }, (_, index) => ({ key: `k${index}`, value: "dmFs", version: -1 }));
        expect(await kvMutate({ uid: account.id }, mutations)).toMatchObject({ success: true });
        const accountRow = await db.account.findUniqueOrThrow({ where: { id: account.id } });
        const change = await db.accountChange.findFirstOrThrow({ where: { accountId: account.id, kind: "kv" } });
        expect(change.cursor).toBe(accountRow.seq);
        expect(change.hint).toEqual(keyCount <= 50 ? { keys: mutations.map(mutation => mutation.key) } : { full: true });
        const expectedChanges = mutations.map(mutation => ({ key: mutation.key, value: mutation.value, version: 0 }));
        expect(await db.userKVStore.count({ where: { accountId: account.id, version: 0 } })).toBe(keyCount);
        expect(socketEmit.mock.calls).toContainEqual(["update", expect.objectContaining({ seq: accountRow.seq,
            body: { t: "kv-batch-update", changes: expectedChanges } })]);
    });

    it("keeps a stale Todo revision and its Account cursor unchanged", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const marker = Buffer.from(JSON.stringify({ t: "plain", v: { undoneOrder: [], completedOrder: [] } }));
        await db.userKVStore.create({ data: { accountId: account.id, key: "todo.index", version: 1, value: marker } });
        expect(await kvMutate({ uid: account.id }, [{ key: "todo.index", value: marker.toString("base64"), version: 0 }],
            { supportsCurrentProtocol: true })).toEqual({ success: false, errors: [{ key: "todo.index", error: "version-mismatch",
                version: 1, value: marker.toString("base64") }] });
        expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(0);
        expect(socketEmit).not.toHaveBeenCalled();
    });

    it("refuses a Todo tombstone when Account encryption admission is inconsistent", async () => {
        const account = await db.account.create({ data: { encryptionMode: "e2ee" } });
        await expect(kvMutate({ uid: account.id }, [{ key: "todo.index", value: null, version: -1 }],
            { supportsCurrentProtocol: true })).rejects.toBeInstanceOf(AccountJsonKvStoredContentModeMismatchError);
        expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
        expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
        expect(socketEmit).not.toHaveBeenCalled();
    });
});
