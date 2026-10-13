import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, WorkflowRunSummaryV1Schema,
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol";
import { db, prismaRuntime } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { materializeWorkflowAcceptedSnapshotFixture } from "@/testkit/workflowAcceptedSnapshot";
import { buildInboxWorkGroups } from "../../../../ui/sources/activity/presentation/buildInboxWorkGroups";
import { workflowRunRowFromSummary } from "../../../../ui/sources/sync/store/domains/workflowRuns";
import { workflowRunAttentionSql, workflowRunAttentionWhere, workflowRunSqlIdentifier } from "./workflowRunAttention";
import { listWorkflowRuns } from "./workflowRunService";

describe("workflow Run attention to Inbox through SQLite", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: "happier-workflow-attention-" }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("indexes only human attention and keeps SQL summaries consistent with relational membership", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}" } });
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
        const expectedHeldCounts = new Map<string, number>();
        for (const scenario of scenarios) {
            const runId = randomUUID();
            const acceptedSnapshot = await materializeWorkflowAcceptedSnapshotFixture({
                definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: "wait", id: "human",
                    document: { text: "Review", references: [], attachments: [] } }] },
                context: { source: { kind: "inline" }, inputs: {}, machineId: machine.id, executionTarget: { kind: "session" },
                    workspaceTarget: { project: { machineId: machine.id, directory: "/repo", checkoutRootPath: "/repo" } },
                    origin: { kind: "direct" }, authorization: { principal: { kind: "host" } } },
            });
            const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
                mode: "plain", binding: { v: 1, purpose: "accepted_snapshot", accountId: account.id, runId }, acceptedSnapshot,
            }));
            const run = await db.automationRun.create({ data: { id: runId, accountId: account.id, originKind: "direct",
                automationId: null, causeKind: null, causeOccurredAt: null,
                workflowAcceptedSnapshotEnvelope: acceptedEnvelope,
                state: scenario.state, scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending",
                assignments: { create: { machineId: machine.id, priority: 0 } } } });
            await db.workflowRunInvocation.create({ data: { id: randomUUID(), runId: run.id, sequence: 0n,
                memberOrdinal: 0n, lifecycle: scenario.lifecycle, contentEnvelope: "unopened-private-progress" } });
            if (scenario.attention) expectedIds.add(run.id);
            expectedHeldCounts.set(run.id, scenario.state !== "cancelled" && scenario.lifecycle === "waiting_for_review" ? 1 : 0);
        }
        const relational = await db.automationRun.findMany({ where: { accountId: account.id,
            AND: [workflowRunAttentionWhere()] }, select: { id: true } });
        const id = workflowRunSqlIdentifier;
        const sql = await db.$queryRaw<Array<{ id: string }>>(prismaRuntime.sql`
            SELECT r.${id("id")} AS ${id("id")} FROM ${id("AutomationRun")} r
            WHERE r.${id("accountId")} = ${account.id} AND ${workflowRunAttentionSql()}`);
        expect(new Set(relational.map(run => run.id))).toEqual(expectedIds);
        expect(new Set(sql.map(run => run.id))).toEqual(expectedIds);
        // Exercise the actual Run projection, rather than a hand-written summary
        // fixture, through the exact strict consumer used by UI and Actions.
        const page = await listWorkflowRuns({ accountId: account.id, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES });
        expect(page.runs).toHaveLength(scenarios.length);
        for (const produced of page.runs) {
            const consumed = WorkflowRunSummaryV1Schema.parse(produced);
            expect(consumed.heldCount).toBe(expectedHeldCounts.get(consumed.id));
            expect(consumed.attentionRequired).toBe(expectedIds.has(consumed.id));
            expect(WorkflowRunSummaryV1Schema.safeParse({ ...produced, unknown: true }).success).toBe(false);
        }
        const needsYou = await listWorkflowRuns({ accountId: account.id, attention: "required",
            pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES });
        expect(new Set(needsYou.runs.map(run => run.id))).toEqual(expectedIds);
        const inbox = buildInboxWorkGroups({ workflowRuns: needsYou.runs.map(run => workflowRunRowFromSummary(run, null)),
            sessionEntries: [], automationRuns: [], automationServerId: "home", openApprovals: [], stalledSessions: [],
            landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null });
        const runItems = inbox.flatMap(group => group.items).filter(item => item.kind === "workflow_run");
        expect(new Set(runItems.map(item => item.runId))).toEqual(expectedIds);
        expect(runItems.filter(item => item.row.summary?.heldCount === 1)).toHaveLength(1);
    });
});
