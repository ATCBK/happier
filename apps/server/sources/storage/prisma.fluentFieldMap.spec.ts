import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

describe("Prisma fluent field-map backport", () => {
    it("defers linear field maps until relation access, with upstream action-closure lifetime", async () => {
        const bare = new PrismaClient({ datasources: { db: { url: "postgresql://probe:probe@127.0.0.1:1/probe" } } });
        const extended = bare.$extends({ query: { $allOperations: ({ args, query }) => query(args) } });
        // Observe the real dependency's model fields; no Prisma logic or query is mocked.
        const runtime = bare as unknown as {
            _runtimeDataModel: { models: { Account: { fields: Array<{ name: string; kind: string }> } } };
        };
        const fields = runtime._runtimeDataModel.models.Account.fields;
        const reduce = vi.spyOn(fields, "reduce");
        const map = vi.spyOn(fields, "map");
        try {
            for (const client of [bare, extended]) {
                reduce.mockClear();
                map.mockClear();
                for (let i = 0; i < 2_000; i++) void client.account.findUnique;
                expect(reduce).not.toHaveBeenCalled();
                expect(map).not.toHaveBeenCalled();

                const findUnique = client.account.findUnique;
                // Both clients expose this fluent contract with distinct generic overloads.
                const promise: PromiseLike<unknown> & { catch: unknown; managedMachines(): PromiseLike<unknown> } =
                    findUnique({ where: { id: "disconnected-probe" } });
                expect(typeof promise.then).toBe("function");
                expect(typeof promise.catch).toBe("function");
                Object.keys(promise);
                expect(map).not.toHaveBeenCalled();
                expect(typeof promise.managedMachines).toBe("function");
                expect(map).toHaveBeenCalledTimes(1);
                expect(typeof promise.managedMachines).toBe("function");
                expect(typeof findUnique({ where: { id: "same-closure" } }).managedMachines).toBe("function");
                expect(map).toHaveBeenCalledTimes(1);
                expect(typeof client.account.findUnique({ where: { id: "new-closure" } }).managedMachines).toBe("function");
                expect(reduce).not.toHaveBeenCalled();
                expect(map).toHaveBeenCalledTimes(2);
            }
        } finally {
            reduce.mockRestore();
            map.mockRestore();
            await bare.$disconnect();
        }
    });
});
