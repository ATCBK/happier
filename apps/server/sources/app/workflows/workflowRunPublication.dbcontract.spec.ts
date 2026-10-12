import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as privacyKit from "privacy-kit";
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    AutomationRunCauseSchema,
    encodePlainArtifactStoredContent,
    serializeAutomationStoredWorkflowDefinitionRecipeV2,
} from "@happier-dev/protocol";
import { db, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { encodeAutomationRunCause } from "@/app/automations/automationRunCauseCodec";
import { automationAccountCurrentnessSelect, deriveAutomationAccountCurrentnessWitness } from "@/app/automations/automationAccountCurrentness";
import { materializeWorkflowAcceptedSnapshotFixture } from "@/testkit/workflowAcceptedSnapshot";
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol/workflows";
import { admitWorkflowRun, cancelWorkflowRun } from "./workflowRunService";

const provider = process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres";

function sqlState(error: unknown): string | null {
    if (error === null || typeof error !== "object" || !("meta" in error)) return null;
    const meta = error.meta;
    return meta !== null && typeof meta === "object" && "code" in meta && typeof meta.code === "string"
        ? meta.code : null;
}

function accountLockRows(query: string, result: unknown): string[] {
    if (!query.includes('FROM "Account"') || !query.includes("FOR ") || !Array.isArray(result)) return [];
    return result.flatMap(row => row !== null && typeof row === "object" && "id" in row && typeof row.id === "string"
        ? [row.id] : []);
}

describe.skipIf(provider !== "postgres" && provider !== "postgresql")("Workflow ordered publication (real PostgreSQL)", () => {
    const accountIds: string[] = [];
    const teamIds: string[] = [];
    let connected = false;
    let restoreTransport: (() => void) | null = null;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing disposable DATABASE_URL for Workflow DB contract");
        initDbPostgres();
        await db.$connect();
        connected = true;
    });

    afterEach(async () => {
        restoreTransport?.();
        restoreTransport = null;
        vi.unstubAllEnvs();
        await db.automationTrigger.deleteMany({ where: { automation: { accountId: { in: accountIds } } } });
        await db.automationRun.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.automation.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.artifact.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.session.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.team.deleteMany({ where: { id: { in: teamIds } } });
        await db.account.deleteMany({ where: { id: { in: accountIds } } });
        accountIds.length = 0;
        teamIds.length = 0;
    });

    afterAll(async () => { if (connected) await db.$disconnect(); });

    async function fixture() {
        const stem = `workflow-publication-${randomUUID()}`;
        const accounts = await Promise.all(["a", "b", "c", "0-review"].map(suffix => db.account.create({ data: {
            id: `${stem}-${suffix}`, publicKey: `${stem}-${suffix}`, encryptionMode: "plain",
        } })));
        accountIds.push(...accounts.map(account => account.id));
        const team = await db.team.create({ data: { name: stem } });
        teamIds.push(team.id);
        const runAudience = accounts.slice(0, 3);
        await db.teamMembership.createMany({ data: runAudience.map(account => ({ teamId: team.id, accountId: account.id, role: "member" })) });
        const recipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({ v: 2, templateVersion: 1, triggerEvidence: null,
            workflow: { t: "plain", v: { workspace: { directory: "/repo" }, executionTarget: { kind: "session" },
                inlineDefinition: { version: 1, blocks: [{ kind: "action", id: "notice", actionId: "notifications.notify_me",
                    input: { message: { kind: "literal", value: "Run finished" } } }] } } } });
        if (recipe.kind !== "available") throw new Error("Workflow watcher recipe unavailable");
        const watcherMachine = await db.machine.create({ data: { id: randomUUID(), accountId: accounts[2].id, metadata: "{}" } });
        const watcher = await db.automation.create({ data: { accountId: accounts[2].id, name: stem, enabled: true,
            templateCiphertext: recipe.serialized, templateVersion: 1 } });
        await db.automationAssignment.create({ data: { automationId: watcher.id, machineId: watcherMachine.id, enabled: true } });
        // A retained lifecycle origin makes watcher admission publish a Session
        // audience that is outside the shared Workflow's Artifact audience.
        const reviewSession = await db.session.create({ data: { accountId: accounts[2].id, tag: randomUUID(), encryptionMode: "plain", metadata: "{}" } });
        await db.sessionShare.create({ data: { sessionId: reviewSession.id, sharedByUserId: accounts[2].id,
            sharedWithUserId: accounts[3].id, accessLevel: "view" } });
        await db.automationRun.create({ data: { accountId: accounts[2].id, automationId: watcher.id, originKind: "automation",
            state: "succeeded", scheduledAt: new Date(), dueAt: new Date(), finishedAt: new Date(),
            ...encodeAutomationRunCause(AutomationRunCauseSchema.parse({ kind: "trigger", triggerKind: "sessionLifecycle",
                triggerId: randomUUID(), triggerRevision: 0, occurredAt: Date.now(), occurrenceKey: randomUUID(),
                evidence: { event: "parentTurnCompleted", sourceSessionId: reviewSession.id, sourceTurnId: randomUUID(),
                    policy: { kind: "everyMatch" } } })) } });
        const sources = [];
        for (const owner of accounts.slice(0, 2)) {
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: "plain", metadata: "{}" } });
            const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
                header: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: "workflow-definition.v1" }))),
                body: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({}))),
                dataEncryptionKey: new Uint8Array(privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)) } });
            await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id, accessLevel: "view", createdByAccountId: owner.id } });
            const run = await db.automationRun.create({ data: { id: randomUUID(), accountId: owner.id, originKind: "direct", causeKind: null,
                originSessionId: session.id, originDeliveryAckRevision: 0, sourceArtifactId: artifact.id, visibleTeamId: team.id,
                state: "queued", workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "{}",
                scheduledAt: new Date(), dueAt: new Date() } });
            const trigger = await db.automationTrigger.create({ data: { automationId: watcher.id, kind: "runLifecycle", enabled: true,
                sourceRunId: run.id, remainingOccurrences: 1, runLifecycleConfigurationJson: JSON.stringify({ kind: "runLifecycle",
                    source: { kind: "workflow_run", runId: run.id }, condition: "terminal" }) } });
            sources.push({ owner, session, artifact, run, trigger });
        }
        return { accounts, runAudience, watcher, reviewSession, sources };
    }

    it("reciprocal shared Run cancellation commits with current mode fences, origin hints and watcher admission without a physical deadlock", async () => {
        const f = await fixture();
        const owners = f.sources.map(source => source.owner.id);
        const heldOwners = new Set<string>();
        const deadlocks: string[] = [];
        let releaseOwners!: () => void;
        const bothOwnersHeld = new Promise<void>(resolve => { releaseOwners = resolve; });
        const originalTransaction = db.$transaction.bind(db);
        let attempts = 0;
        // This adapter interleaves only real database locks. All admission,
        // mode fencing, publication and lifecycle owners execute unchanged.
        const interleaved = async (operation: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof originalTransaction>[1]) => {
            const attempt = attempts++;
            return originalTransaction(async tx => {
                const locked = new Set<string>();
                const boundary = new Proxy(tx, { get(target, property, receiver) {
                    if (property !== "$queryRawUnsafe") return Reflect.get(target, property, receiver);
                    return async (query: string, ...values: unknown[]) => {
                        try {
                            const result = await target.$queryRawUnsafe(query, ...values);
                            for (const id of accountLockRows(query, result)) locked.add(id);
                            if (attempt < 2 && owners.some(id => locked.has(id)) && !owners.every(id => locked.has(id))) {
                                for (const id of owners) if (locked.has(id)) heldOwners.add(id);
                                if (heldOwners.size === owners.length) releaseOwners();
                                await bothOwnersHeld;
                            }
                            return result;
                        } catch (error) {
                            if (sqlState(error) === "40P01") deadlocks.push("40P01");
                            throw error;
                        }
                    };
                } });
                return operation(boundary);
            }, options);
        };
        // Prisma overloads share this one interactive transport at this boundary.
        db.$transaction = interleaved as typeof db.$transaction;
        restoreTransport = () => { db.$transaction = originalTransaction; };
        const outcomes = await Promise.allSettled(f.sources.map(source => cancelWorkflowRun({
            accountId: source.owner.id, runId: source.run.id, expectedRevision: 0,
        })));
        expect(deadlocks).toEqual([]);
        for (const outcome of outcomes) {
            if (outcome.status === "rejected") throw outcome.reason;
            expect(outcome.value.run.state).toBe("cancelled");
        }
        for (const source of f.sources) {
            expect(await db.accountChange.findMany({ where: { entityId: `workflow-run:${source.run.id}` },
                orderBy: { accountId: "asc" }, select: { accountId: true } })).toEqual(f.runAudience.map(account => ({ accountId: account.id })));
            expect(await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
                accountId: source.owner.id, kind: "session", entityId: source.session.id,
            } }, select: { hint: true } })).toMatchObject({ hint: { kind: "workflow-run-delivery", runId: source.run.id } });
            expect((await db.automationTrigger.findUniqueOrThrow({ where: { id: source.trigger.id } })).remainingOccurrences).toBe(0);
            expect(await db.automationRun.count({ where: { triggerId: source.trigger.id } })).toBe(1);
        }
        expect(await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
            accountId: f.accounts[3].id, kind: "session", entityId: f.reviewSession.id,
        } }, select: { accountId: true } })).toEqual({ accountId: f.accounts[3].id });
    });

    it.each(["existing", "new", "review"] as const)("%s publication waits for the lower Account before acquiring the owner's mode fence", async kind => {
        const f = await fixture();
        const [, owner, watcher] = f.accounts;
        const lower = kind === "review" ? f.accounts[3] : f.accounts[0];
        const source = f.sources[1];
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: "{}" } });
        const runId = randomUUID();
        const currentness = deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({
            where: { id: owner.id }, select: automationAccountCurrentnessSelect,
        }));
        if (!currentness) throw new Error("Plain fixture Account currentness unavailable");
        const acceptedEnvelope = kind === "new" ? serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: "plain", binding: { v: 1, purpose: "accepted_snapshot", accountId: owner.id, runId },
            acceptedSnapshot: await materializeWorkflowAcceptedSnapshotFixture({ definition: { version: 1, inputs: [], defaults: {},
                blocks: [{ kind: "wait", id: "answer", document: { text: "Answer", references: [], attachments: [] }, result: { kind: "text" } }] },
                context: { source: { kind: "inline", sourceArtifactId: source.artifact.id }, inputs: {}, machineId: machine.id,
                    executionTarget: { kind: "session" }, workspaceTarget: { project: { machineId: machine.id, directory: "/repo", checkoutRootPath: "/repo" } },
                    origin: { kind: "direct", originSessionId: source.session.id }, authorization: { principal: { kind: "host" } } } }),
        })) : null;
        let release!: () => void;
        const mayCommit = new Promise<void>(resolve => { release = resolve; });
        let ready!: () => void;
        const holderReady = new Promise<void>(resolve => { ready = resolve; });
        const holder = inTx(async tx => {
            await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE', lower.id);
            ready();
            await mayCommit;
        }, { isolationLevel: "ReadCommitted" });
        const holderOutcome = Promise.allSettled([holder]);
        await holderReady;
        let pid = -1;
        const originalTransaction = db.$transaction.bind(db);
        const observed = async (operation: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof originalTransaction>[1]) =>
            originalTransaction(async tx => {
                const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
                pid = row.pid;
                return operation(tx);
            }, options);
        // Observe the real interactive database boundary without replacing owners.
        db.$transaction = observed as typeof db.$transaction;
        restoreTransport = () => { db.$transaction = originalTransaction; };
        let finished = false;
        const mutation = kind === "new" && acceptedEnvelope !== null
            ? admitWorkflowRun({ accountId: owner.id, runId, machineId: machine.id, accountCurrentness: currentness,
                acceptedEnvelope, sourceArtifactId: source.run.sourceArtifactId, visibleTeamId: source.run.visibleTeamId,
                origin: { kind: "direct", originSessionId: source.session.id } })
            : cancelWorkflowRun({ accountId: owner.id, runId: source.run.id, expectedRevision: 0 });
        const mutationOutcome = Promise.allSettled([mutation]).finally(() => { finished = true; });
        try {
            while (!finished) {
                const [row] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                    "SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS waiting", pid);
                if (row.waiting) break;
            }
            expect(finished).toBe(false);
            restoreTransport();
            await expect(inTx(tx => tx.$queryRawUnsafe<{ id: string }[]>(
                'SELECT "id" FROM "Account" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR UPDATE NOWAIT', [owner.id, watcher.id],
            ), { isolationLevel: "ReadCommitted" })).resolves.toEqual([owner, watcher].map(account => ({ id: account.id })));
        } finally {
            release();
            for (const outcome of [...await holderOutcome, ...await mutationOutcome]) if (outcome.status === "rejected") throw outcome.reason;
        }
    });
});
