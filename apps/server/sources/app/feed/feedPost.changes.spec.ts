import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

const boundary = createDbMocks({ account: ["update"], accountChange: ["upsert"],
    userFeedItem: ["create", "deleteMany"] } as const);
const transaction = vi.fn(async <T>(fn: (tx: typeof boundary.db) => Promise<T>) => fn(boundary.db));
installDbModuleMock(() => ({ db: { $transaction: transaction } }));

const { eventRouter } = await import("../events/eventRouter");
const { inTx } = await import("@/storage/inTx");
const { Context } = await import("@/context");
const { feedPost } = await import("./feedPost");
const emit = vi.fn<(event: string, payload: { seq: number; body: { t: string } }) => void>();

describe("Feed commit publication", () => {
    beforeEach(() => {
        vi.stubEnv("HAPPIER_DB_PROVIDER", "sqlite");
        boundary.reset();
        emit.mockClear();
        boundary.db.account.update.mockImplementation(async (args: { data: { feedSeq?: unknown } }) =>
            args.data.feedSeq ? { feedSeq: 7n } : { seq: 909 });
        boundary.db.accountChange.upsert.mockResolvedValue({});
        boundary.db.userFeedItem.deleteMany.mockResolvedValue({ count: 0 });
        boundary.db.userFeedItem.create.mockResolvedValue({ id: "f1", userId: "u1", repeatKey: "request",
            body: { kind: "friend_request", uid: "u2" }, counter: 7n, createdAt: new Date(1) });
        transaction.mockImplementation(async fn => {
            const result = await fn(boundary.db);
            expect(emit).not.toHaveBeenCalled();
            return result;
        });
        // Socket.IO is the transport boundary; routing, payloads and transaction publication stay real.
        eventRouter.setIo({ to: () => ({ emit }) } as unknown as Parameters<typeof eventRouter.setIo>[0]);
    });
    afterEach(() => { eventRouter.clearIo(); vi.unstubAllEnvs(); });

    it("sends the Feed wake with its allocated Account cursor only after commit", async () => {
        await inTx(tx => feedPost(tx, Context.create("u1"), { kind: "friend_request", uid: "u2" }, "request"));
        expect(emit.mock.calls.find(([, payload]) => payload.body.t === "new-feed-post")?.[1].seq).toBe(909);
    });

    it("sends no Feed wake when the database rejects the commit", async () => {
        transaction.mockImplementationOnce(async fn => { await fn(boundary.db); throw new Error("rollback"); });
        await expect(inTx(tx => feedPost(tx, Context.create("u1"), { kind: "friend_request", uid: "u2" }, "request")))
            .rejects.toThrow("rollback");
        expect(emit).not.toHaveBeenCalled();
    });
});
