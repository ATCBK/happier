import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WorkflowRunSummaryV1Schema } from "@happier-dev/protocol/workflows/workflowProgressV1";
import { WorkflowRunRecipientCensusResponseV1Schema } from "@happier-dev/protocol/workflows/workflowRunKeyV1";
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol/workflows";
import { sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { logger } from "@/utils/logging/log";
import { materializeWorkflowAcceptedSnapshotFixture } from "@/testkit/workflowAcceptedSnapshot";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { listWorkflowRuns } from "./workflowRunService";

// Native database boundary only: all SQL, snapshots, policy and keys stay real.
type NativeDatabaseBoundary = Pick<typeof db, "$transaction" | "$executeRawUnsafe">;
let nativePrototype: NativeDatabaseBoundary | undefined;
let nativeTransaction: NativeDatabaseBoundary["$transaction"] | undefined;
let nativeExecute: NativeDatabaseBoundary["$executeRawUnsafe"] | undefined;
const nativeTransactions: { leases: number; afterCommit?: () => Promise<void> } = { leases: 0 };
async function afterNativeRead() {
    const hook = nativeTransactions.afterCommit;
    nativeTransactions.afterCommit = undefined;
    await hook?.();
}

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: "happier-run-list-keys-",
        env: { HAPPIER_WEB_LATENCY_TRACE: "1" } });
    const client: unknown = Reflect.get(db, "_originalClient");
    if (!client || typeof client !== "object") throw new Error("Native Prisma test boundary unavailable");
    const prototype: unknown = Object.getPrototypeOf(client);
    if (!prototype || typeof prototype !== "object" || !("$transaction" in prototype)
        || typeof prototype.$transaction !== "function" || !("$executeRawUnsafe" in prototype)
        || typeof prototype.$executeRawUnsafe !== "function") throw new Error("Native Prisma prototype unavailable");
    // Narrow the validated, actually loaded native client boundary, not a second module instance.
    nativePrototype = prototype as NativeDatabaseBoundary;
    nativeTransaction = nativePrototype.$transaction;
    nativeExecute = nativePrototype.$executeRawUnsafe;
    nativePrototype.$transaction = new Proxy(nativeTransaction, {
        async apply(target, receiver, args) {
            nativeTransactions.leases++;
            let result: unknown;
            try { result = await Reflect.apply(target, receiver, args); }
            finally { nativeTransactions.leases--; }
            await afterNativeRead();
            return result;
        },
    });
    nativePrototype.$executeRawUnsafe = new Proxy(nativeExecute, {
        async apply(target, receiver, args) {
            const sql = typeof args[0] === "string" ? args[0].trim().toUpperCase() : "";
            const result: unknown = await Reflect.apply(target, receiver, args);
            if (sql === "BEGIN DEFERRED;") nativeTransactions.leases++;
            if (sql === "ROLLBACK;") {
                nativeTransactions.leases--;
                await afterNativeRead();
            }
            return result;
        },
    });
}, 180_000);
afterAll(async () => {
    if (nativePrototype && nativeTransaction && nativeExecute) {
        nativePrototype.$transaction = nativeTransaction;
        nativePrototype.$executeRawUnsafe = nativeExecute;
    }
    if (harness) await harness.close();
});

it.each(["plain", "e2ee"] as const)("projects %s collection keys without per-Run reads or crossing Run envelopes", async mode => {
    const owner = await db.account.create({ data: { encryptionMode: mode,
        ...(mode === "e2ee" ? createSignedAccountContentBinding() : {}) } });
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "test", metadataVersion: 1 } });
    const runs = Array.from({ length: 12 }, () => ({ id: crypto.randomUUID(), dataKey: tweetnacl.randomBytes(32) }));
    const runIds = runs.map(run => run.id);
    const snapshot = await materializeWorkflowAcceptedSnapshotFixture({
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: "wait", id: "answer",
            document: { text: "Answer", references: [], attachments: [] }, result: { kind: "text" } }] },
        context: { source: { kind: "inline" }, inputs: {}, machineId: machine.id, executionTarget: { kind: "session" },
            workspaceTarget: { project: { machineId: machine.id, directory: "/repo", checkoutRootPath: "/repo" } },
            origin: { kind: "direct" }, authorization: { principal: { kind: "host" } } },
    });
    await db.automationRun.createMany({ data: runs.map(({ id, dataKey }) => ({
        id, accountId: owner.id, originKind: "direct", causeKind: null, state: "queued", scheduledAt: new Date(), dueAt: new Date(),
        workflowAcceptedSnapshotEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            ...(mode === "plain" ? { mode: "plain" as const }
                : { mode: "e2ee" as const, runDataKey: dataKey, randomBytes: tweetnacl.randomBytes }),
            binding: { v: 1, purpose: "accepted_snapshot", accountId: owner.id, runId: id }, acceptedSnapshot: snapshot,
        })),
        workflowCustodyState: "pending",
    })) });
    await db.automationRunAssignment.createMany({ data: runIds.map(runId => ({ runId, machineId: machine.id, priority: 0 })) });
    const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(owner);
    const envelopes = mode === "plain" ? [] : runs.map(run => {
        if (readiness.status !== "available") throw new Error("Fixture signing binding unavailable");
        return { runId: run.id, recipientAccountId: owner.id,
            recipientContentPublicKeyFingerprint: readiness.binding.contentPublicKeyFingerprint,
            encryptedDataKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: run.dataKey,
                recipientPublicKey: readiness.binding.contentPublicKey, randomBytes: tweetnacl.randomBytes })) };
    });
    if (envelopes.length) await db.workflowRunDataKeyEnvelope.createMany({ data: envelopes });
    const keysByRunId = new Map(envelopes.map(row => [row.runId, privacyKit.encodeBase64(row.encryptedDataKey)]));
    // Logging is an external diagnostics sink; authorization, keys and database work stay real.
    const info = vi.spyOn(logger, "debug").mockImplementation(() => {});
    try {
        const page = await listWorkflowRuns({ accountId: owner.id, runIds, pageByteLimit: 1_000_000 });
        expect(new Set(page.runs.map(run => WorkflowRunSummaryV1Schema.parse(run).id))).toEqual(new Set(runIds));
        for (const id of runIds) {
            const key = keysByRunId.get(id) ?? null;
            expect(WorkflowRunRecipientCensusResponseV1Schema.parse(page.keyCensusByRunId[id])).toMatchObject({
                runId: id, ownerAccountId: owner.id, access: "owner", encryptionMode: mode,
                dataEncryptionKey: key, callerDataEncryptionKey: key,
                recipients: [{ recipientAccountId: owner.id, encryptedDataKey: key }],
            });
        }
        const phases = info.mock.calls.map(([record]) => record !== null && typeof record === "object"
            && "phase" in record ? record.phase : null);
        // These are the expensive N+1 reads observed in the live Voice latency trace.
        // Capture and fresh readmission are page-batched, never one read per Run.
        expect(phases.filter(phase => phase === "db.WorkflowRunDataKeyEnvelope.findMany")).toHaveLength(2);
        expect(phases.filter(phase => phase === "db.AutomationRun.findUnique")).toHaveLength(0);
    } finally { info.mockRestore(); }
});

it.each(["mode", "change-cursor", "deletion"] as const)("readmits captured content after an Account %s change", async change => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "test" } });
    const runId = crypto.randomUUID();
    await db.automationRun.create({ data: {
        id: runId, accountId: owner.id, originKind: "direct", causeKind: null, state: "queued",
        scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending",
        workflowAcceptedSnapshotEnvelope: "malformed retained content",
        assignments: { create: { machineId: machine.id, priority: 0 } },
    } });
    // The native database/diagnostic boundary remains real. Change policy only
    // after its capture closes, before the public reader may disclose content.
    let changed = false;
    const materializationLeases: number[] = [];
    const debug = vi.spyOn(logger, "debug").mockImplementation(record => {
        if (record !== null && typeof record === "object" && "phase" in record
            && record.phase === "workflow.list.materialize") materializationLeases.push(nativeTransactions.leases);
    });
    nativeTransactions.afterCommit = async () => {
        changed = true;
        if (change === "deletion") await db.automationRun.delete({ where: { id: runId } });
        else await db.account.update({ where: { id: owner.id }, data: change === "mode"
            ? { encryptionMode: "e2ee" } : { seq: { increment: 1 } } });
    };
    try {
        const result = await Promise.allSettled([listWorkflowRuns({ accountId: owner.id, runIds: [runId], pageByteLimit: 1_000_000 })]);
        if (!changed && result[0].status === "rejected") throw result[0].reason;
        expect(changed).toBe(true);
        expect(materializationLeases, "validation and page serialization must run without a native lease").toEqual([0]);
        expect(nativeTransactions.leases).toBe(0);
        if (change !== "change-cursor") {
            expect(result).toMatchObject([{ status: "rejected", reason: {
                code: change === "mode" ? "content_unavailable" : "run_not_found",
            } }]);
        } else {
            expect(result).toMatchObject([{ status: "fulfilled", value: {
                runs: [{ id: runId }], acceptedEnvelopesByRunId: { [runId]: null },
                keyCensusByRunId: { [runId]: { encryptionMode: "plain" } },
            } }]);
        }
    } finally {
        nativeTransactions.afterCommit = undefined;
        debug.mockRestore();
    }
});

it("keeps exact list continuation across native capture batches", async () => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "test" } });
    const runIds = Array.from({ length: 129 }, () => crypto.randomUUID());
    await db.automationRun.createMany({ data: runIds.map(id => ({
        id, accountId: owner.id, originKind: "direct", causeKind: null, state: "queued",
        scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending",
        workflowAcceptedSnapshotEnvelope: "malformed retained content",
    })) });
    await db.automationRunAssignment.createMany({ data: runIds.map(runId => ({ runId, machineId: machine.id, priority: 0 })) });
    const request = { accountId: owner.id, runIds, pageByteLimit: 1_000_000 };
    const materializationLeases: number[] = [];
    const debug = vi.spyOn(logger, "debug").mockImplementation(record => {
        if (record !== null && typeof record === "object" && "phase" in record
            && record.phase === "workflow.list.materialize") materializationLeases.push(nativeTransactions.leases);
    });
    try {
        const whole = await listWorkflowRuns(request);
        const first = await listWorkflowRuns({ ...request, limit: 128 });
        const second = await listWorkflowRuns({ ...request, cursor: first.nextCursor });
        expect(whole.runs).toHaveLength(129);
        expect(first.runs).toHaveLength(128);
        expect(second.runs).toHaveLength(1);
        expect(second.nextCursor).toBeUndefined();
        expect([...first.runs, ...second.runs]).toEqual(whole.runs);
        expect(new Set(whole.runs.map(run => run.id))).toEqual(new Set(runIds));
        expect(Object.values(whole.acceptedEnvelopesByRunId)).toEqual(Array.from({ length: 129 }, () => null));
        // Whole-page capture crosses the native batch boundary; both CPU phases
        // must release it, as must each of the two separately continued pages.
        expect(materializationLeases).toEqual([0, 0, 0, 0]);
    } finally { debug.mockRestore(); }
});
