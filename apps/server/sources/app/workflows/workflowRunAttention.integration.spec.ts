import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, prismaRuntime } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { workflowRunAttentionSql, workflowRunAttentionWhere, workflowRunSqlIdentifier } from "./workflowRunAttention";

describe("workflow Run attention storage owner", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: "happier-workflow-attention-" }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("indexes only human attention and keeps SQL summaries consistent with relational membership", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const scenarios = [
            { state: "cancelled", lifecycle: "cancel_requested", attention: false },
            { state: "cancelled", lifecycle: "waiting_for_review", attention: false },
            { state: "interrupted", lifecycle: "failed", attention: false },
            { state: "interrupted", lifecycle: "cancel_requested", attention: false },
            { state: "interrupted", lifecycle: "needs_attention", attention: true },
            { state: "interrupted", lifecycle: "outcome_uncertain", attention: true },
            { state: "running", lifecycle: "waiting_for_review", attention: true },
            { state: "running", lifecycle: "waiting_for_approval", attention: true },
        ] as const;
        const expectedIds = new Set<string>();
        for (const scenario of scenarios) {
            const run = await db.automationRun.create({ data: { accountId: account.id, originKind: "direct",
                automationId: null, causeKind: null, causeOccurredAt: null,
                workflowAcceptedSnapshotEnvelope: "unopened-accepted-snapshot",
                state: scenario.state, scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending" } });
            await db.workflowRunInvocation.create({ data: { id: randomUUID(), runId: run.id, sequence: 0n,
                memberOrdinal: 0n, lifecycle: scenario.lifecycle, contentEnvelope: "unopened-private-progress" } });
            if (scenario.attention) expectedIds.add(run.id);
        }
        const relational = await db.automationRun.findMany({ where: { accountId: account.id,
            AND: [workflowRunAttentionWhere()] }, select: { id: true } });
        const id = workflowRunSqlIdentifier;
        const sql = await db.$queryRaw<Array<{ id: string }>>(prismaRuntime.sql`
            SELECT r.${id("id")} AS ${id("id")} FROM ${id("AutomationRun")} r
            WHERE r.${id("accountId")} = ${account.id} AND ${workflowRunAttentionSql()}`);
        expect(new Set(relational.map(run => run.id))).toEqual(expectedIds);
        expect(new Set(sql.map(run => run.id))).toEqual(expectedIds);
    });
});
