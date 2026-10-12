import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { HomeRoleV1 } from "@happier-dev/protocol";

import { readHomeConfigEnv, setHomeSettings } from "@/app/home/settings/homeSettings";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { acquireRetentionSweepLock } from "./retentionSweepLock";
import { startRetentionWorker } from "./startRetentionWorker";

/**
 * U7 deciding checks (plan §3.6): Home-stored retention rules reach the sweep at every run, and a
 * dry run from the console reports per-domain counts under the sweep lock without deleting.
 */
const ENABLED = "HAPPIER_SERVER_RETENTION__ENABLED";
const EVENTS_MODE = "HAPPIER_SERVER_RETENTION__HOME_ADMINISTRATION_EVENTS__MODE";
const EVENTS_DAYS = "HAPPIER_SERVER_RETENTION__HOME_ADMINISTRATION_EVENTS__DAYS";
const DAY_MS = 24 * 60 * 60 * 1000;

let sequence = 0;
let harness: LightSqliteHarness;
const touchedEnv = new Map<string, string | undefined>();

function setDeploymentEnv(key: string, value: string): void {
    if (!touchedEnv.has(key)) touchedEnv.set(key, process.env[key]);
    process.env[key] = value;
}

async function createAccount(homeRole: HomeRoleV1): Promise<string> {
    sequence += 1;
    const created = await db.account.create({
        data: { publicKey: `home-retention-${sequence}`, homeRole, status: "active" },
        select: { id: true },
    });
    return created.id;
}

async function seedEvents(ageDays: number, count: number): Promise<void> {
    const at = new Date(Date.now() - ageDays * DAY_MS);
    for (let index = 0; index < count; index += 1) {
        await db.homeAdministrationEvent.create({
            data: { at, actorKind: "deployment_command", action: "home.claim", summary: {} },
        });
    }
}

async function storeRules(owner: string, values: Record<string, unknown>): Promise<void> {
    const current = await db.homeSettings.findUnique({ where: { id: "home" }, select: { revision: true } });
    const result = await setHomeSettings({
        actorAccountId: owner,
        write: { expectedRevision: current?.revision ?? 0, values },
    });
    expect(result.status).toBe("applied");
}

/** Imported per test so the existing-owner cases run on their own before the dry-run owner exists. */
async function runRetentionDryRun(...args: Parameters<typeof import("./runRetentionDryRun").runRetentionDryRun>) {
    const module = await import("./runRetentionDryRun");
    return await module.runRetentionDryRun(...args);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("condition not met in time");
}

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-home-retention-",
        initAuth: false,
        initEncrypt: true,
        initFiles: false,
    });
});
afterAll(async () => await harness.close());
afterEach(async () => {
    for (const [key, value] of touchedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    touchedEnv.clear();
    await db.globalLock.deleteMany({});
    await db.homeAdministrationEvent.deleteMany({});
    await db.homeSettings.deleteMany({});
    await db.account.deleteMany({});
});

describe("Home retention", () => {
    it("dry-runs the Home's rules: per-domain would-delete counts, and nothing is deleted", async () => {
        const owner = await createAccount("owner");
        await storeRules(owner, { [ENABLED]: true, [EVENTS_MODE]: "delete_older_than", [EVENTS_DAYS]: 30 });
        await seedEvents(60, 3);
        const before = await db.homeAdministrationEvent.count();

        const outcome = await runRetentionDryRun({ env: await readHomeConfigEnv(process.env) });

        expect(outcome.status).toBe("ok");
        if (outcome.status !== "ok") return;
        expect(outcome.result.byDomain.homeAdministrationEvents).toEqual({
            wouldDelete: 3,
            candidatesExamined: 3,
            stopReason: "exhausted",
        });
        expect(outcome.result.byDomain.sessions).toMatchObject({ wouldDelete: 0 });
        expect(Date.parse(outcome.result.ranAt)).not.toBeNaN();
        expect(await db.homeAdministrationEvent.count()).toBe(before);
        // The dry run released the sweep lock.
        const lock = await acquireRetentionSweepLock({ ttlMs: 60_000 });
        expect(lock).not.toBeNull();
        await lock?.release();
    });

    it("refuses while a sweep holds the lock", async () => {
        const lock = await acquireRetentionSweepLock({ ttlMs: 60_000 });
        expect(lock).not.toBeNull();
        try {
            await expect(runRetentionDryRun({ env: process.env })).resolves.toEqual({ status: "in_progress" });
        } finally {
            await lock?.release();
        }
    });

    it("stops at the Home's sweep time budget, applied live", async () => {
        const owner = await createAccount("owner");
        await storeRules(owner, {
            [ENABLED]: true,
            [EVENTS_MODE]: "delete_older_than",
            [EVENTS_DAYS]: 30,
            HAPPIER_SERVER_RETENTION__SWEEP_TIME_BUDGET_MS: 5,
        });
        await seedEvents(60, 2);
        let clock = 0;
        const env = await readHomeConfigEnv(process.env);
        expect(env.HAPPIER_SERVER_RETENTION__SWEEP_TIME_BUDGET_MS).toBe("5");
        const outcome = await runRetentionDryRun({
            env,
            // Every read advances 10 ms: a 5 ms budget is spent before the first rule runs.
            readClockMs: () => (clock += 10),
        });
        expect(outcome.status).toBe("ok");
        if (outcome.status !== "ok") return;
        expect(outcome.result.byDomain.homeAdministrationEvents).toMatchObject({ wouldDelete: 0, stopReason: "time_budget" });
    });

    it("refuses a deleting mode stored without its days", async () => {
        const owner = await createAccount("owner");
        await expect(setHomeSettings({
            actorAccountId: owner,
            write: { expectedRevision: 0, values: { [EVENTS_MODE]: "delete_older_than" } },
        })).resolves.toEqual({ status: "invalid", key: EVENTS_DAYS, reason: "required" });
    });

    it("sweeps with the rules stored after the worker started", async () => {
        setDeploymentEnv("HAPPIER_SERVER_RETENTION__INTERVAL_MS", "40");
        const owner = await createAccount("owner");
        await seedEvents(60, 2);
        const worker = startRetentionWorker({ readEnv: () => readHomeConfigEnv(process.env) });
        try {
            // Nothing is stored yet: the startup sweep keeps every event.
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(await db.homeAdministrationEvent.count()).toBe(2);

            await storeRules(owner, { [ENABLED]: true, [EVENTS_MODE]: "delete_older_than", [EVENTS_DAYS]: 30 });
            await waitFor(async () => (await db.homeAdministrationEvent.count({ where: { action: "home.claim" } })) === 0);
            // The audit rows of the write itself are recent and stay.
            expect(await db.homeAdministrationEvent.count()).toBeGreaterThan(0);
        } finally {
            worker.stop();
        }
    });
});
