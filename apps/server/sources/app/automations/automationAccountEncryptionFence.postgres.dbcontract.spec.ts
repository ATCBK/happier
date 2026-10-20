import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
    acquireAccountEncryptionTransitionFenceInTx,
    applyAccountEncryptionTransitionInTx,
} from "@/app/encryption/accountEncryptionTransition";
import { readRetentionPolicyFromEnv } from "@/app/retention/config/readRetentionPolicyFromEnv";
import { createAutomationRunRetentionRule } from "@/app/retention/rules/automationRunRetentionRule";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

import { finalizeDeletedAutomationsWithoutRetainedRunsTx } from "./automationCrudService";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")(
    "Automation finalization through the Account transition fence (PostgreSQL)",
    () => {
        beforeAll(async () => {
            if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
                || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
                throw new Error("Run with the disposable PostgreSQL DB-contract harness");
            }
            initDbPostgres();
            await db.$connect();
        });
        afterAll(async () => { await db.$disconnect(); });

        it("retention waits for the transition, then consumes only committed soft-deleted definitions", async () => {
            const account = await db.account.create({
                data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" },
            });
            const foreign = await db.account.create({ data: { encryptionMode: "plain" } });
            const automationId = randomUUID();
            const liveAutomationId = randomUUID();
            for (const id of [automationId, liveAutomationId]) {
                await db.automation.create({ data: {
                    id, accountId: account.id, name: "Transition retention contract",
                    enabled: false, targetType: "new_session",
                    templateCiphertext: JSON.stringify({
                        kind: "happier_automation_template_encrypted_v1", payloadCiphertext: "opaque",
                    }),
                } });
            }

            // A mis-bound Account must not delete another Account's definition.
            await db.automation.update({ where: { id: automationId }, data: { deletedAt: new Date() } });
            expect(await inTx(tx => finalizeDeletedAutomationsWithoutRetainedRunsTx({
                tx, accountId: foreign.id, limit: 1,
            }))).toBe(0);
            expect(await db.automation.findUnique({ where: { id: automationId } })).not.toBeNull();
            // The transition restores a candidate while retention's unfenced
            // global census can still see its previously committed deletion.
            let retention: ReturnType<ReturnType<typeof createAutomationRunRetentionRule>["run"]> | undefined;
            try {
                let blocked = false;
                await inTx(async transitionTx => {
                    const [{ pid }] = await transitionTx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                    const fence = await acquireAccountEncryptionTransitionFenceInTx(transitionTx, account.id, "exclusive");
                    expect(fence.status).toBe("ready");
                    if (fence.status !== "ready") throw new Error("Transition fence unavailable");
                    await transitionTx.automation.update({ where: { id: automationId }, data: { deletedAt: null } });
                    let settled = false;
                    retention = createAutomationRunRetentionRule().run({
                        policy: readRetentionPolicyFromEnv({}),
                        batchSize: 1, maxDeletesPerRulePerRun: 1, dryRun: false, now: new Date(),
                    }).finally(() => { settled = true; });
                    void retention.catch(() => undefined);
                    while (!settled) {
                        const waits = await db.$queryRaw<Array<{ accountFence: boolean }>>`
                            SELECT query LIKE '%Account%' AS "accountFence" FROM pg_stat_activity
                            WHERE datname = current_database()
                              AND ${pid} = ANY(pg_blocking_pids(pid))
                        `;
                        if (waits.length > 0) {
                            blocked = true;
                            expect(waits.every(wait => wait.accountFence)).toBe(true);
                            break;
                        }
                    }
                    expect(blocked).toBe(true);
                    await applyAccountEncryptionTransitionInTx(transitionTx, {
                        accountId: account.id, expectedVersion: fence.account.version,
                        toMode: "plain", contentKey: { kind: "preserve" },
                    });
                });
                await retention;
                expect(await db.account.findUniqueOrThrow({
                    where: { id: account.id }, select: { encryptionMode: true },
                })).toEqual({ encryptionMode: "plain" });
                expect(await db.automation.findUnique({ where: { id: automationId } })).toMatchObject({ deletedAt: null });
                expect(await db.automation.findUnique({ where: { id: liveAutomationId } })).not.toBeNull();
                await db.automation.update({ where: { id: automationId }, data: { deletedAt: new Date() } });
                await createAutomationRunRetentionRule().run({
                    policy: readRetentionPolicyFromEnv({}),
                    batchSize: 1, maxDeletesPerRulePerRun: 1, dryRun: false, now: new Date(),
                });
                expect(await db.automation.findUnique({ where: { id: automationId } })).toBeNull();
                expect(await db.automation.count({ where: { accountId: account.id } })).toBe(1);
            } finally {
                await retention?.catch(() => undefined);
                await db.account.deleteMany({ where: { id: { in: [account.id, foreign.id] } } });
            }
        });
    },
);
