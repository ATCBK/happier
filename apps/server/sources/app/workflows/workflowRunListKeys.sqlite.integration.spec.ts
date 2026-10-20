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

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: "happier-run-list-keys-",
        env: { HAPPIER_WEB_LATENCY_TRACE: "1" } });
}, 180_000);
afterAll(async () => { if (harness) await harness.close(); });

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
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
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
        expect(phases.filter(phase => phase === "db.WorkflowRunDataKeyEnvelope.findMany")).toHaveLength(1);
        expect(phases.filter(phase => phase === "db.AutomationRun.findUnique")).toHaveLength(0);
    } finally { info.mockRestore(); }
});
