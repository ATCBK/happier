import { afterEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, createDbTransactionMock, installDbModuleMock, installPrismaModuleMock, matchesDbMockWhere } from "./dbMocks";

describe("dbMocks", () => {
    afterEach(() => {
        vi.doUnmock("@/storage/db");
        vi.doUnmock("@/storage/prisma");
        vi.resetModules();
    });

    it("evaluates nested claim/custody predicates without accepting terminal or wrong-Machine rows", () => {
        const where = { AND: [{ OR: [{ workflowCustodyState: { not: null } }, { originKind: "automation" }] }],
            OR: [{ state: "queued" }, { state: "claimed", leaseExpiresAt: { lt: new Date(10) } }],
            assignments: { some: { machineId: "machine" } } };
        const row = { state: "queued", workflowCustodyState: "pending", assignments: [{ machineId: "machine" }] };
        expect(matchesDbMockWhere(row, where)).toBe(true);
        expect(matchesDbMockWhere({ ...row, state: "cancelled" }, where)).toBe(false);
        expect(matchesDbMockWhere({ ...row, assignments: [{ machineId: "other" }] }, where)).toBe(false);
        expect(matchesDbMockWhere({ ...row, state: "claimed", leaseExpiresAt: new Date(10) }, where)).toBe(false);
        expect(matchesDbMockWhere({ ...row, state: "claimed", leaseExpiresAt: new Date(9) }, where)).toBe(true);
    });

    it("creates nested Prisma-like delegates and resets their state", async () => {
        const mocks = createDbMocks({
            account: ["findUnique"],
            sessionShare: ["findFirst", "update"],
            nested: {
                machine: ["findFirst"],
            },
        } as const);

        mocks.db.account.findUnique.mockResolvedValue({ id: "account-1" });
        mocks.db.sessionShare.findFirst.mockResolvedValue({ id: "share-1" });

        await expect(mocks.db.account.findUnique({ where: { id: "account-1" } })).resolves.toEqual({ id: "account-1" });
        await expect(mocks.db.sessionShare.findFirst({ where: { id: "share-1" } })).resolves.toEqual({ id: "share-1" });

        mocks.reset();

        expect(mocks.db.account.findUnique).not.toHaveBeenCalled();
        expect(mocks.db.sessionShare.findFirst).not.toHaveBeenCalled();
        expect(mocks.db.account.findUnique.getMockImplementation()).toBeUndefined();
        expect(mocks.db.nested.machine.findFirst.getMockImplementation()).toBeUndefined();
    });

    it("installs a db module mock for subsequent dynamic imports", async () => {
        const mocks = createDbMocks({
            account: ["findUnique"],
        } as const);

        installDbModuleMock({ db: mocks.db, testMarker: "db" });

        const storage = await import("@/storage/db");

        expect(storage.db).toBe(mocks.db);
        expect((storage as Record<string, unknown>).testMarker).toBe("db");
    });

    it("installs a prisma module mock for subsequent dynamic imports", async () => {
        installPrismaModuleMock({ isPrismaErrorCode: () => false, testMarker: "prisma" });

        const prisma = await import("@/storage/prisma");

        expect(prisma.isPrismaErrorCode(new Error("boom"), "P2002")).toBe(false);
        expect((prisma as Record<string, unknown>).testMarker).toBe("prisma");
    });

    it("supplies fixture delegates to primary transactions and SQLite read snapshots", async () => {
        const txState = { sessionShare: { update: vi.fn().mockResolvedValue({ id: "share-1" }) } };
        const transactionMock = createDbTransactionMock(() => txState);
        const wrappedDb = transactionMock.wrapDb({
            sessionShare: { findFirst: vi.fn() },
        });

        const result = await wrappedDb.$transaction(async (tx) => await tx.sessionShare.update({ where: { id: "share-1" } }));

        expect(transactionMock.transaction).toHaveBeenCalledTimes(1);
        expect(txState.sessionShare.update).toHaveBeenCalledWith({ where: { id: "share-1" } });
        expect(result).toEqual({ id: "share-1" });

        await expect(transactionMock.readSnapshot(async (tx) =>
            await tx.sessionShare.update({ where: { id: "share-1" } }),
        )).resolves.toEqual(result);
        const readFailure = new Error("fixture read failed");
        await expect(transactionMock.readSnapshot(async () => { throw readFailure; })).rejects.toBe(readFailure);
    });
});
