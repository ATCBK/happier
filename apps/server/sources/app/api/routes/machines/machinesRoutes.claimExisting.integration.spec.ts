import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { machinesRoutes } from "./machinesRoutes";

describe("machinesRoutes (machine id conflict)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: "happier-machine-route-conflicts-", initAuth: false }); }, 120_000);
    afterEach(async () => { await db.machine.deleteMany(); await db.accountChange.deleteMany(); await db.account.deleteMany(); });
    afterAll(async () => { if (harness) await harness.close(); });

    it("returns 409 when create races (P2002) and the machine id belongs to a different account", async () => {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const foreign = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const winner = await db.machine.create({ data: { id: "m1", accountId: foreign.id, metadata: "foreign-private-metadata" } });
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const response = await app.inject({ method: "POST", url: "/v1/machines", headers: { "x-test-user-id": account.id },
                payload: { id: "m1", metadata: "proposal", dataEncryptionKey: null } });
            expect(response.statusCode).toBe(409);
            expect(response.json()).toMatchObject({ error: "machine_id_conflict" });
            expect(response.body).not.toContain(winner.metadata);
        });
        expect(await db.machine.findUniqueOrThrow({ where: { id: "m1" } })).toEqual(winner);
        expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
    });

    async function observeWinner(plainWinner: boolean) {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        await withAuthenticatedTestApp(machinesRoutes, async (app: FastifyInstance) => {
            let observed!: () => void;
            let release!: () => void;
            const missed = new Promise<void>(resolve => { observed = resolve; });
            const proceed = new Promise<void>(resolve => { release = resolve; });
            const original = db.machine.findFirst.bind(db.machine);
            let paused = false;
            // Keep the real DB result; change only the interleaving at the persistence boundary.
            const readWithBarrier = async (args: Parameters<typeof original>[0]) => {
                const result = await original(args);
                if (!paused && args?.where?.id === "m1" && args.where.accountId === account.id) {
                    paused = true;
                    observed();
                    await proceed;
                }
                return result;
            };
            // This DB boundary is awaited; the barrier retains the row, not Prisma's unused fluent relations.
            const barrier = vi.spyOn(db.machine, "findFirst").mockImplementation(readWithBarrier as unknown as typeof original);
            const pending = app.inject({ method: "POST", url: "/v1/machines", headers: { "x-test-user-id": account.id },
                payload: { id: "m1", metadata: "proposal", dataEncryptionKey: null } }).then(response => response);
            let winner;
            try {
                await Promise.race([missed, pending.then(response => { throw new Error(`Registration missed the DB barrier: ${response.statusCode} ${response.body}`); })]);
                // A contradictory historical plain winner must still never escape to an unsupported reader.
                winner = await db.machine.create({ data: { id: "m1", accountId: account.id,
                    metadata: plainWinner ? encodePlainMachineStoredContent({ host: "private-winner" }) : "winning-ciphertext",
                    dataEncryptionKey: plainWinner ? Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64") : null } });
            } finally {
                release();
                await pending;
                barrier.mockRestore();
                // Prisma synthesizes delegate properties; restore its captured real method explicitly.
                db.machine.findFirst = original;
            }
            const response = await pending;
            if (plainWinner) {
                expect(response.statusCode, response.body).toBe(426);
                expect(response.json()).toMatchObject({ error: "client-upgrade-required", requirement: { kind: "account-stored-content" } });
                expect(response.json()).not.toHaveProperty("machine");
            } else {
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json().machine).toMatchObject({ id: "m1", metadata: winner!.metadata, dataEncryptionKey: null });
            }
            expect(await db.machine.findUniqueOrThrow({ where: { id: "m1" } })).toEqual(winner);
            expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
        });
    }

    it("returns the existing machine when create races (P2002) and the machine id belongs to the same account", async () => { await observeWinner(false); });
    it("does not serialize a marked race winner to a legacy caller", async () => { await observeWinner(true); });
});
