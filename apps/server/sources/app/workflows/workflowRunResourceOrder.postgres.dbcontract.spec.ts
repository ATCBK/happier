import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol/workflows";
import { automationAccountCurrentnessSelect, deriveAutomationAccountCurrentnessWitness } from "@/app/automations/automationAccountCurrentness";
import { db, initDbPostgres } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { initializeWorkflowRunExecution } from "./workflowRunService";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Workflow Run resource ordering", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it("rejoins concurrent initialization without a Session resource or duplicate root error", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}" } });
        const run = await db.automationRun.create({ data: {
            accountId: account.id, originKind: "direct", causeKind: null, state: "queued", scheduledAt: new Date(), dueAt: new Date(),
            workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "{}", claimedByMachineId: machine.id,
            attempt: 1, assignments: { create: { machineId: machine.id, priority: 0 } },
        } });
        const accountCurrentness = deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({
            where: { id: account.id }, select: automationAccountCurrentnessSelect,
        }));
        if (!accountCurrentness) throw new Error("Fixture currentness unavailable");
        const rootId = randomUUID();
        const input = { accountId: account.id, runId: run.id, machineId: machine.id, parentAttempt: 1,
            expectedRevision: 0, accountCurrentness,
            checkpointEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
                mode: "plain", binding: { v: 1, purpose: "checkpoint", accountId: account.id, runId: run.id },
                checkpoint: { kind: "happier.workflow-checkpoint.v1", rootRecordId: rootId, nextSequence: "1",
                    frontier: { nextBlockOrdinal: 1, paused: false } },
            })),
            rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
                mode: "plain", binding: { v: 1, purpose: "invocation_progress", accountId: account.id, runId: run.id,
                    recordId: rootId, sequence: "0", parentRecordId: null, memberOrdinal: "0", attempt: "0" },
                progress: { kind: "happier.workflow-progress.v1", invocationPath: { blockId: "$root", scope: [] },
                    blockKind: "root", attempt: "0", logicalInvocationRecordId: rootId },
            })) },
        };
        let release!: () => void;
        const mayContinue = new Promise<void>(resolve => { release = resolve; });
        let censusReady!: () => void;
        const firstCensus = new Promise<void>(resolve => { censusReady = resolve; });
        const original = db.$transaction.bind(db);
        let firstPid = 0;
        let secondPid = 0;
        let paused = false;
        const observed = async <T>(body: (tx: Tx) => Promise<T>, options?: Parameters<typeof original>[1]) => original(async tx => {
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            if (firstPid === 0) firstPid = pid; else secondPid = pid;
            // Only the real DB transport pauses; all workflow decisions and
            // root-census results remain production-owned.
            const invocations = new Proxy(tx.workflowRunInvocation, { get(target, key, receiver) {
                if (key !== "count") return Reflect.get(target, key, receiver);
                return async (...args: Parameters<typeof target.count>) => {
                    const value = await target.count(...args);
                    if (!paused && pid === firstPid) {
                        paused = true;
                        censusReady();
                        await mayContinue;
                    }
                    return value;
                };
            } });
            return body(new Proxy(tx, { get(target, key, receiver) {
                return key === "workflowRunInvocation" ? invocations : Reflect.get(target, key, receiver);
            } }));
        }, options);
        db.$transaction = observed as typeof db.$transaction;
        let outcomes: Promise<PromiseSettledResult<Awaited<ReturnType<typeof initializeWorkflowRunExecution>>>[]> | undefined;
        try {
            const first = initializeWorkflowRunExecution(input);
            void first.catch(() => undefined);
            await Promise.race([firstCensus, first.then(() => { throw new Error("First initialization skipped root census"); })]);
            let secondSettled = false;
            const second = initializeWorkflowRunExecution(input).finally(() => { secondSettled = true; });
            outcomes = Promise.allSettled([first, second]);
            while (!secondSettled) {
                const [{ waiting }] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                    SELECT ${firstPid}::int = ANY(pg_blocking_pids(${secondPid}::int)) AS waiting
                `;
                if (waiting) break;
            }
            release();
            const results = await outcomes;
            for (const result of results) if (result.status === "rejected") throw result.reason;
            expect(results.map(result => result.status === "fulfilled" ? result.value.initialization : null).sort())
                .toEqual(["created", "existing"]);
            expect(await db.workflowRunInvocation.count({ where: { runId: run.id, parentRecordId: null } })).toBe(1);
            expect((await db.automationRun.findUniqueOrThrow({ where: { id: run.id } })).revision).toBe(1);
        } finally {
            release();
            await outcomes;
            db.$transaction = original;
            await db.automationRun.delete({ where: { id: run.id } });
            await db.machine.delete({ where: { id: machine.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
