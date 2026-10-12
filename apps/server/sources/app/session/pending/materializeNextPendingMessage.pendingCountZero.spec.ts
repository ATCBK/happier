import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbMocks, createDbTransactionMock, installDbModuleMock } from "../../api/testkit/dbMocks";

// Only the database boundary is replaced: transaction recovery, Account lock
// policy, Machine binding and exact publisher authority remain real.
const database = createDbMocks({
    session: ["findUnique", "findFirst", "updateMany"],
    machine: ["findUnique", "findFirst"],
    accessKey: ["findUnique"],
    sessionPendingMessage: ["findFirst", "count"],
} as const);
const transactions = createDbTransactionMock(() => database.db);
installDbModuleMock({ db: transactions.wrapDb(database.db) });
const { materializeNextPendingMessage } = await import("./materializeNextPendingMessage");

describe("materializeNextPendingMessage (pendingCount fast path)", () => {
    beforeEach(() => {
        vi.stubEnv("HAPPIER_DB_PROVIDER", "sqlite");
        database.reset();
        transactions.transaction.mockClear();
        database.db.session.findUnique.mockResolvedValue({
            id: "s1", accountId: "u1", active: true, archivedAt: null,
            lastActiveAt: new Date(0), updatedAt: new Date(0),
            encryptionMode: "e2ee", pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 8,
        });
        database.db.session.findFirst.mockResolvedValue({ id: "s1" });
        database.db.session.updateMany.mockResolvedValue({ count: 1 });
        // This supported uninstalled owner tuple exercises real binding
        // admission without needing an unrelated installation fixture.
        const machine = { accountId: "u1", installationId: null, revokedAt: null, replacedByMachineId: null };
        database.db.machine.findUnique.mockResolvedValue(machine);
        database.db.machine.findFirst.mockResolvedValue(machine);
        database.db.accessKey.findUnique.mockResolvedValue({ machine, session: { accountId: "u1" } });
        database.db.sessionPendingMessage.findFirst.mockResolvedValue(null);
        database.db.sessionPendingMessage.count.mockResolvedValue(0);
    });

    afterEach(() => { vi.unstubAllEnvs(); });

    it.each([0, 1])("requires the exact publisher fence even for an empty queue (fence %s)", async (fence) => {
        const result = await materializeNextPendingMessage({
            actorUserId: "u1", sessionId: "s1", deliveryState: "provider",
            deliveryTiming: "after_foreground_ready", foregroundState: "ready",
            publisherAuthority: { accountId: "u1", machineId: "m1", sessionId: "s1", committedFence: new Date(fence) },
        });

        expect(result).toEqual(fence === 0 ? {
            ok: true, didMaterialize: false, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 8,
            deliveryState: { mode: "provider", unresolved: false },
        } : { ok: false, error: "forbidden" });
    });

});
