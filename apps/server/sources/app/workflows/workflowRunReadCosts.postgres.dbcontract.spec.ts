import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";
import { measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from "@happier-dev/protocol";
import { WorkflowRunInvocationIndexV1Schema } from "@happier-dev/protocol/workflows/workflowProgressV1";
import { openWorkflowProgressStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol/workflows";
import { db, initDbPostgres } from "@/storage/db";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerWorkflowRunStorageRoutes } from "@/app/api/routes/automations/registerWorkflowRunStorageRoutes";
import { eventRouter } from "@/app/events/eventRouter";
import { admitWorkflowInvocations, commitWorkflowInvocationFact, completeWorkflowInvocationReview, listWorkflowRunInvocations, listWorkflowRuns, listWorkflowRunsForRecovery, summarizeWorkflowRuns } from "./workflowRunService";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Workflow narrow reads and publication costs (PostgreSQL)", () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, "query">;
    let originalTransaction: typeof db.$transaction;
    let ownerId: string;
    let machineId: string;
    let runId: string;
    let rootId: string;
    let children: string[];
    let latestId: string;
    const envelopes = new Map<string, string>();

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
        client.$on("query", event => statements.push(event));
        await client.$connect();
        originalTransaction = db.$transaction;
        // Observe the real native SQL boundary; storage, policy, envelopes and
        // transaction admission remain production-owned.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        ownerId = owner.id;
        machineId = randomUUID();
        runId = randomUUID();
        rootId = randomUUID();
        children = Array.from({ length: 500 }, () => randomUUID());
        latestId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: ownerId, metadata: "{}" } });
        await db.automationRun.create({ data: { id: runId, accountId: ownerId, originKind: "direct", causeKind: null,
            state: "running", workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "unopened-accepted",
            claimedByMachineId: machineId, attempt: 1, scheduledAt: new Date(), dueAt: new Date(),
            assignments: { create: { machineId, priority: 0 } } } });
        const row = (id: string, sequence: number, ordinal: number, attempt = 0) => {
            const parentRecordId = sequence === 0 ? null : rootId;
            const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
                mode: "plain", binding: { v: 1, purpose: "invocation_progress", accountId: ownerId, runId,
                    recordId: id, sequence: String(sequence), parentRecordId, memberOrdinal: String(ordinal), attempt: String(attempt) },
                progress: { kind: "happier.workflow-progress.v1", invocationPath: { blockId: sequence === 0 ? "$root" : "work", scope: [] },
                    blockKind: sequence === 0 ? "root" : "step", attempt: String(attempt),
                    logicalInvocationRecordId: attempt === 0 ? id : children[7]!,
                    ...(attempt === 0 ? {} : { previousAttemptRecordId: children[7]! }), result: "x".repeat(2048) },
            }));
            envelopes.set(id, contentEnvelope);
            return { id, runId, sequence: BigInt(sequence), parentRecordId, memberOrdinal: BigInt(ordinal),
                attempt: BigInt(attempt), lifecycle: "running" as const, contentEnvelope };
        };
        await db.workflowRunInvocation.createMany({ data: [row(rootId, 0, 0),
            ...children.map((id, index) => row(id, index + 1, index)), row(latestId, 501, 7, 1)] });
    });
    afterAll(async () => {
        if (originalTransaction) db.$transaction = originalTransaction;
        if (ownerId) {
            await db.automationRun.deleteMany({ where: { accountId: ownerId } });
            await db.machine.deleteMany({ where: { accountId: ownerId } });
            await db.account.delete({ where: { id: ownerId } });
        }
        await client?.$disconnect();
        await db.$disconnect();
    });

    function costs() {
        const sql = statements.filter(event => !/^(BEGIN|COMMIT|ROLLBACK|SET|SHOW)\b/i.test(event.query.trimStart()));
        const invocationSelects = sql.filter(event => /^SELECT\b/i.test(event.query.trimStart()) && event.query.includes('"WorkflowRunInvocation"'));
        return { totalStatements: statements.length, statements: sql.length, invocationSelects: invocationSelects.length,
            maxBindParameters: Math.max(0, ...sql.flatMap(event => [...event.query.matchAll(/\$(\d+)/g)].map(match => Number(match[1])))) };
    }

    it("reads one exact invocation and newest parent slot without opening the other 500 progress bodies", async () => {
        const base = { accountId: ownerId, runId, progressEnvelopes: true as const, pageByteLimit: 4_000_000 };
        statements.length = 0;
        const exact = await listWorkflowRunInvocations({ ...base, invocationId: children[7]! });
        const exactCosts = costs();
        expect(exact.invocations.map(row => row.id)).toEqual([children[7]]);
        expect(exact.progressEnvelopesByInvocationId).toEqual({ [children[7]!]: envelopes.get(children[7]!) });
        statements.length = 0;
        const slot = await listWorkflowRunInvocations({ ...base, parentRecordId: rootId, memberOrdinal: "7" });
        const slotCosts = costs();
        expect(slot.invocations.map(row => row.id)).toEqual([latestId]);
        expect(slot.progressEnvelopesByInvocationId).toEqual({ [latestId]: envelopes.get(latestId) });
        expect(exactCosts.invocationSelects).toBe(1);
        expect(slotCosts.invocationSelects).toBe(1);
        await expect(listWorkflowRunInvocations({ ...base, invocationId: randomUUID() })).resolves.toMatchObject({ invocations: [], progressEnvelopesByInvocationId: {} });
        await db.workflowRunInvocation.update({ where: { id: children[7] }, data: { lifecycle: "waiting_for_review" } });
        try {
            const held = await listWorkflowRunInvocations({ ...base, parentRecordId: rootId, memberOrdinal: "7", lifecycles: ["waiting_for_review"] });
            expect(held.invocations).toEqual([]);
        } finally { await db.workflowRunInvocation.update({ where: { id: children[7] }, data: { lifecycle: "running" } }); }
    });

    it("discloses byte-bounded parent progress through the real HTTP route and rejects mis-bound reads", async () => {
        const app = createAuthenticatedTestApp();
        registerWorkflowRunStorageRoutes(app);
        await app.ready();
        const read = (input: object) => app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage",
            headers: { "x-test-user-id": ownerId }, payload: { operation: "invocations.list", runId, pageByteLimit: 5000, ...input } });
        try {
            const response = await read({ parentRecordId: rootId, progressEnvelopes: true });
            expect(response.statusCode, response.body).toBe(200);
            const page: Awaited<ReturnType<typeof listWorkflowRunInvocations>> = response.json();
            expect(page.invocations).toHaveLength(1);
            const index = WorkflowRunInvocationIndexV1Schema.parse(page.invocations[0]);
            expect(page.progressEnvelopesByInvocationId).toEqual({ [page.invocations[0]!.id]: envelopes.get(page.invocations[0]!.id) });
            expect(openWorkflowProgressStoredEnvelopeV1({ mode: "plain", binding: { v: 1, purpose: "invocation_progress", accountId: ownerId,
                runId, recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
                memberOrdinal: index.memberOrdinal, attempt: index.attempt },
                envelope: JSON.parse(page.progressEnvelopesByInvocationId![index.id]!) })).toMatchObject({ kind: "available" });
            expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(page)).toBeLessThanOrEqual(5000);
            expect(page.nextCursor).toBeTypeOf("string");
            const second = await read({ parentRecordId: rootId, progressEnvelopes: true, cursor: page.nextCursor });
            expect(second.statusCode, second.body).toBe(200);
            const secondPage: Awaited<ReturnType<typeof listWorkflowRunInvocations>> = second.json();
            expect(secondPage.invocations[0]!.id).not.toBe(page.invocations[0]!.id);
            expect((await read({ parentRecordId: rootId, memberOrdinal: "7", progressEnvelopes: true })).json()).toMatchObject({ invocations: [{ id: latestId }] });
            expect((await read({ invocationId: children[7], progressEnvelopes: true })).json()).toMatchObject({ invocations: [{ id: children[7] }] });
            expect((await read({ parentRecordIds: [rootId], progressEnvelopes: true, limit: 1 })).json()).toMatchObject({ invocations: [{ id: children[0] }] });
            // A selector cannot be silently dropped or reused as a broad history cursor.
            expect((await read({ invocationId: children[7], parentRecordId: rootId })).statusCode).toBe(400);
            expect((await read({ invocationId: children[7], cursor: page.nextCursor })).statusCode).toBe(422);
            expect((await read({ invocationId: children[7], runId: randomUUID() })).statusCode).not.toBe(200);
        } finally { await app.close(); }
    });

    it("set-reads directly selected parent histories beyond PostgreSQL's bind count without unrelated root bodies", async () => {
        // Invocation ids are bounded NFC strings, not necessarily UUIDs. This
        // caller set fits the HTTP input byte budget but exceeds 32767 binds.
        const parentRecordIds = [rootId, ...Array.from({ length: 35_000 }, (_, index) => `absent-${index}`)];
        statements.length = 0;
        const page = await listWorkflowRunInvocations({ accountId: ownerId, runId, parentRecordIds,
            progressEnvelopes: true, limit: 1, pageByteLimit: 5000, lifecycles: ["running"] });
        const batchCosts = costs();
        expect(page.invocations.map(row => row.id)).toEqual([children[0]]);
        expect(page.progressEnvelopesByInvocationId).toEqual({ [children[0]!]: envelopes.get(children[0]!) });
        expect(page.nextCursor).toBeTypeOf("string");
        expect(batchCosts.invocationSelects).toBe(2);
        expect(batchCosts.maxBindParameters).toBeLessThan(10);
        const second = await listWorkflowRunInvocations({ accountId: ownerId, runId, parentRecordIds: [...parentRecordIds].reverse(),
            progressEnvelopes: true, limit: 1, cursor: page.nextCursor, pageByteLimit: 5000, lifecycles: ["running"] });
        expect(second.invocations.map(row => row.id)).toEqual([children[1]]);
        await expect(listWorkflowRunInvocations({ accountId: ownerId, runId, parentRecordIds: [rootId],
            cursor: page.nextCursor, pageByteLimit: 5000 })).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("measures summary, membership and changed versus repeated publication without private-body fanout", async () => {
        const sourceIds = Array.from({ length: 500 }, () => randomUUID());
        statements.length = 0;
        const summary = await summarizeWorkflowRuns({ accountId: ownerId, sourceArtifactIds: sourceIds, recent: 3, pageByteLimit: 1_000_000 });
        const summaryCosts = costs();
        expect(summary.summaries).toHaveLength(500);
        const summaryPrivateColumns = statements.some(event => /"(?:workflowAcceptedSnapshotEnvelope|workflowCheckpointEnvelope|contentEnvelope)"/.test(event.query));
        expect(summaryPrivateColumns).toBe(false);
        statements.length = 0;
        expect((await listWorkflowRuns({ accountId: ownerId, attention: "required", projection: "membership", pageByteLimit: 1_000_000 })).runs).toEqual([]);
        const attentionCosts = costs();
        const publication = vi.spyOn(eventRouter, "emitUpdate");
        const input = { accountId: ownerId, runId, machineId, parentAttempt: 1, invocationId: children[0]!, invocationAttempt: 0n,
            expectedContentRevision: 0n, expectedLifecycle: "running" as const, lifecycle: "waiting_for_review" as const,
            contentEnvelope: envelopes.get(children[0]!)!, accountCurrentness: { mode: "plain" as const, version: 0, contentKeyFingerprint: null } };
        try {
            statements.length = 0;
            const changed = await commitWorkflowInvocationFact(input);
            const changedCosts = costs();
            const changedEmissions = publication.mock.calls.length;
            publication.mockClear();
            statements.length = 0;
            await commitWorkflowInvocationFact({ ...input, expectedContentRevision: BigInt(changed.contentRevision), expectedLifecycle: "waiting_for_review" });
            const repeatedCosts = costs();
            expect(publication.mock.calls).toHaveLength(0);
            const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: "plain",
                binding: { v: 1, purpose: "checkpoint", accountId: ownerId, runId },
                checkpoint: { kind: "happier.workflow-checkpoint.v1", rootRecordId: rootId, nextSequence: "503",
                    frontier: { nextBlockOrdinal: 1, paused: false } },
            }));
            await db.automationRun.update({ where: { id: runId }, data: { workflowCheckpointEnvelope: checkpointEnvelope } });
            const nextId = randomUUID();
            const nextEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: "plain",
                binding: { v: 1, purpose: "invocation_progress", accountId: ownerId, runId,
                    recordId: nextId, sequence: "502", parentRecordId: rootId, memberOrdinal: "500", attempt: "0" },
                progress: { kind: "happier.workflow-progress.v1", invocationPath: { blockId: "work", scope: [] },
                    blockKind: "step", attempt: "0", logicalInvocationRecordId: nextId },
            }));
            statements.length = 0;
            const admission = await admitWorkflowInvocations({ accountId: ownerId, runId, machineId, parentAttempt: 1,
                expectedRevision: changed.parentRevision, accountCurrentness: input.accountCurrentness, checkpointEnvelope,
                invocations: [{ id: nextId, sequence: 502n, parentRecordId: rootId, memberOrdinal: 500n, contentEnvelope: nextEnvelope }] });
            const admissionCosts = costs();
            expect(admission.disposition).toBe("created");
            statements.length = 0;
            const resolved = await completeWorkflowInvocationReview({ ...input,
                expectedContentRevision: BigInt(changed.contentRevision), mode: "use_result" });
            const resolutionCosts = costs();
            expect(resolved.disposition).toBe("completed");
            await db.automationRun.update({ where: { id: runId }, data: { state: "interrupted" } });
            statements.length = 0;
            const recovery = await listWorkflowRunsForRecovery({ accountId: ownerId, machineId, pageByteLimit: 1_000_000 });
            const recoveryCosts = costs();
            expect(recovery.candidates.map(candidate => candidate.run.id)).toEqual([runId]);
        } finally { publication.mockRestore(); }
    });

    // Opt-in regression supplied to the active SRVQ summary owner. Keep the
    // ordinary FIN validation usable while that separate corridor is in flight.
    it.skipIf(process.env.HAPPIER_PERF_FIN_RT_SUMMARY_PROBE !== "1").each(["source", "automation"] as const)(
        "reads %s summaries beyond PostgreSQL's bind boundary", async kind => {
        const ids = Array.from({ length: 35_000 }, (_, index) => `absent-${index}`);
        const request = kind === "source" ? { sourceArtifactIds: ids, recent: 1 } : { automationIds: ids };
        try {
            const result = await summarizeWorkflowRuns({ accountId: ownerId, ...request, pageByteLimit: 4_000_000 });
            expect("summaries" in result ? result.summaries.length : result.automationSummaries.length).toBe(ids.length);
        } catch (error) {
            throw error;
        }
    });
});
