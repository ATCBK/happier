import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { observeLazyPrismaQuery } from "@/app/changes/accountPublicationContention.testkit";
import { createHomeConnectionDescriptorContinuityStoreForServer } from "@/app/features/homeConnectionDescriptorContinuity";
import { setHomeRoleInTx } from "@/app/home/governance/homeGovernanceService";
import { setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import { setHomeIrohMode } from "@/app/home/reachability/homeReachability";
import { readHomeIrohEndpointLifecycleState, registerHomeIrohComposition, resetHomeIrohEndpointStateForTests } from "@/app/iroh/homeIrohEndpoint";
import { initEncrypt } from "@/modules/encrypt";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

import { setHomeSettings } from "./homeSettings";

/** Interpose only at the real Prisma boundary; every domain decision and query remains real. */
function afterFirstSettingsQuery(method: "findUnique" | "create" | "updateMany", afterQuery: () => Promise<void>) {
    const original = db.$transaction;
    db.$transaction = new Proxy(original, {
        apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                let observed = false;
                const settings = new Proxy(tx.homeSettings, {
                    get(delegate, property, delegateReceiver) {
                        const member: unknown = Reflect.get(delegate, property, delegateReceiver);
                        if (property !== method || typeof member !== "function") return member;
                        return (...queryArgs: unknown[]) => observeLazyPrismaQuery(Reflect.apply(member, delegate, queryArgs),
                            () => ({ started() {}, settled() {} }), undefined, async consume => {
                                const value = await consume();
                                if (!observed) { observed = true; await afterQuery(); }
                                return value;
                            });
                    },
                });
                return await callback(new Proxy(tx, {
                    get(owner, property, proxyReceiver) {
                        return property === "homeSettings" ? settings : Reflect.get(owner, property, proxyReceiver);
                    },
                }));
            }, ...args.slice(1)]);
        },
    });
    return () => { db.$transaction = original; };
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Home settings Account publication", () => {
    let homeDir: string;
    let reachabilityEnv: NodeJS.ProcessEnv;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        process.env.HANDY_MASTER_SECRET ??= "home-settings-disposable-contract";
        await initEncrypt();
        homeDir = await mkdtemp(join(tmpdir(), "home-settings-publication-"));
        reachabilityEnv = { HAPPIER_DB_PROVIDER: "postgres", HAPPIER_HOME_DIR: homeDir,
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test", HAPPIER_CANONICAL_SERVER_URL: "https://home.example.test",
            HAPPIER_SERVER_IDENTITY_ID: `srv_${"a".repeat(32)}` };
    });
    afterAll(async () => { await db.$disconnect(); await rm(homeDir, { recursive: true, force: true }); });
    afterEach(async () => {
        await resetHomeIrohEndpointStateForTests();
        await db.homeAdministrationEvent.deleteMany({});
        await db.homeSettings.deleteMany({});
        await db.account.deleteMany({});
    });

    function composeIroh() {
        const continuityStore = createHomeConnectionDescriptorContinuityStoreForServer(reachabilityEnv);
        if (!continuityStore) throw new Error("Postgres descriptor continuity store missing");
        registerHomeIrohComposition({ env: reachabilityEnv, apiPort: 43123, continuityStore, native: null });
    }

    async function writeSettings(writer: "settings" | "iroh", actorAccountId: string) {
        if (writer === "iroh") return await setHomeIrohMode({ actorAccountId, mode: "disabled", env: reachabilityEnv });
        return await setHomeSettings({ actorAccountId,
            write: { expectedRevision: 0, values: { HAPPIER_HOME_DISPLAY_NAME: "Hot cursor Home" } } });
    }

    it.each(["settings", "iroh"] as const)("commits a %s write while another writer advances the owner Account cursor", async writer => {
        const owner = await db.account.create({ data: { homeRole: "owner", encryptionMode: "plain" } });
        if (writer === "iroh") composeIroh();
        let running = true;
        let advances = 0;
        let nextAdvance: (() => void) | undefined;
        const restore = afterFirstSettingsQuery("findUnique", async () => {
            // Every settings attempt must cross a committed cursor advance after its first read.
            await new Promise<void>(resolve => { nextAdvance = resolve; });
        });
        const hotCursor = (async () => {
            while (running) {
                await inTx(async tx => {
                    await markAccountChanged(tx, { accountId: owner.id, kind: "account", entityId: "self" });
                });
                advances += 1;
                nextAdvance?.();
                nextAdvance = undefined;
            }
        })();
        try {
            const result = await writeSettings(writer, owner.id);
            expect(result.status).toBe("applied");
            expect((await db.homeSettings.findUniqueOrThrow({ where: { id: "home" } })).values)
                .toEqual(writer === "iroh" ? { HAPPIER_HOME_IROH_MODE: "disabled" } : { HAPPIER_HOME_DISPLAY_NAME: "Hot cursor Home" });
            expect(await db.homeAdministrationEvent.count()).toBe(1);
            expect(advances).toBeGreaterThan(0);
        } finally {
            running = false;
            restore();
            await hotCursor;
        }
    });

    it.each(["settings", "iroh"] as const)("rolls back a %s write when its owner's authority is withdrawn before publication", async writer => {
        const actor = await db.account.create({ data: { homeRole: "owner", encryptionMode: "plain" } });
        const otherOwner = await db.account.create({ data: { homeRole: "owner", encryptionMode: "plain" } });
        if (writer === "iroh") composeIroh();
        let cursorAfterWithdrawal: readonly { id: string; seq: number }[] = [];
        const restore = afterFirstSettingsQuery("create", async () => {
            // The real settings row is already written. Commit the canonical competing authority
            // writer before settings reaches Account publication, so only the final recheck can deny it.
            if (writer === "settings") {
                const result = await inTx(tx => setHomeRoleInTx(tx, { actorAccountId: otherOwner.id,
                    targetAccountId: actor.id, homeRole: "admin", env: {}, emailDeliveryReady: false }));
                expect(result.status).toBe("ok");
            } else {
                const result = await inTx(tx => setAccountStatusInTx(tx, { actorAccountId: otherOwner.id,
                    targetAccountId: actor.id, status: "suspended", authority: "home_administration" }));
                expect(result.status).toBe("applied");
            }
            cursorAfterWithdrawal = await db.account.findMany({ select: { id: true, seq: true }, orderBy: { id: "asc" } });
        });
        try {
            expect(await writeSettings(writer, actor.id)).toEqual({ status: "forbidden" });
            expect(await db.homeSettings.findUnique({ where: { id: "home" } })).toBeNull();
            expect(await db.homeAdministrationEvent.count({ where: { targetKind: "setting" } })).toBe(0);
            expect(await db.account.findMany({ select: { id: true, seq: true }, orderBy: { id: "asc" } })).toEqual(cursorAfterWithdrawal);
            if (writer === "iroh") expect(readHomeIrohEndpointLifecycleState().status).toBe("not-composed");
        } finally { restore(); }
    });

    it.each(["settings", "iroh"] as const)("keeps a concurrent %s write under the same revision compare-and-set", async writer => {
        const owner = await db.account.create({ data: { homeRole: "owner", encryptionMode: "plain" } });
        if (writer === "iroh") composeIroh();
        const results = await Promise.all([
            writeSettings(writer, owner.id),
            setHomeSettings({ actorAccountId: owner.id, write: { expectedRevision: 0,
                values: { METRICS_PORT: 9191 } } }),
        ]);
        expect(results.map(result => result.status).sort()).toEqual(["applied", "revision_conflict"]);
        const record = await db.homeSettings.findUniqueOrThrow({ where: { id: "home" } });
        expect(record.revision).toBe(1);
        expect(record.values).toEqual(results[0].status === "applied"
            ? writer === "iroh" ? { HAPPIER_HOME_IROH_MODE: "disabled" } : { HAPPIER_HOME_DISPLAY_NAME: "Hot cursor Home" }
            : { METRICS_PORT: 9191 });
        expect(await db.homeAdministrationEvent.count()).toBe(1);
    });
});
