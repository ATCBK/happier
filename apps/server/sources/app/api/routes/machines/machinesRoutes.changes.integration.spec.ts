import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/storage/db";
import { eventRouter } from "@/app/events/eventRouter";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { machinesRoutes } from "./machinesRoutes";

describe("machinesRoutes (AccountChange integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: "happier-machine-route-changes-", initAuth: false }); }, 120_000);
    afterEach(async () => { vi.restoreAllMocks(); await db.machine.deleteMany(); await db.accountChange.deleteMany(); await db.account.deleteMany(); });
    afterAll(async () => { if (harness) await harness.close(); });

    it("marks machine create once and emits new-machine + update-machine using the same cursor", async () => {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        // Observe transport publication without replacing cursor allocation or event builders.
        const emitted = vi.spyOn(eventRouter, "emitUpdate");
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const response = await app.inject({ method: "POST", url: "/v1/machines", headers: { "x-test-user-id": account.id },
                payload: { id: "m1", metadata: "meta", daemonState: "state", dataEncryptionKey: null } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().machine).toMatchObject({ id: "m1", metadata: "meta", metadataVersion: 1, daemonState: "state", daemonStateVersion: 1 });
        });
        const changes = await db.accountChange.findMany({ where: { accountId: account.id, kind: "machine", entityId: "m1" } });
        expect(changes).toHaveLength(1);
        const updates = emitted.mock.calls.map(([event]) => event.payload).filter(payload => payload.body.t === "new-machine" || payload.body.t === "update-machine");
        expect(updates.map(update => update.body.t)).toEqual(["new-machine", "update-machine"]);
        expect(updates.map(update => update.seq)).toEqual([changes[0].cursor, changes[0].cursor]);
        expect(new Set(updates.map(update => update.id)).size).toBe(2);
    });
});
