import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WorkflowRunSummaryV1Schema } from "@happier-dev/protocol/workflows/workflowProgressV1";
import { WorkflowRunRecipientCensusResponseV1Schema } from "@happier-dev/protocol/workflows/workflowRunKeyV1";
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol/workflows";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { logger } from "@/utils/logging/log";
import { materializeWorkflowAcceptedSnapshotFixture } from "@/testkit/workflowAcceptedSnapshot";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { listWorkflowRuns, summarizeWorkflowRuns } from "./workflowRunService";

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

it.each(["mode", "change-cursor", "deletion"] as const)("freshly readmits public latest status after an Account %s change", async change => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const automation = await db.automation.create({ data: { accountId: owner.id, name: "Latest status", targetType: null, templateCiphertext: "{}" } });
    const runId = crypto.randomUUID();
    await db.automationRun.create({ data: { id: runId, accountId: owner.id, automationId: automation.id,
        originKind: "automation", causeKind: "manual", causeOccurredAt: new Date(), state: "failed",
        scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "unopened" } });
    let changed = false;
    const leases: number[] = [];
    const debug = vi.spyOn(logger, "debug").mockImplementation(record => {
        if (record && typeof record === "object" && "phase" in record && record.phase === "workflow.summaries.materialize") leases.push(nativeTransactions.leases);
    });
    nativeTransactions.afterCommit = async () => {
        changed = true;
        if (change === "deletion") await db.automationRun.delete({ where: { id: runId } });
        else await db.account.update({ where: { id: owner.id }, data: change === "mode" ? { encryptionMode: "e2ee" } : { seq: { increment: 1 } } });
    };
    try {
        const result = await Promise.allSettled([summarizeWorkflowRuns({ accountId: owner.id, automationIds: [automation.id], pageByteLimit: 1_000_000 })]);
        if (!changed && result[0].status === "rejected") throw result[0].reason;
        expect(changed).toBe(true);
        expect(leases).toEqual([0]);
        expect(nativeTransactions.leases).toBe(0);
        if (change === "change-cursor") expect(result).toMatchObject([{ status: "fulfilled", value: {
            automationSummaries: [{ automationId: automation.id, lastRun: { id: runId, attentionRequired: true } }], remainingAutomationIds: [],
        } }]);
        else expect(result).toMatchObject([{ status: "rejected", reason: { code: change === "mode" ? "content_unavailable" : "run_not_found" } }]);
    } finally { nativeTransactions.afterCommit = undefined; debug.mockRestore(); }
});

it("keeps summary queries set-oriented for 1129 requested ids without acquiring private payload columns or imposing a cap", async () => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const automationIds = Array.from({ length: 129 }, () => crypto.randomUUID());
    await db.automation.createMany({ data: automationIds.map(id => ({ id, accountId: owner.id, name: "Status", targetType: null, templateCiphertext: "{}" })) });
    await db.automationRun.createMany({ data: automationIds.map(automationId => ({ id: crypto.randomUUID(), automationId, accountId: owner.id,
        originKind: "automation", causeKind: "manual", causeOccurredAt: new Date(), state: "succeeded", workflowCustodyState: "settled",
        scheduledAt: new Date(), dueAt: new Date(), workflowAcceptedSnapshotEnvelope: "unopened accepted", workflowCheckpointEnvelope: "unopened checkpoint" })) });
    // Initialize the storage-owned SQLite read connection before observing domain queries.
    await summarizeWorkflowRuns({ accountId: owner.id, automationIds: automationIds.slice(0, 1), pageByteLimit: 1_000_000 });
    const client: unknown = Reflect.get(db, "_originalClient");
    if (!client || typeof client !== "object") throw new Error("Native Prisma boundary unavailable");
    // SQLite's coherent reads use a second native client of this same provider constructor.
    const boundary: unknown = Object.getPrototypeOf(client);
    if (!boundary || typeof boundary !== "object") throw new Error("Native Prisma prototype unavailable");
    const request: unknown = Reflect.get(boundary, "_request");
    if (typeof request !== "function") throw new Error("Native Prisma request boundary unavailable");
    let rawQueries = 0;
    let privatePayloadColumns = 0;
    Reflect.set(boundary, "_request", new Proxy(request, { async apply(target, receiver, args) {
        const result: unknown = await Reflect.apply(target, receiver, args);
        if (args[0] && typeof args[0] === "object" && "action" in args[0] && args[0].action === "queryRaw") {
            rawQueries++;
        }
        for (const row of Array.isArray(result) ? result : [result]) if (row && typeof row === "object") {
            for (const field of ["workflowAcceptedSnapshotEnvelope", "workflowCheckpointEnvelope", "contentEnvelope"]) {
                if (Object.hasOwn(row, field)) privatePayloadColumns++;
            }
        }
        return result;
    } }));
    try {
        const one = await summarizeWorkflowRuns({ accountId: owner.id, automationIds: automationIds.slice(0, 1), pageByteLimit: 1_000_000 });
        expect(one.automationSummaries).toHaveLength(1);
        const singleQueries = rawQueries;
        rawQueries = 0;
        const many = await summarizeWorkflowRuns({ accountId: owner.id, automationIds, pageByteLimit: 1_000_000 });
        expect(many.automationSummaries.map(summary => summary.automationId)).toEqual(automationIds);
        expect({ singleQueries, pageQueries: rawQueries, privatePayloadColumns }).toEqual({ singleQueries: 1, pageQueries: 1, privatePayloadColumns: 0 });
        const oversizedIds = [...automationIds, ...Array.from({ length: 1000 }, () => crypto.randomUUID())];
        rawQueries = 0;
        const oversized = await summarizeWorkflowRuns({ accountId: owner.id, automationIds: oversizedIds, pageByteLimit: 1_000_000 });
        expect(oversized.automationSummaries.map(summary => summary.automationId)).toEqual(oversizedIds);
        expect(oversized.remainingAutomationIds).toEqual([]);
        const automationQueries = rawQueries;
        rawQueries = 0;
        const sources = await summarizeWorkflowRuns({ accountId: owner.id, sourceArtifactIds: oversizedIds, recent: 1, pageByteLimit: 1_000_000 });
        expect(sources.summaries.map(summary => summary.sourceArtifactId)).toEqual(oversizedIds);
        expect(sources.summaries.every(summary => summary.lastRun === null)).toBe(true);
        expect(sources.remainingSourceArtifactIds).toEqual([]);
        expect({ automationQueries, sourceQueries: rawQueries, privatePayloadColumns })
            .toEqual({ automationQueries: 1, sourceQueries: 1, privatePayloadColumns: 0 });
        console.info("PERF-S4-workflow-summary-queries", { singleQueries, pageQueries: 1, requestedIds: oversizedIds.length,
            automationQueries, sourceQueries: rawQueries, privatePayloadColumns });
    } finally { Reflect.set(boundary, "_request", request); }
});

it.each(["membership", "automation-status"] as const)("freshly readmits Team %s after capture and refuses a revoked source grant", async projection => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const viewer = await db.account.create({ data: { encryptionMode: "plain" } });
    const team = await db.team.create({ data: { name: "Compact attention" } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: viewer.id, role: "member" } });
    const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
        header: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: "workflow-definition.v1" }))),
        body: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({}))),
        dataEncryptionKey: new Uint8Array(privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)) } });
    await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id, accessLevel: "view", createdByAccountId: owner.id } });
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "test" } });
    const runId = crypto.randomUUID();
    const automation = await db.automation.create({ data: { accountId: owner.id, name: "Team status", targetType: null, templateCiphertext: "{}" } });
    await db.automationRun.create({ data: { id: runId, accountId: owner.id, sourceArtifactId: artifact.id, visibleTeamId: team.id,
        originKind: "automation", automationId: automation.id, causeKind: "manual", causeOccurredAt: new Date(), state: "failed", scheduledAt: new Date(), dueAt: new Date(),
        workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "unopened private content",
        assignments: { create: { machineId: machine.id, priority: 0 } } } });
    let revoked = false;
    nativeTransactions.afterCommit = async () => {
        revoked = true;
        await db.artifactTeamGrant.deleteMany({ where: { artifactId: artifact.id, teamId: team.id } });
    };
    try {
        await expect(projection === "membership"
            ? listWorkflowRuns({ accountId: viewer.id, attention: "required", projection: "membership", pageByteLimit: 1_000_000 })
            : summarizeWorkflowRuns({ accountId: viewer.id, automationIds: [automation.id], pageByteLimit: 1_000_000 }))
            .rejects.toMatchObject({ code: "run_not_found" });
        expect(revoked).toBe(true);
        expect(nativeTransactions.leases).toBe(0);
    } finally { nativeTransactions.afterCommit = undefined; }
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

it.each((["mode", "change-cursor", "deletion"] as const).flatMap(change => [
    { change, projection: undefined }, { change, projection: "membership" as const },
]))("readmits $projection captured content after an Account $change change", async ({ change, projection }) => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "test" } });
    const runId = crypto.randomUUID();
    await db.automationRun.create({ data: {
        id: runId, accountId: owner.id, originKind: "direct", causeKind: null, state: "failed",
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
        const result = await Promise.allSettled([listWorkflowRuns({ accountId: owner.id, runIds: [runId], pageByteLimit: 1_000_000,
            ...(projection ? { projection, attention: "required" as const } : {}) })]);
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
                runs: [{ id: runId }], acceptedEnvelopesByRunId: projection ? {} : { [runId]: null },
                keyCensusByRunId: projection ? {} : { [runId]: { encryptionMode: "plain" } },
            } }]);
        }
    } finally {
        nativeTransactions.afterCommit = undefined;
        debug.mockRestore();
    }
});

it.each([undefined, "membership"] as const)("keeps %s exact list continuation across native capture batches", async projection => {
    const owner = await db.account.create({ data: { encryptionMode: "plain" } });
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "test" } });
    const runIds = Array.from({ length: 129 }, () => crypto.randomUUID());
    await db.automationRun.createMany({ data: runIds.map(id => ({
        id, accountId: owner.id, originKind: "direct", causeKind: null, state: "failed",
        scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending",
        workflowAcceptedSnapshotEnvelope: "malformed retained content",
    })) });
    await db.automationRunAssignment.createMany({ data: runIds.map(runId => ({ runId, machineId: machine.id, priority: 0 })) });
    const request = { accountId: owner.id, runIds, pageByteLimit: 1_000_000,
        attention: "required" as const, ...(projection ? { projection } : {}) };
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
        expect(Object.values(whole.acceptedEnvelopesByRunId)).toEqual(projection ? [] : Array.from({ length: 129 }, () => null));
        // Whole-page capture crosses the native batch boundary; both CPU phases
        // must release it, as must each of the two separately continued pages.
        expect(materializationLeases).toEqual([0, 0, 0, 0]);
        await expect(listWorkflowRuns({ ...request, cursor: first.nextCursor,
            projection: projection ? undefined : "membership" })).rejects.toMatchObject({ code: "invalid_input" });
    } finally { debug.mockRestore(); }
});
