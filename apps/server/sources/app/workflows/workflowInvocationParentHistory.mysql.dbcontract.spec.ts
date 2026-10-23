import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol/workflows";
import { db, initDbMysql } from "@/storage/db";
import { listWorkflowRunInvocations } from "./workflowRunService";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "mysql")("Workflow selected parent history (MySQL)", () => {
    let accountId: string;
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_MYSQL_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_MYSQL_DATABASE_URL) {
            throw new Error("Use the disposable MySQL DB-contract harness");
        }
        await initDbMysql();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => {
        if (accountId) {
            await db.automationRun.deleteMany({ where: { accountId } });
            await db.account.delete({ where: { id: accountId } });
        }
        if (connected) await db.$disconnect();
    });

    it("uses one JSON parent set while preserving lifecycle and cursor selection", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        accountId = owner.id;
        const runId = randomUUID();
        const rootId = randomUUID();
        const children = [randomUUID(), randomUUID()];
        await db.automationRun.create({ data: { id: runId, accountId, originKind: "direct", causeKind: null,
            state: "running", scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending",
            workflowAcceptedSnapshotEnvelope: "unopened accepted" } });
        for (const [sequence, id] of [rootId, ...children].entries()) {
            const parentRecordId = sequence === 0 ? null : rootId;
            const memberOrdinal = sequence === 0 ? 0 : sequence - 1;
            const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: "plain",
                binding: { v: 1, purpose: "invocation_progress", accountId, runId, recordId: id,
                    sequence: String(sequence), parentRecordId, memberOrdinal: String(memberOrdinal), attempt: "0" },
                progress: { kind: "happier.workflow-progress.v1", invocationPath: { blockId: sequence === 0 ? "$root" : "work", scope: [] },
                    blockKind: sequence === 0 ? "root" : "step", attempt: "0", logicalInvocationRecordId: id },
            }));
            await db.workflowRunInvocation.create({ data: { id, runId, parentRecordId, sequence: BigInt(sequence),
                memberOrdinal: BigInt(memberOrdinal), lifecycle: "completed", contentEnvelope } });
        }
        const request = { accountId, runId, parentRecordIds: ["absent", rootId], progressEnvelopes: true as const,
            lifecycles: ["completed" as const], limit: 1, pageByteLimit: 5000 };
        const first = await listWorkflowRunInvocations(request);
        const second = await listWorkflowRunInvocations({ ...request, cursor: first.nextCursor });
        expect([first, second].flatMap(page => page.invocations.map(row => row.id))).toEqual(children);
        expect(Object.keys(first.progressEnvelopesByInvocationId!)).toEqual([children[0]]);
        expect(second.nextCursor).toBeUndefined();
    });
});
