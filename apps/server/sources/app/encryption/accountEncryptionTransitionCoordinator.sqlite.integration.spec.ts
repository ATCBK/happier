import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
    signAccountContentKeyBindingV1,
    ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS,
    AutomationRunExecutionInputV1Schema,
    AutomationTriggerIdSchema,
    deriveAutomationOccurrenceKeyV1,
    materializeWorkflowAcceptedSnapshotV1,
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    sealWorkflowCheckpointStoredEnvelopeV1,
    sealWorkflowProgressStoredEnvelopeV1,
    sealPluginCollectionPrivatePayloadV1,
    serializeWorkflowStoredContentEnvelopeV1,
} from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";
import tweetnacl from "tweetnacl";

import { materializePluginCollectionContractsFromManifestTx } from "@/app/plugins/data/collections/contracts";
import { db, initDbSqlite, shutdownDbClient } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import { getActivePrismaRuntime } from "@/storage/prisma";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import {
    verifyAccountContentKeyBinding,
} from "@/app/encryption/accountContentKeyAdmission";

import {
    ACCOUNT_ENCRYPTION_TRANSITION_MEASURED_CAPACITY,
    activateAccountEncryptionTransitionCoordinatorInTx,
    authorizeAccountEncryptionTransitionCoordinatorInTx,
    cancelAccountEncryptionTransitionCoordinatorInTx,
    cleanupExpiredAccountEncryptionTransitionsInTx,
    finalizeAccountEncryptionTransitionCoordinatorInTx,
    inventoryAccountEncryptionTransitionCoordinatorInTx,
    inventoryAccountEncryptionTransitionAutomationsCoordinatorInTx,
    prepareAccountEncryptionTransitionCoordinatorInTx,
    stageAccountEncryptionTransitionAutomationsCoordinatorInTx,
    stageAccountEncryptionTransitionCollectionsCoordinatorInTx,
    ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE,
    admitAccountDataEraseThroughEncryptionTransitionInTx,
} from "./accountEncryptionTransitionCoordinator";
import {
    deriveAccountEncryptionMigrationKeyFingerprints,
} from "./accountEncryptionTransition";

const ACCOUNT_ID = "account-transition-coordinator";
const PLUGIN_ID = "example.transition-coordinator";
const COLLECTION_ID = "tasks";

const MANIFEST = {
    schemaVersion: 2,
    id: PLUGIN_ID,
    version: "1.0.0",
    displayName: "Collection transition coordinator fixture",
    engines: { happier: "^1.0.0" },
    runtime: { apiVersion: 1 },
    contributes: {
        accountCollections: [{
            id: COLLECTION_ID,
            schemaVersion: 1,
            schema: {
                type: "object",
                properties: {
                    id: { type: "string", maxLength: 256 },
                    status: { type: "string", enum: ["open", "closed"] },
                },
                required: ["id", "status"],
                additionalProperties: false,
            },
            serverReadable: ["status"],
            indexes: [],
        }],
    },
} as const;

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("Fixture JSON must be serializable.");
    return JSON.parse(encoded) as Prisma.InputJsonValue;
}

function encryptedAutomationTemplate(ciphertext: string): string {
    return JSON.stringify({
        kind: "happier_automation_template_encrypted_v1",
        payloadCiphertext: ciphertext,
    });
}

/**
 * Truthful retained predecessor execution input for one queued schedule-cause
 * Run: the exact frozen released-V2 arm the admission owner writes for
 * predecessor inventory, so a nonterminal retained Run never satisfies the
 * open-frozen-input CHECK with missing or placeholder bytes.
 */
function retainedScheduleRunExecutionInput(params: Readonly<{
    templateCiphertext: string;
    scheduledFor: Date;
}>): string {
    return JSON.stringify(AutomationRunExecutionInputV1Schema.parse({
        kind: "happier_automation_run_execution_input_v1",
        targetType: "new_session",
        templateVersion: 1,
        templateCiphertext: params.templateCiphertext,
        origin: {
            kind: "scheduled",
            scheduledFor: params.scheduledFor.getTime(),
        },
    }));
}

function plainAutomationTemplate(payload: unknown): string {
    return JSON.stringify({
        kind: "happier_automation_template_plain_v1",
        payload,
    });
}

const WORKFLOW_TRANSITION_RUN_DATA_KEY = new Uint8Array(32).fill(91);

const WORKFLOW_TRANSITION_DEFINITION = {
    version: 1 as const,
    inputs: [],
    defaults: {
        agentTarget: { kind: "agent" as const, identity: { pluginId: "happier.agent.codex", localId: "codex" } },
    },
    blocks: [{
        kind: "step" as const,
        id: "restart-step",
        document: {
            text: "Prove transition restart currentness",
            references: [],
            attachments: [],
        },
        input: [],
        result: { kind: "text" as const },
    }],
};

function workflowSealMode(mode: "plain" | "e2ee") {
    return mode === "plain"
        ? { mode } as const
        : {
            mode,
            runDataKey: WORKFLOW_TRANSITION_RUN_DATA_KEY,
            randomBytes: (length: number) => new Uint8Array(length).fill(37),
        } as const;
}

async function workflowAcceptedSnapshotEnvelope(params: Readonly<{
    accountId: string;
    runId: string;
    mode: "plain" | "e2ee";
}>): Promise<string> {
    const materialized = await materializeWorkflowAcceptedSnapshotV1({
        definition: WORKFLOW_TRANSITION_DEFINITION,
        context: {
            source: { kind: "inline" },
            inputs: {},
            machineId: "workflow-transition-machine",
            executionTarget: { kind: "session" },
            workspaceTarget: {
                project: {
                    machineId: "workflow-transition-machine",
                    directory: "/repo/workflow-transition",
                    checkoutRootPath: "/repo/workflow-transition",
                },
            },
            origin: { kind: "direct" },
            authorization: { principal: { kind: "host" } },
        },
        admission: { kind: "user" },
        // Installed-target availability is the Machine boundary; materialization stays real.
        effects: { resolveTargetAvailability: async () => true },
    });
    if (!materialized.ok) throw new Error(`Workflow fixture admission failed: ${materialized.error.code}`);
    return serializeWorkflowStoredContentEnvelopeV1(
        sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            ...workflowSealMode(params.mode),
            binding: {
                v: 1,
                purpose: "accepted_snapshot",
                accountId: params.accountId,
                runId: params.runId,
            },
            acceptedSnapshot: materialized.snapshot,
        }),
    );
}

function workflowCheckpointEnvelope(params: Readonly<{
    accountId: string;
    runId: string;
    invocationRecordId: string;
    mode: "plain" | "e2ee";
}>): string {
    return serializeWorkflowStoredContentEnvelopeV1(
        sealWorkflowCheckpointStoredEnvelopeV1({
            ...workflowSealMode(params.mode),
            binding: {
                v: 1,
                purpose: "checkpoint",
                accountId: params.accountId,
                runId: params.runId,
            },
            checkpoint: {
                kind: "happier.workflow-checkpoint.v1",
                rootRecordId: params.invocationRecordId,
                nextSequence: "1",
                frontier: { nextBlockOrdinal: 1, paused: false },
            },
        }),
    );
}

function workflowInvocationEnvelope(params: Readonly<{
    accountId: string;
    runId: string;
    invocationRecordId: string;
    mode: "plain" | "e2ee";
}>): string {
    return serializeWorkflowStoredContentEnvelopeV1(
        sealWorkflowProgressStoredEnvelopeV1({
            ...workflowSealMode(params.mode),
            binding: {
                v: 1,
                purpose: "invocation_progress",
                accountId: params.accountId,
                runId: params.runId,
                recordId: params.invocationRecordId,
                sequence: "0",
                parentRecordId: null,
                memberOrdinal: "0",
                attempt: "0",
            },
            progress: {
                kind: "happier.workflow-progress.v1",
                invocationPath: { blockId: "$root", scope: [] },
                blockKind: "root",
                attempt: "0",
                logicalInvocationRecordId: params.invocationRecordId,
            },
        }),
    );
}

describe("Account encryption transition coordinator Collection participant", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-transition-coordinator-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.accountEncryptionTransitionCollectionStage.deleteMany(),
            () => db.accountEncryptionTransition.deleteMany(),
            () => db.pluginCollectionCandidatePreparationStage.deleteMany(),
            () => db.pluginCollectionProjection.deleteMany(),
            () => db.pluginCollectionRelation.deleteMany(),
            () => db.pluginCollectionRow.deleteMany(),
            () => db.pluginCollectionIndexState.deleteMany(),
            () => db.pluginCollectionContract.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createCollectionContract() {
        const [ref] = await inTx(async (tx) => (
            await materializePluginCollectionContractsFromManifestTx({
                tx,
                manifest: MANIFEST,
            })
        ));
        if (!ref) throw new Error("Expected Collection contract.");
        return await db.pluginCollectionContract.findFirstOrThrow({
            where: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                schemaVersion: ref.schemaVersion,
                contractDigest: ref.contractDigest,
            },
        });
    }

    async function declareIsolatedFixtureCapacity(
        transitionId: string,
        capacity?: Readonly<{
            participantLimit: number;
            encodedByteLimit: bigint;
            reservedCapacityBytes: bigint;
        }>,
    ) {
        // This is an isolated test fixture, not a product aggregate policy. It
        // OVERWRITES the measured capacity `prepare` stamps, shrinking it so a
        // small fixture can reach the fence. Tests that must observe the real
        // stamped capacity therefore must not call this.
        await db.accountEncryptionTransition.update({
            where: { id: transitionId },
            data: {
                measuredParticipantLimit: capacity?.participantLimit ?? 1_024,
                measuredEncodedByteLimit:
                    capacity?.encodedByteLimit ?? 16n * 1024n * 1024n,
                reservedCapacityBytes:
                    capacity?.reservedCapacityBytes ?? 32n * 1024n * 1024n,
            },
        });
    }

    async function createStagedE2eeToPlainCollectionTransition(params?: Readonly<{
        now?: Date;
    }>) {
        const binding = createSignedAccountContentBinding();
        await db.account.create({
            data: {
                id: ACCOUNT_ID,
                ...binding,
                encryptionMode: "e2ee",
            },
        });
        const contract = await createCollectionContract();
        const sourceEnvelope = {
            t: "encrypted" as const,
            c: sealPluginCollectionPrivatePayloadV1({
                material: {
                    type: "dataKey" as const,
                    machineKey: new Uint8Array(32).fill(73),
                },
                payload: {},
                randomBytes: (length) => new Uint8Array(length).fill(79),
            }),
        };
        const row = await db.pluginCollectionRow.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "staged-transition-row",
                schemaVersion: contract.schemaVersion,
                revision: 4,
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                contentEnvelope: toPrismaJson(sourceEnvelope),
            },
        });
        await db.pluginCollectionProjection.create({
            data: {
                rowDbId: row.id,
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: row.rowId,
                fieldId: "status",
                typedEncodedValue: JSON.stringify("open"),
                rowRevision: row.revision,
            },
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });
        const prepared = await inTx(async (tx) =>
            await prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                request: {
                    toMode: "plain",
                    expectedAccountVersion: 0,
                    expectedSigningKeyFingerprint:
                        fingerprints.signingKeyFingerprint,
                    expectedContentKeyFingerprint:
                        fingerprints.contentKeyFingerprint,
                },
                ...(params?.now ? { now: params.now } : {}),
            })
        );
        if (prepared.status !== "prepared") {
            throw new Error(`Expected prepared transition, got ${prepared.status}`);
        }
        await declareIsolatedFixtureCapacity(prepared.transition.transitionId);
        await expect(inTx(async (tx) =>
            await authorizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                authorization: { kind: "present_user_confirmation" },
                ...(params?.now ? { now: params.now } : {}),
            })
        )).resolves.toEqual({ status: "authorized" });
        const inventory = await inTx(async (tx) =>
            await inventoryAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                ...(params?.now ? { now: params.now } : {}),
            })
        );
        if (inventory.status !== "ready") {
            throw new Error(`Expected ready transition inventory, got ${inventory.status}`);
        }
        await expect(inTx(async (tx) =>
            await stageAccountEncryptionTransitionCollectionsCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                items: inventory.items.map((item) => ({
                    pluginId: item.pluginId,
                    collectionId: item.collectionId,
                    rowId: item.rowId,
                    expectedRevision: item.revision,
                    sourceEnvelope: item.sourceEnvelope,
                    targetEnvelope: { t: "plain", v: {} },
                    schemaVersion: item.schemaVersion,
                    contractDigest: item.contractDigest,
                })),
                ...(params?.now ? { now: params.now } : {}),
            })
        )).resolves.toMatchObject({
            status: "staged",
            stagedParticipantCount: 1,
        });
        return { row, sourceEnvelope, transitionId: prepared.transition.transitionId };
    }

    it("denies activation and fresh preparation after Disable while allowing erasure cleanup", async () => {
        const staged = await createStagedE2eeToPlainCollectionTransition();
        const owner = await db.account.create({ data: { homeRole: "owner" } });
        await expect(inTx((tx) => setAccountStatusInTx(tx, {
            actorAccountId: owner.id, targetAccountId: ACCOUNT_ID,
            status: "suspended", authority: "home_administration",
        }))).resolves.toMatchObject({ status: "applied" });
        const disabled = await db.account.findUniqueOrThrow({ where: { id: ACCOUNT_ID } });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(disabled);
        await expect(inTx((tx) => prepareAccountEncryptionTransitionCoordinatorInTx({
            tx, accountId: ACCOUNT_ID, request: {
                toMode: "plain", expectedAccountVersion: disabled.seq,
                expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
                expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
            },
        }))).rejects.toMatchObject({ code: "account-disabled" });
        await expect(inTx((tx) => activateAccountEncryptionTransitionCoordinatorInTx({
            tx, accountId: ACCOUNT_ID, transitionId: staged.transitionId,
        }))).rejects.toMatchObject({ code: "account-disabled" });
        expect(await db.account.findUnique({ where: { id: ACCOUNT_ID } })).toEqual(disabled);
        await expect(inTx((tx) => admitAccountDataEraseThroughEncryptionTransitionInTx({ tx, accountId: ACCOUNT_ID })))
            .resolves.toEqual({ status: "ready" });
        expect(await db.accountEncryptionTransitionCollectionStage.count({ where: { transitionId: staged.transitionId } })).toBe(0);
    });

    it("aborts the Account mode flip when the coordinator re-census finds an unstaged live Collection row", async () => {
        await db.account.create({
            data: {
                id: ACCOUNT_ID,
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
        });
        const contract = await createCollectionContract();
        const row = await db.pluginCollectionRow.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "live-row",
                schemaVersion: contract.schemaVersion,
                revision: 1,
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                contentEnvelope: toPrismaJson({
                    t: "encrypted",
                    c: sealPluginCollectionPrivatePayloadV1({
                        material: {
                            type: "dataKey",
                            machineKey: new Uint8Array(32).fill(7),
                        },
                        payload: {},
                        randomBytes: (length) => new Uint8Array(length).fill(3),
                    }),
                }),
            },
        });
        await db.pluginCollectionProjection.create({
            data: {
                rowDbId: row.id,
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: row.rowId,
                fieldId: "status",
                typedEncodedValue: JSON.stringify("open"),
                rowRevision: 1,
            },
        });

        await expect(inTx(async (tx) => (
            await finalizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                fromMode: "e2ee",
                toMode: "plain",
                contentKey: { kind: "preserve" },
                accountChangeHint: { source: "coordinator-test" },
            })
        ))).resolves.toEqual({ status: "collections_migration_incomplete" });

        await expect(db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { encryptionMode: true, seq: true },
        })).resolves.toEqual({ encryptionMode: "e2ee", seq: 0 });
        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: { id: row.id },
            select: { revision: true, contentEnvelope: true },
        })).resolves.toEqual({
            revision: 1,
            contentEnvelope: expect.objectContaining({ t: "encrypted" }),
        });
    });

    it("refuses to activate an Account mode flip around an unstaged live Automation definition", async () => {
        const binding = createSignedAccountContentBinding();
        await db.account.create({
            data: {
                id: ACCOUNT_ID,
                ...binding,
                encryptionMode: "e2ee",
            },
        });
        await db.automation.create({
            data: {
                id: "automation-transition-definition",
                accountId: ACCOUNT_ID,
                name: "Account transition definition participant",
                enabled: false,
                triggers: {
                    create: {
                        kind: "schedule",
                        scheduleKind: "interval",
                        everyMs: 60_000,
                    },
                },
                targetType: "new_session",
                templateCiphertext: encryptedAutomationTemplate(
                    "source-encrypted-template",
                ),
                templateVersion: 1,
            },
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });
        const prepared = await inTx(async (tx) => (
            await prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                request: {
                    toMode: "plain",
                    expectedAccountVersion: 0,
                    expectedSigningKeyFingerprint:
                        fingerprints.signingKeyFingerprint,
                    expectedContentKeyFingerprint:
                        fingerprints.contentKeyFingerprint,
                },
            })
        ));
        expect(prepared.status).toBe("prepared");
        if (prepared.status !== "prepared") {
            throw new Error(`Expected prepared transition, got ${prepared.status}`);
        }
        await declareIsolatedFixtureCapacity(prepared.transition.transitionId);
        await expect(inTx(async (tx) => (
            await authorizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                authorization: { kind: "present_user_confirmation" },
            })
        ))).resolves.toEqual({ status: "authorized" });

        await expect(inTx(async (tx) => (
            await activateAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
            })
        ))).resolves.toEqual({ status: "migration_incomplete" });
        await expect(db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { encryptionMode: true, seq: true },
        })).resolves.toEqual({ encryptionMode: "e2ee", seq: 0 });
    });

    it("atomically applies the exact staged Automation definition before flipping Account mode", async () => {
        const binding = createSignedAccountContentBinding();
        const automationId = "automation-transition-target-definition";
        const sourceTemplate = encryptedAutomationTemplate(
            "source-encrypted-template",
        );
        const targetTemplate = plainAutomationTemplate({
            directory: "/tmp/account-transition",
        });
        await db.account.create({
            data: {
                id: ACCOUNT_ID,
                ...binding,
                encryptionMode: "e2ee",
            },
        });
        await db.automation.create({
            data: {
                id: automationId,
                accountId: ACCOUNT_ID,
                name: "Account transition target definition participant",
                enabled: false,
                triggers: {
                    create: {
                        id: `${automationId}-schedule`,
                        kind: "schedule",
                        scheduleKind: "interval",
                        everyMs: 60_000,
                        nextRunAt: new Date("2026-02-12T10:01:00.000Z"),
                    },
                },
                targetType: "new_session",
                templateCiphertext: sourceTemplate,
                templateVersion: 1,
            },
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });
        const prepared = await inTx(async (tx) => (
            await prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                request: {
                    toMode: "plain",
                    expectedAccountVersion: 0,
                    expectedSigningKeyFingerprint:
                        fingerprints.signingKeyFingerprint,
                    expectedContentKeyFingerprint:
                        fingerprints.contentKeyFingerprint,
                },
            })
        ));
        expect(prepared.status).toBe("prepared");
        if (prepared.status !== "prepared") {
            throw new Error(`Expected prepared transition, got ${prepared.status}`);
        }
        await declareIsolatedFixtureCapacity(prepared.transition.transitionId);
        await expect(inTx(async (tx) => (
            await authorizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                authorization: { kind: "present_user_confirmation" },
            })
        ))).resolves.toEqual({ status: "authorized" });

        const staged = {
            kind: "definition" as const,
            automationId,
            expectedRevision: 1,
            source: {
                templateCiphertext: sourceTemplate,
                triggerDefinitionEnvelopes: [],
            },
            target: {
                templateCiphertext: targetTemplate,
                triggerDefinitionEnvelopes: [],
            },
        };
        await expect(inTx(async (tx) => (
            await stageAccountEncryptionTransitionAutomationsCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                items: [staged],
            })
        ))).resolves.toMatchObject({
            status: "staged",
            stagedParticipantCount: 1,
        });

        await expect(inTx(async (tx) => (
            await activateAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
            })
        ))).resolves.toMatchObject({ status: "activated", mode: "plain" });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automationId },
            select: {
                templateCiphertext: true,
                templateVersion: true,
                triggers: { select: { nextRunAt: true } },
            },
        })).resolves.toEqual({
            templateCiphertext: targetTemplate,
            templateVersion: 2,
            // Re-sealing Account content changes no scheduling semantics, so
            // the retained next-run projection survives the transition.
            triggers: [{ nextRunAt: new Date("2026-02-12T10:01:00.000Z") }],
        });
        await expect(db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { encryptionMode: true, seq: true },
        })).resolves.toEqual({ encryptionMode: "plain", seq: 2 });
    });

    it("resumes a staged Workflow Run and invocation after SQLite reload and rejects its stale pre-restart callback", async () => {
        const binding = createSignedAccountContentBinding();
        const runId = "workflow-transition-restart-run";
        const invocationRecordId = "workflow-transition-restart-root";
        const sourceAcceptedSnapshot = await workflowAcceptedSnapshotEnvelope({
            accountId: ACCOUNT_ID,
            runId,
            mode: "e2ee",
        });
        const sourceCheckpoint = workflowCheckpointEnvelope({
            accountId: ACCOUNT_ID,
            runId,
            invocationRecordId,
            mode: "e2ee",
        });
        const sourceInvocation = workflowInvocationEnvelope({
            accountId: ACCOUNT_ID,
            runId,
            invocationRecordId,
            mode: "e2ee",
        });
        const targetAcceptedSnapshot = await workflowAcceptedSnapshotEnvelope({
            accountId: ACCOUNT_ID,
            runId,
            mode: "plain",
        });
        const targetCheckpoint = workflowCheckpointEnvelope({
            accountId: ACCOUNT_ID,
            runId,
            invocationRecordId,
            mode: "plain",
        });
        const targetInvocation = workflowInvocationEnvelope({
            accountId: ACCOUNT_ID,
            runId,
            invocationRecordId,
            mode: "plain",
        });

        await db.account.create({
            data: { id: ACCOUNT_ID, ...binding, encryptionMode: "e2ee" },
        });
        await db.automationRun.create({
            data: {
                id: runId,
                accountId: ACCOUNT_ID,
                automationId: null,
                originKind: "direct",
                causeKind: null,
                state: "running",
                executionInputEnvelope: sourceAcceptedSnapshot,
                workflowAcceptedSnapshotEnvelope: sourceAcceptedSnapshot,
                workflowCheckpointEnvelope: sourceCheckpoint,
                workflowCustodyState: "pending",
                scheduledAt: new Date("2026-09-12T09:00:00.000Z"),
                dueAt: new Date("2026-09-12T09:00:00.000Z"),
                workflowInvocations: {
                    create: {
                        id: invocationRecordId,
                        sequence: 0n,
                        parentRecordId: null,
                        memberOrdinal: 0n,
                        attempt: 0n,
                        lifecycle: "running",
                        contentEnvelope: sourceInvocation,
                    },
                },
            },
        });

        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });
        const prepared = await inTx(async (tx) => (
            await prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                request: {
                    toMode: "plain",
                    expectedAccountVersion: 0,
                    expectedSigningKeyFingerprint:
                        fingerprints.signingKeyFingerprint,
                    expectedContentKeyFingerprint:
                        fingerprints.contentKeyFingerprint,
                },
            })
        ));
        if (prepared.status !== "prepared") {
            throw new Error(`Expected prepared transition, got ${prepared.status}`);
        }
        await declareIsolatedFixtureCapacity(prepared.transition.transitionId);
        await expect(inTx(async (tx) => (
            await authorizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                authorization: { kind: "present_user_confirmation" },
            })
        ))).resolves.toEqual({ status: "authorized" });

        await expect(inTx(async (tx) => (
            await inventoryAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
            })
        ))).resolves.toEqual({ status: "ready", items: [] });
        const inventory = await inTx(async (tx) => (
            await inventoryAccountEncryptionTransitionAutomationsCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
            })
        ));
        if (inventory.status !== "ready") {
            throw new Error(`Expected Workflow transition inventory, got ${inventory.status}`);
        }
        expect(inventory.items.map((item) => item.kind)).toEqual([
            "run",
            "workflow_invocation",
        ]);
        const stageItems = inventory.items.map((item) => {
            if (item.kind === "workflow_invocation") {
                return {
                    kind: item.kind,
                    runId: item.runId,
                    invocationRecordId: item.invocationRecordId,
                    source: item.source,
                    target: { contentEnvelope: targetInvocation },
                } as const;
            }
            if (item.kind !== "run" || item.origin.kind !== "direct") {
                throw new Error("Expected one direct Workflow Run participant");
            }
            return {
                kind: item.kind,
                runId: item.runId,
                origin: item.origin,
                expectedRevision: item.revision,
                source: item.source,
                target: {
                    triggerEvidenceEnvelope: null,
                    occurrenceEvidenceEqualityTag: null,
                    executionInputEnvelope: targetAcceptedSnapshot,
                    workflowAcceptedSnapshotEnvelope: targetAcceptedSnapshot,
                    workflowCheckpointEnvelope: targetCheckpoint,
                    resultEnvelope: null,
                    replyContextEnvelope: null,
                    failureDetailEnvelope: null,
                    summaryCiphertext: null,
                },
            } as const;
        });
        await expect(inTx(async (tx) => (
            await stageAccountEncryptionTransitionAutomationsCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                items: stageItems,
            })
        ))).resolves.toMatchObject({
            status: "staged",
            stagedParticipantCount: 2,
        });
        await expect(db.accountEncryptionTransitionAutomationStage.findMany({
            where: { transitionId: prepared.transition.transitionId },
            orderBy: [{ participantKind: "asc" }, { participantId: "asc" }],
            select: { participantKind: true, participantId: true, targetContent: true },
        })).resolves.toEqual([
            {
                participantKind: "run",
                participantId: runId,
                targetContent: expect.any(String),
            },
            {
                participantKind: "workflow_invocation",
                participantId: invocationRecordId,
                targetContent: expect.any(String),
            },
        ]);

        // Model a server process replacement: release the active Prisma client,
        // then initialize a fresh client against this test-owned SQLite file.
        await shutdownDbClient();
        await initDbSqlite();
        await db.$connect();

        await expect(inTx(async (tx) => (
            await activateAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
            })
        ))).resolves.toMatchObject({ status: "activated", mode: "plain" });
        const currentRun = await db.automationRun.findUniqueOrThrow({
            where: { id: runId },
            select: {
                revision: true,
                executionInputEnvelope: true,
                workflowAcceptedSnapshotEnvelope: true,
                workflowCheckpointEnvelope: true,
            },
        });
        expect(currentRun).toEqual({
            revision: 1,
            executionInputEnvelope: targetAcceptedSnapshot,
            workflowAcceptedSnapshotEnvelope: targetAcceptedSnapshot,
            workflowCheckpointEnvelope: targetCheckpoint,
        });
        const currentInvocation = await db.workflowRunInvocation.findUniqueOrThrow({
            where: { id: invocationRecordId },
            select: {
                runId: true,
                sequence: true,
                parentRecordId: true,
                memberOrdinal: true,
                attempt: true,
                lifecycle: true,
                contentEnvelope: true,
            },
        });
        expect(currentInvocation).toEqual({
            runId,
            sequence: 0n,
            parentRecordId: null,
            memberOrdinal: 0n,
            attempt: 0n,
            lifecycle: "running",
            contentEnvelope: targetInvocation,
        });
        await expect(db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { encryptionMode: true, seq: true },
        })).resolves.toEqual({ encryptionMode: "plain", seq: 1 });

        await expect(inTx(async (tx) => (
            await stageAccountEncryptionTransitionAutomationsCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                items: stageItems,
            })
        ))).resolves.toEqual({ status: "transition_not_ready" });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: runId },
            select: {
                revision: true,
                executionInputEnvelope: true,
                workflowAcceptedSnapshotEnvelope: true,
                workflowCheckpointEnvelope: true,
            },
        })).resolves.toEqual(currentRun);
        await expect(db.workflowRunInvocation.findUniqueOrThrow({
            where: { id: invocationRecordId },
            select: {
                runId: true,
                sequence: true,
                parentRecordId: true,
                memberOrdinal: true,
                attempt: true,
                lifecycle: true,
                contentEnvelope: true,
            },
        })).resolves.toEqual(currentInvocation);
    });

    it("rejects 10,001 retained Automation Runs before persisting an Account transition source stage", async () => {
        const binding = createSignedAccountContentBinding();
        const automationId = "automation-transition-run-limit";
        await db.account.create({
            data: {
                id: ACCOUNT_ID,
                ...binding,
                encryptionMode: "e2ee",
            },
        });
        const automation = await db.automation.create({
            data: {
                id: automationId,
                accountId: ACCOUNT_ID,
                name: "Account transition retained Run limit",
                enabled: false,
                triggers: {
                    create: {
                        id: `${automationId}-schedule`,
                        kind: "schedule",
                        scheduleKind: "interval",
                        everyMs: 60_000,
                    },
                },
                targetType: "new_session",
                templateCiphertext: encryptedAutomationTemplate(
                    "run-limit-source-template",
                ),
                templateVersion: 1,
            },
            select: { triggers: { select: { id: true, revision: true } } },
        });
        const scheduleTrigger = automation.triggers[0]!;
        const legacySummary = "retained-run-source-summary";
        await db.automationRun.createMany({
            data: Array.from({ length: 10_001 }, (_, index) => ({
                id: `automation-transition-run-limit-${index}`,
                accountId: ACCOUNT_ID,
                automationId,
                state: "queued" as const,
                triggerId: scheduleTrigger.id,
                causeKind: "trigger" as const,
                causeTriggerKind: "schedule" as const,
                causeTriggerRevision: scheduleTrigger.revision,
                causeOccurredAt: new Date(1_700_000_000_000 + index),
                causeScheduledFor: new Date(1_700_000_000_000 + index),
                occurrenceKey: deriveAutomationOccurrenceKeyV1({
                    triggerId: AutomationTriggerIdSchema.parse(scheduleTrigger.id),
                    evidence: { v: 1, kind: "schedule", scheduledFor: 1_700_000_000_000 + index },
                }),
                executionInputEnvelope: retainedScheduleRunExecutionInput({
                    templateCiphertext: encryptedAutomationTemplate(
                        "run-limit-source-template",
                    ),
                    scheduledFor: new Date(1_700_000_000_000 + index),
                }),
                resultEnvelope: JSON.stringify({
                    t: "legacySummaryCiphertext",
                    c: legacySummary,
                }),
                summaryCiphertext: legacySummary,
                scheduledAt: new Date(1_700_000_000_000 + index),
                dueAt: new Date(1_700_000_000_000 + index),
            })),
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });
        const prepared = await inTx(async (tx) => (
            await prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                request: {
                    toMode: "plain",
                    expectedAccountVersion: 0,
                    expectedSigningKeyFingerprint:
                        fingerprints.signingKeyFingerprint,
                    expectedContentKeyFingerprint:
                        fingerprints.contentKeyFingerprint,
                },
            })
        ));
        expect(prepared.status).toBe("prepared");
        if (prepared.status !== "prepared") {
            throw new Error(`Expected prepared transition, got ${prepared.status}`);
        }
        await declareIsolatedFixtureCapacity(prepared.transition.transitionId, {
            participantLimit: 20_000,
            encodedByteLimit: 64n * 1024n * 1024n,
            reservedCapacityBytes: 128n * 1024n * 1024n,
        });
        await expect(inTx(async (tx) => (
            await authorizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                authorization: { kind: "present_user_confirmation" },
            })
        ))).resolves.toEqual({ status: "migration_too_large" });
        await expect(db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { encryptionMode: true, seq: true },
        })).resolves.toEqual({ encryptionMode: "e2ee", seq: 0 });
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: prepared.transition.transitionId },
            select: { status: true },
        })).resolves.toEqual({ status: "cancelled" });
        const prisma = getActivePrismaRuntime();
        const staged = await db.$queryRaw<readonly { count: bigint | number }[]>(
            prisma.sql`
                SELECT COUNT(*) AS "count"
                FROM "AccountEncryptionTransitionAutomationStage"
                WHERE "transitionId" = ${prepared.transition.transitionId}
            `,
        );
        expect(staged).toHaveLength(1);
        expect(Number(staged[0]?.count)).toBe(0);
    });

    it("pins the measured PEP1 Run ceiling on the capacity the coordinator itself writes", async () => {
        const binding = createSignedAccountContentBinding();
        const automationId = "automation-transition-measured-ceiling";
        await db.account.create({
            data: { id: ACCOUNT_ID, ...binding, encryptionMode: "e2ee" },
        });
        const automation = await db.automation.create({
            data: {
                id: automationId,
                accountId: ACCOUNT_ID,
                name: "Account transition measured ceiling",
                enabled: false,
                triggers: {
                    create: {
                        id: `${automationId}-schedule`,
                        kind: "schedule",
                        scheduleKind: "interval",
                        everyMs: 60_000,
                    },
                },
                targetType: "new_session",
                templateCiphertext: encryptedAutomationTemplate(
                    "measured-ceiling-source-template",
                ),
                templateVersion: 1,
            },
            select: { triggers: { select: { id: true, revision: true } } },
        });
        const scheduleTrigger = automation.triggers[0]!;
        const legacySummary = "measured-ceiling-source-summary";
        await db.automationRun.createMany({
            data: Array.from({ length: 10_001 }, (_, index) => ({
                id: `automation-transition-measured-ceiling-${index}`,
                accountId: ACCOUNT_ID,
                automationId,
                state: "queued" as const,
                triggerId: scheduleTrigger.id,
                causeKind: "trigger" as const,
                causeTriggerKind: "schedule" as const,
                causeTriggerRevision: scheduleTrigger.revision,
                causeOccurredAt: new Date(1_700_000_000_000 + index),
                causeScheduledFor: new Date(1_700_000_000_000 + index),
                occurrenceKey: deriveAutomationOccurrenceKeyV1({
                    triggerId: AutomationTriggerIdSchema.parse(scheduleTrigger.id),
                    evidence: { v: 1, kind: "schedule", scheduledFor: 1_700_000_000_000 + index },
                }),
                executionInputEnvelope: retainedScheduleRunExecutionInput({
                    templateCiphertext: encryptedAutomationTemplate(
                        "measured-ceiling-source-template",
                    ),
                    scheduledFor: new Date(1_700_000_000_000 + index),
                }),
                resultEnvelope: JSON.stringify({
                    t: "legacySummaryCiphertext",
                    c: legacySummary,
                }),
                summaryCiphertext: legacySummary,
                scheduledAt: new Date(1_700_000_000_000 + index),
                dueAt: new Date(1_700_000_000_000 + index),
            })),
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });
        const prepareTransition = async () => {
            const prepared = await inTx(async (tx) => (
                await prepareAccountEncryptionTransitionCoordinatorInTx({
                    tx,
                    accountId: ACCOUNT_ID,
                    request: {
                        toMode: "plain",
                        expectedAccountVersion: 0,
                        expectedSigningKeyFingerprint:
                            fingerprints.signingKeyFingerprint,
                        expectedContentKeyFingerprint:
                            fingerprints.contentKeyFingerprint,
                    },
                })
            ));
            if (prepared.status !== "prepared") {
                throw new Error(`Expected prepared transition, got ${prepared.status}`);
            }
            return prepared.transition.transitionId;
        };
        const authorize = async (transitionId: string) => await inTx(async (tx) => (
            await authorizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId,
                authorization: { kind: "present_user_confirmation" },
            })
        ));

        // No isolated fixture capacity anywhere in this test: the only measured
        // bounds in play are the ones prepare stamps on the transition.
        const refusedTransitionId = await prepareTransition();
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: refusedTransitionId },
            select: {
                measuredParticipantLimit: true,
                measuredEncodedByteLimit: true,
                reservedCapacityBytes: true,
            },
        })).resolves.toEqual({
            measuredParticipantLimit:
                ACCOUNT_ENCRYPTION_TRANSITION_MEASURED_CAPACITY.participantLimit,
            measuredEncodedByteLimit:
                ACCOUNT_ENCRYPTION_TRANSITION_MEASURED_CAPACITY.encodedByteLimit,
            reservedCapacityBytes:
                ACCOUNT_ENCRYPTION_TRANSITION_MEASURED_CAPACITY.reservedCapacityBytes,
        });
        await expect(authorize(refusedTransitionId))
            .resolves.toEqual({ status: "migration_too_large" });
        const prisma = getActivePrismaRuntime();
        const stagedAfterRefusal = await db.$queryRaw<
            readonly { count: bigint | number }[]
        >(prisma.sql`
            SELECT COUNT(*) AS "count"
            FROM "AccountEncryptionTransitionAutomationStage"
            WHERE "transitionId" = ${refusedTransitionId}
        `);
        expect(Number(stagedAfterRefusal[0]?.count)).toBe(0);
        await expect(db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { encryptionMode: true },
        })).resolves.toEqual({ encryptionMode: "e2ee" });

        // Exactly one Run below the approved ceiling, same content shape, same
        // written capacity: the census is now authorized and retained.
        await db.automationRun.delete({
            where: { id: "automation-transition-measured-ceiling-10000" },
        });
        const authorizedTransitionId = await prepareTransition();
        await expect(authorize(authorizedTransitionId))
            .resolves.toEqual({ status: "authorized" });
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: authorizedTransitionId },
            select: { status: true, censusParticipantCount: true },
        })).resolves.toEqual({
            status: "authorized",
            censusParticipantCount: 10_001,
        });
        const stagedAfterAuthorization = await db.$queryRaw<
            readonly { count: bigint | number }[]
        >(prisma.sql`
            SELECT COUNT(*) AS "count"
            FROM "AccountEncryptionTransitionAutomationStage"
            WHERE "transitionId" = ${authorizedTransitionId}
        `);
        expect(Number(stagedAfterAuthorization[0]?.count)).toBe(10_001);
    }, 300_000);

    it("allows a content-free historical Collection tombstone without changing its identity, revision, or deletion time", async () => {
        await db.account.create({
            data: {
                id: ACCOUNT_ID,
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
        });
        const contract = await createCollectionContract();
        const deletedAt = new Date("2026-08-12T12:00:00.000Z");
        const tombstone = await db.pluginCollectionRow.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "historical-row",
                schemaVersion: contract.schemaVersion,
                revision: 9,
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                contentEnvelope: getActivePrismaRuntime().JsonNull,
                deletedAt,
            },
        });

        await expect(inTx(async (tx) => (
            await finalizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                fromMode: "e2ee",
                toMode: "plain",
                contentKey: { kind: "preserve" },
                accountChangeHint: { source: "coordinator-test" },
            })
        ))).resolves.toMatchObject({
            status: "applied",
            mode: "plain",
        });

        await expect(db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { encryptionMode: true, seq: true },
        })).resolves.toEqual({ encryptionMode: "plain", seq: 1 });
        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: { id: tombstone.id },
            select: { id: true, revision: true, deletedAt: true, contentEnvelope: true },
        })).resolves.toEqual({
            id: tombstone.id,
            revision: 9,
            deletedAt,
            contentEnvelope: null,
        });
    });

    it("does not inspect an E2EE Collection source before present-user confirmation", async () => {
        const binding = createSignedAccountContentBinding();
        await db.account.create({
            data: { id: ACCOUNT_ID, ...binding, encryptionMode: "e2ee" },
        });
        const contract = await createCollectionContract();
        const row = await db.pluginCollectionRow.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "wrong-mode-before-confirmation",
                schemaVersion: contract.schemaVersion,
                revision: 1,
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                // This malformed-for-E2EE source is deliberately a probe: a
                // prepare may bind only Account facts, not inspect any live
                // Collection payload before the present-user confirmation.
                contentEnvelope: { t: "plain", v: {} },
            },
        });
        await db.pluginCollectionProjection.create({
            data: {
                rowDbId: row.id,
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: row.rowId,
                fieldId: "status",
                typedEncodedValue: JSON.stringify("open"),
                rowRevision: row.revision,
            },
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });

        const prepared = await inTx(async (tx) => (
            await prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                request: {
                    toMode: "plain",
                    expectedAccountVersion: 0,
                    expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
                    expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
                },
            })
        ));
        expect(prepared.status).toBe("prepared");
        if (prepared.status !== "prepared") {
            throw new Error(`Expected prepared transition, got ${prepared.status}`);
        }
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId: prepared.transition.transitionId },
        })).resolves.toBe(0);
        await expect(inTx(async (tx) => (
            await authorizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                authorization: { kind: "present_user_confirmation" },
            })
        ))).resolves.toEqual({ status: "invalid_content" });
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId: prepared.transition.transitionId },
        })).resolves.toBe(0);
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: prepared.transition.transitionId },
            select: { status: true, activeAccountId: true },
        })).resolves.toEqual({ status: "cancelled", activeAccountId: null });
    });

    it("stages the complete exact live Collection census, then atomically advances the row and Account mode", async () => {
        const binding = createSignedAccountContentBinding();
        await db.account.create({
            data: {
                id: ACCOUNT_ID,
                ...binding,
                encryptionMode: "e2ee",
            },
        });
        const contract = await createCollectionContract();
        const sourceEnvelope = {
            t: "encrypted" as const,
            c: sealPluginCollectionPrivatePayloadV1({
                material: {
                    type: "dataKey" as const,
                    machineKey: new Uint8Array(32).fill(17),
                },
                payload: {},
                randomBytes: (length) => new Uint8Array(length).fill(19),
            }),
        };
        const row = await db.pluginCollectionRow.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "staged-live-row",
                schemaVersion: contract.schemaVersion,
                revision: 4,
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                contentEnvelope: toPrismaJson(sourceEnvelope),
            },
        });
        await db.pluginCollectionProjection.create({
            data: {
                rowDbId: row.id,
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: row.rowId,
                fieldId: "status",
                typedEncodedValue: JSON.stringify("open"),
                rowRevision: row.revision,
            },
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });

        const prepared = await inTx(async (tx) => (
            await prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                request: {
                    toMode: "plain",
                    expectedAccountVersion: 0,
                    expectedSigningKeyFingerprint:
                        fingerprints.signingKeyFingerprint,
                    expectedContentKeyFingerprint:
                        fingerprints.contentKeyFingerprint,
                },
            })
        ));
        expect(prepared.status).toBe("prepared");
        if (prepared.status !== "prepared") {
            throw new Error(`Expected prepared transition, got ${prepared.status}`);
        }
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId: prepared.transition.transitionId },
        })).resolves.toBe(0);
        await declareIsolatedFixtureCapacity(prepared.transition.transitionId);

        await expect(inTx(async (tx) => (
            await authorizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                authorization: { kind: "present_user_confirmation" },
            })
        ))).resolves.toMatchObject({ status: "authorized" });
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId: prepared.transition.transitionId },
        })).resolves.toBe(1);

        const inventory = await inTx(async (tx) => (
            await inventoryAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
            })
        ));
        expect(inventory.status).toBe("ready");
        if (inventory.status !== "ready") {
            throw new Error(`Expected transition inventory, got ${inventory.status}`);
        }
        expect(inventory.items).toEqual([{
            pluginId: PLUGIN_ID,
            collectionId: COLLECTION_ID,
            rowId: row.rowId,
            revision: row.revision,
            sourceEnvelope,
            schemaVersion: contract.schemaVersion,
            contractDigest: contract.contractDigest,
        }]);

        await expect(inTx(async (tx) => (
            await stageAccountEncryptionTransitionCollectionsCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                items: inventory.items.map((item) => ({
                    pluginId: item.pluginId,
                    collectionId: item.collectionId,
                    rowId: item.rowId,
                    expectedRevision: item.revision,
                    sourceEnvelope: item.sourceEnvelope,
                    targetEnvelope: { t: "plain", v: {} },
                    schemaVersion: item.schemaVersion,
                    contractDigest: item.contractDigest,
                })),
            })
        ))).resolves.toMatchObject({ status: "staged", stagedParticipantCount: 1 });
        await db.pluginCollectionCandidatePreparationStage.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: row.rowId,
                candidateIdentity: "c".repeat(43),
                sourceRowDbId: row.id,
                sourceContractId: contract.id,
                sourceSchemaVersion: contract.schemaVersion,
                sourceContractDigest: contract.contractDigest,
                sourceRevision: row.revision,
                targetContractId: contract.id,
                targetSchemaVersion: contract.schemaVersion,
                targetContractDigest: contract.contractDigest,
                candidateReleaseVersion: "2.0.0",
                candidateArtifactDigest: `sha256:${"c".repeat(64)}`,
                targetContentEnvelope: toPrismaJson(sourceEnvelope),
                targetProjection: toPrismaJson({ status: "open" }),
            },
        });

        const activation = await inTx(async (tx) => (
            await activateAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
            })
        ));
        expect(activation).toMatchObject({ status: "activated", mode: "plain", cursor: 2, version: 2 });

        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: { id: row.id },
            select: { revision: true, contentEnvelope: true },
        })).resolves.toEqual({
            revision: 5,
            contentEnvelope: { t: "plain", v: {} },
        });
        await expect(db.pluginCollectionProjection.findFirstOrThrow({
            where: { rowDbId: row.id },
            select: { rowRevision: true },
        })).resolves.toEqual({ rowRevision: 5 });
        await expect(db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { encryptionMode: true, seq: true },
        })).resolves.toEqual({ encryptionMode: "plain", seq: 2 });
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: prepared.transition.transitionId },
            select: { status: true, activeAccountId: true, activatedAccountCursor: true, activatedAccountVersion: true },
        })).resolves.toEqual({ status: "activated", activeAccountId: null, activatedAccountCursor: 2, activatedAccountVersion: 2 });
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId: prepared.transition.transitionId },
        })).resolves.toBe(0);
        await expect(db.pluginCollectionCandidatePreparationStage.count({
            where: { accountId: ACCOUNT_ID },
        })).resolves.toBe(0);
        await expect(inTx(async (tx) => (
            await activateAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
            })
        ))).resolves.toEqual(activation);
    });

    it("cancels only the bounded staged target and leaves the source Account and Collection row authoritative", async () => {
        const staged = await createStagedE2eeToPlainCollectionTransition();

        await expect(inTx(async (tx) =>
            await cancelAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: staged.transitionId,
            })
        )).resolves.toEqual({ status: "cancelled" });

        await expect(db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { encryptionMode: true, seq: true },
        })).resolves.toEqual({ encryptionMode: "e2ee", seq: 0 });
        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: { id: staged.row.id },
            select: { revision: true, contentEnvelope: true },
        })).resolves.toEqual({
            revision: 4,
            contentEnvelope: staged.sourceEnvelope,
        });
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: staged.transitionId },
            select: { status: true, activeAccountId: true },
        })).resolves.toEqual({ status: "cancelled", activeAccountId: null });
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId: staged.transitionId },
        })).resolves.toBe(0);
    });

    it("rejoins identical prepare, authorization, and cancellation retries without extra transition writes", async () => {
        const binding = createSignedAccountContentBinding();
        const preparedAt = new Date("2026-08-12T12:00:00.000Z");
        const authorizedAt = new Date("2026-08-12T12:01:00.000Z");
        const retryAt = new Date("2026-08-12T12:02:00.000Z");
        const cancelledAt = new Date("2026-08-12T12:03:00.000Z");
        await db.account.create({
            data: { id: ACCOUNT_ID, ...binding, encryptionMode: "e2ee" },
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });
        const request = {
            toMode: "plain" as const,
            expectedAccountVersion: 0,
            expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
            expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
        };

        const firstPrepare = await inTx(async (tx) => (
            await prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                request,
                now: preparedAt,
            })
        ));
        expect(firstPrepare.status).toBe("prepared");
        if (firstPrepare.status !== "prepared") {
            throw new Error(`Expected prepared transition, got ${firstPrepare.status}`);
        }
        await expect(inTx(async (tx) => (
            await prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                request,
                now: retryAt,
            })
        ))).resolves.toEqual(firstPrepare);

        await expect(inTx(async (tx) => (
            await authorizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: firstPrepare.transition.transitionId,
                authorization: { kind: "present_user_confirmation" },
                now: authorizedAt,
            })
        ))).resolves.toEqual({ status: "authorized" });
        const afterFirstAuthorization = await db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: firstPrepare.transition.transitionId },
            select: { status: true, authorizedAt: true, updatedAt: true },
        });
        await expect(inTx(async (tx) => (
            await authorizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: firstPrepare.transition.transitionId,
                authorization: { kind: "present_user_confirmation" },
                now: retryAt,
            })
        ))).resolves.toEqual({ status: "authorized" });
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: firstPrepare.transition.transitionId },
            select: { status: true, authorizedAt: true, updatedAt: true },
        })).resolves.toEqual(afterFirstAuthorization);

        await expect(inTx(async (tx) => (
            await cancelAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: firstPrepare.transition.transitionId,
                now: cancelledAt,
            })
        ))).resolves.toEqual({ status: "cancelled" });
        const afterFirstCancellation = await db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: firstPrepare.transition.transitionId },
            select: { status: true, activeAccountId: true, updatedAt: true },
        });
        await expect(inTx(async (tx) => (
            await cancelAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: firstPrepare.transition.transitionId,
                now: new Date("2026-08-12T12:04:00.000Z"),
            })
        ))).resolves.toEqual({ status: "cancelled" });
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: firstPrepare.transition.transitionId },
            select: { status: true, activeAccountId: true, updatedAt: true },
        })).resolves.toEqual(afterFirstCancellation);
        await expect(db.accountChange.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(0);
    });

    it("does not rejoin an expired active prepare after bounded cleanup made progress on another account", async () => {
        const binding = createSignedAccountContentBinding();
        const startedAt = new Date("2026-08-12T12:00:00.000Z");
        const retryAt = new Date(
            startedAt.getTime()
            + ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.lifetimeMs
            + 1,
        );
        const earlierAccountId = randomUUID();
        const earlierTransitionId = randomUUID();
        await db.account.createMany({
            data: [
                { id: ACCOUNT_ID, ...binding, encryptionMode: "e2ee" },
                { id: earlierAccountId, encryptionMode: "e2ee" },
            ],
        });
        // The first bounded cleanup pass must consume this older expiry. The
        // retry must still recognize and retire its own expired active record
        // rather than returning it as a valid prepared replay.
        await db.accountEncryptionTransition.create({
            data: {
                id: earlierTransitionId,
                accountId: earlierAccountId,
                fromEncryptionMode: "e2ee",
                toEncryptionMode: "plain",
                sourceAccountVersion: 0,
                sourceSettingsVersion: 0,
                status: "preparing",
                activeAccountId: earlierAccountId,
                preparedAt: startedAt,
                expiresAt: new Date(
                    startedAt.getTime()
                    + ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.lifetimeMs
                    - 1,
                ),
            },
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });
        const request = {
            toMode: "plain" as const,
            expectedAccountVersion: 0,
            expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
            expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
        };
        const firstPrepare = await inTx(async (tx) => (
            await prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                request,
                now: startedAt,
            })
        ));
        expect(firstPrepare.status).toBe("prepared");
        if (firstPrepare.status !== "prepared") {
            throw new Error(`Expected prepared transition, got ${firstPrepare.status}`);
        }

        const retriedPrepare = await inTx(async (tx) => (
            await prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                request,
                now: retryAt,
            })
        ));
        expect(retriedPrepare).toMatchObject({ status: "prepared" });
        if (retriedPrepare.status !== "prepared") {
            throw new Error(`Expected prepared transition, got ${retriedPrepare.status}`);
        }
        expect(retriedPrepare.transition.transitionId).not.toBe(
            firstPrepare.transition.transitionId,
        );
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: firstPrepare.transition.transitionId },
            select: { status: true, activeAccountId: true },
        })).resolves.toEqual({ status: "expired", activeAccountId: null });
    });

    it("rejects a source revision that moved after staging, clears its target, and performs no mode flip", async () => {
        const staged = await createStagedE2eeToPlainCollectionTransition();
        await db.pluginCollectionRow.update({
            where: { id: staged.row.id },
            data: { revision: 5 },
        });
        // A concurrent Collection writer advances its dependent projection
        // witness with the row. Keep this fixture structurally valid so this
        // exercises transition currentness rather than malformed storage.
        await db.pluginCollectionProjection.updateMany({
            where: { rowDbId: staged.row.id },
            data: { rowRevision: 5 },
        });

        await expect(inTx(async (tx) =>
            await activateAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: staged.transitionId,
            })
        )).resolves.toEqual({ status: "migration_incomplete" });

        await expect(db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { encryptionMode: true, seq: true },
        })).resolves.toEqual({ encryptionMode: "e2ee", seq: 0 });
        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: { id: staged.row.id },
            select: { revision: true, contentEnvelope: true },
        })).resolves.toEqual({
            revision: 5,
            contentEnvelope: staged.sourceEnvelope,
        });
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: staged.transitionId },
            select: { status: true, activeAccountId: true },
        })).resolves.toEqual({ status: "cancelled", activeAccountId: null });
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId: staged.transitionId },
        })).resolves.toBe(0);
    });

    it("expires a staged transition at the Account-owned lifetime and removes its target without changing source bytes", async () => {
        const startedAt = new Date("2026-08-12T10:00:00.000Z");
        const staged = await createStagedE2eeToPlainCollectionTransition({
            now: startedAt,
        });
        const expiredAt = new Date(
            startedAt.getTime()
            + ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.lifetimeMs,
        );

        await expect(inTx(async (tx) =>
            await cancelAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: staged.transitionId,
                now: expiredAt,
            })
        )).resolves.toEqual({ status: "transition_expired" });

        await expect(db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { encryptionMode: true, seq: true },
        })).resolves.toEqual({ encryptionMode: "e2ee", seq: 0 });
        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: { id: staged.row.id },
            select: { revision: true, contentEnvelope: true },
        })).resolves.toEqual({
            revision: 4,
            contentEnvelope: staged.sourceEnvelope,
        });
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: staged.transitionId },
            select: { status: true, activeAccountId: true },
        })).resolves.toEqual({ status: "expired", activeAccountId: null });
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId: staged.transitionId },
        })).resolves.toBe(0);
    });

    it("scrubs one complete bounded expired transition before marking a later transition terminal", async () => {
        const firstAccountId = randomUUID();
        const secondAccountId = randomUUID();
        const firstTransitionId = randomUUID();
        const secondTransitionId = randomUUID();
        const firstExpiresAt = new Date("2026-08-12T10:00:00.000Z");
        const secondExpiresAt = new Date("2026-08-12T10:00:01.000Z");
        const now = new Date("2026-08-12T10:01:00.000Z");
        const stageCount =
            ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.cleanupBatchSize;

        await db.account.createMany({
            data: [
                { id: firstAccountId, encryptionMode: "plain" },
                { id: secondAccountId, encryptionMode: "plain" },
            ],
        });
        await db.accountEncryptionTransition.createMany({
            data: [
                {
                    id: firstTransitionId,
                    accountId: firstAccountId,
                    fromEncryptionMode: "plain",
                    toEncryptionMode: "e2ee",
                    sourceAccountVersion: 0,
                    sourceSettingsVersion: 0,
                    status: "preparing",
                    activeAccountId: firstAccountId,
                    preparedAt: firstExpiresAt,
                    expiresAt: firstExpiresAt,
                },
                {
                    id: secondTransitionId,
                    accountId: secondAccountId,
                    fromEncryptionMode: "plain",
                    toEncryptionMode: "e2ee",
                    sourceAccountVersion: 0,
                    sourceSettingsVersion: 0,
                    status: "preparing",
                    activeAccountId: secondAccountId,
                    preparedAt: secondExpiresAt,
                    expiresAt: secondExpiresAt,
                },
            ],
        });
        await db.accountEncryptionTransitionCollectionStage.createMany({
            data: [firstTransitionId, secondTransitionId].flatMap((transitionId) => (
                Array.from({ length: stageCount }, (_, index) => ({
                    transitionId,
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    rowId: `${transitionId}-row-${index}`,
                    sourceRevision: 1,
                    sourceEnvelope: toPrismaJson({ t: "plain", v: {} }),
                    targetEnvelope: toPrismaJson({ t: "encrypted", c: "staged-target" }),
                    schemaVersion: 1,
                    contractDigest: "A".repeat(43),
                    sourceEncodedBytes: 2n,
                    targetEncodedBytes: 13n,
                }))
            )),
        });

        await expect(inTx(async (tx) => (
            await cleanupExpiredAccountEncryptionTransitionsInTx({ tx, now })
        ))).resolves.toEqual({
            expiredTransitionCount: 1,
            removedStageCount: stageCount,
        });
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: firstTransitionId },
            select: { status: true, activeAccountId: true },
        })).resolves.toEqual({ status: "expired", activeAccountId: null });
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId: firstTransitionId },
        })).resolves.toBe(0);
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: secondTransitionId },
            select: { status: true, activeAccountId: true },
        })).resolves.toEqual({
            status: "preparing",
            activeAccountId: secondAccountId,
        });
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId: secondTransitionId },
        })).resolves.toBe(stageCount);

        await expect(inTx(async (tx) => (
            await cleanupExpiredAccountEncryptionTransitionsInTx({ tx, now })
        ))).resolves.toEqual({
            expiredTransitionCount: 1,
            removedStageCount: stageCount,
        });
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: secondTransitionId },
            select: { status: true, activeAccountId: true },
        })).resolves.toEqual({ status: "expired", activeAccountId: null });
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId: secondTransitionId },
        })).resolves.toBe(0);
    });

    it("does not terminalize an expired transition before every staged envelope is scrubbed", async () => {
        const accountId = randomUUID();
        const transitionId = randomUUID();
        const expiresAt = new Date("2026-08-12T10:00:00.000Z");
        const now = new Date("2026-08-12T10:01:00.000Z");
        const cleanupBatchSize =
            ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.cleanupBatchSize;

        await db.account.create({
            data: { id: accountId, encryptionMode: "plain" },
        });
        await db.accountEncryptionTransition.create({
            data: {
                id: transitionId,
                accountId,
                fromEncryptionMode: "plain",
                toEncryptionMode: "e2ee",
                sourceAccountVersion: 0,
                sourceSettingsVersion: 0,
                status: "preparing",
                activeAccountId: accountId,
                preparedAt: expiresAt,
                expiresAt,
            },
        });
        await db.accountEncryptionTransitionCollectionStage.createMany({
            data: Array.from({ length: cleanupBatchSize * 2 }, (_, index) => ({
                transitionId,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: `partial-cleanup-${index}`,
                sourceRevision: 1,
                sourceEnvelope: toPrismaJson({ t: "plain", v: {} }),
                targetEnvelope: toPrismaJson({ t: "encrypted", c: "staged-target" }),
                schemaVersion: 1,
                contractDigest: "A".repeat(43),
                sourceEncodedBytes: 2n,
                targetEncodedBytes: 13n,
            })),
        });

        await expect(inTx(async (tx) => (
            await cleanupExpiredAccountEncryptionTransitionsInTx({ tx, now })
        ))).resolves.toEqual({
            expiredTransitionCount: 0,
            removedStageCount: cleanupBatchSize,
        });
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: transitionId },
            select: { status: true, activeAccountId: true },
        })).resolves.toEqual({ status: "preparing", activeAccountId: accountId });
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId },
        })).resolves.toBe(cleanupBatchSize);

        await expect(inTx(async (tx) => (
            await cleanupExpiredAccountEncryptionTransitionsInTx({ tx, now })
        ))).resolves.toEqual({
            expiredTransitionCount: 1,
            removedStageCount: cleanupBatchSize,
        });
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: transitionId },
            select: { status: true, activeAccountId: true },
        })).resolves.toEqual({ status: "expired", activeAccountId: null });
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId },
        })).resolves.toBe(0);
    });

    it("rejects a 501-row source census before retaining any source stage when Account capacity is lower", async () => {
        const binding = createSignedAccountContentBinding();
        await db.account.create({
            data: {
                id: ACCOUNT_ID,
                ...binding,
                encryptionMode: "e2ee",
            },
        });
        const contract = await createCollectionContract();
        const sourceEnvelope = toPrismaJson({
            t: "encrypted",
            c: sealPluginCollectionPrivatePayloadV1({
                material: {
                    type: "dataKey",
                    machineKey: new Uint8Array(32).fill(97),
                },
                payload: {},
                randomBytes: (length) => new Uint8Array(length).fill(101),
            }),
        });
        await db.pluginCollectionRow.createMany({
            data: Array.from(
                {
                    length:
                        ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS
                        + 1,
                },
                (_, index) => ({
                    accountId: ACCOUNT_ID,
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    rowId: `over-capacity-${index}`,
                    schemaVersion: contract.schemaVersion,
                    revision: 1,
                    contractId: contract.id,
                    contractDigest: contract.contractDigest,
                    contentEnvelope: sourceEnvelope,
                }),
            ),
        });
        const oversizedRows = await db.pluginCollectionRow.findMany({
            where: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
            },
            select: { id: true, rowId: true, revision: true },
        });
        await db.pluginCollectionProjection.createMany({
            data: oversizedRows.map((row) => ({
                rowDbId: row.id,
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: row.rowId,
                fieldId: "status",
                typedEncodedValue: JSON.stringify("open"),
                rowRevision: row.revision,
            })),
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });

        const prepared = await inTx(async (tx) =>
            await prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                request: {
                    toMode: "plain",
                    expectedAccountVersion: 0,
                    expectedSigningKeyFingerprint:
                        fingerprints.signingKeyFingerprint,
                    expectedContentKeyFingerprint:
                        fingerprints.contentKeyFingerprint,
                },
            })
        );
        expect(prepared.status).toBe("prepared");
        if (prepared.status !== "prepared") {
            throw new Error(`Expected prepared transition, got ${prepared.status}`);
        }
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId: prepared.transition.transitionId },
        })).resolves.toBe(0);
        // The fixture's provider-derived capacity is deliberately lower than
        // this complete source census. The 500-item protocol page is only a
        // transport bound: no first source stage may be retained for a source
        // set that this explicit aggregate measurement cannot activate.
        await declareIsolatedFixtureCapacity(prepared.transition.transitionId, {
            participantLimit: 400,
            encodedByteLimit: 16n * 1024n * 1024n,
            reservedCapacityBytes: 32n * 1024n * 1024n,
        });
        await expect(inTx(async (tx) =>
            await authorizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                authorization: { kind: "present_user_confirmation" },
            })
        )).resolves.toEqual({ status: "migration_too_large" });
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId: prepared.transition.transitionId },
        })).resolves.toBe(0);
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: prepared.transition.transitionId },
            select: { status: true, activeAccountId: true },
        })).resolves.toEqual({ status: "cancelled", activeAccountId: null });
    });

    it("migrates every persisted Collection contract version and retains one deterministic full Collection invalidation", async () => {
        const binding = createSignedAccountContentBinding();
        await db.account.create({
            data: { id: ACCOUNT_ID, ...binding, encryptionMode: "e2ee" },
        });
        const first = await createCollectionContract();
        const alternateManifest = {
            ...MANIFEST,
            version: "2.0.0",
            contributes: {
                accountCollections: [{
                    ...MANIFEST.contributes.accountCollections[0],
                    schemaVersion: 2,
                }],
            },
        } as const;
        const [alternateRef] = await inTx(async (tx) => (
            await materializePluginCollectionContractsFromManifestTx({
                tx,
                manifest: alternateManifest,
            })
        ));
        if (!alternateRef) throw new Error("Expected alternate Collection contract.");
        const second = await db.pluginCollectionContract.findFirstOrThrow({
            where: {
                pluginId: alternateRef.pluginId,
                collectionId: alternateRef.collectionId,
                schemaVersion: alternateRef.schemaVersion,
                contractDigest: alternateRef.contractDigest,
            },
        });
        const encrypted = toPrismaJson({
            t: "encrypted",
            c: sealPluginCollectionPrivatePayloadV1({
                material: {
                    type: "dataKey",
                    machineKey: new Uint8Array(32).fill(61),
                },
                payload: {},
                randomBytes: (length) => new Uint8Array(length).fill(67),
            }),
        });
        const rows = await Promise.all([first, second].map(async (contract, index) => (
            await db.pluginCollectionRow.create({
                data: {
                    accountId: ACCOUNT_ID,
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    rowId: `mixed-digest-${index}`,
                    schemaVersion: contract.schemaVersion,
                    revision: 1,
                    contractId: contract.id,
                    contractDigest: contract.contractDigest,
                    contentEnvelope: encrypted,
                },
            })
        )));
        await db.pluginCollectionProjection.createMany({
            data: rows.map((row) => ({
                rowDbId: row.id,
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: row.rowId,
                fieldId: "status",
                typedEncodedValue: JSON.stringify("open"),
                rowRevision: row.revision,
            })),
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });
        const prepared = await inTx(async (tx) => (
            await prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                request: {
                    toMode: "plain",
                    expectedAccountVersion: 0,
                    expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
                    expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
                },
            })
        ));
        expect(prepared.status).toBe("prepared");
        if (prepared.status !== "prepared") throw new Error("Expected prepared transition.");
        await declareIsolatedFixtureCapacity(prepared.transition.transitionId);
        await expect(inTx(async (tx) => (
            await authorizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                authorization: { kind: "present_user_confirmation" },
            })
        ))).resolves.toEqual({ status: "authorized" });
        const inventory = await inTx(async (tx) => (
            await inventoryAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
            })
        ));
        if (inventory.status !== "ready") throw new Error("Expected ready inventory.");

        await expect(inTx(async (tx) => (
            await stageAccountEncryptionTransitionCollectionsCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                items: inventory.items.map((item) => ({
                    pluginId: item.pluginId,
                    collectionId: item.collectionId,
                    rowId: item.rowId,
                    expectedRevision: item.revision,
                    sourceEnvelope: item.sourceEnvelope,
                    targetEnvelope: { t: "plain", v: {} },
                    schemaVersion: item.schemaVersion,
                    contractDigest: item.contractDigest,
                })),
            })
        ))).resolves.toMatchObject({
            status: "staged",
            stagedParticipantCount: 2,
        });
        await expect(inTx(async (tx) => (
            await activateAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
            })
        ))).resolves.toMatchObject({
            status: "activated",
            mode: "plain",
            cursor: 2,
        });
        await expect(db.pluginCollectionRow.findMany({
            where: { id: { in: rows.map((row) => row.id) } },
            orderBy: { rowId: "asc" },
            select: { rowId: true, revision: true, contentEnvelope: true },
        })).resolves.toEqual(rows.map((row) => ({
            rowId: row.rowId,
            revision: 2,
            contentEnvelope: { t: "plain", v: {} },
        })));
        const expectedHintDigest = first.contractDigest > second.contractDigest
            ? first.contractDigest
            : second.contractDigest;
        await expect(db.accountChange.findMany({
            where: { accountId: ACCOUNT_ID, kind: "pluginDomain" },
            orderBy: { cursor: "asc" },
            select: { cursor: true, entityId: true, hint: true },
        })).resolves.toEqual([{
            cursor: 1,
            entityId: `pluginDomain/${PLUGIN_ID}/data-collection/${COLLECTION_ID}`,
            hint: {
                pluginDomain: "dataCollection",
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                contractDigest: expectedHintDigest,
                revision: 2,
                full: true,
            },
        }]);
        await expect(db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { encryptionMode: true, seq: true },
        })).resolves.toEqual({ encryptionMode: "plain", seq: 2 });
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId: prepared.transition.transitionId },
        })).resolves.toBe(0);
    });

    it("authorizes a new E2EE key only for a truly keyless plain Account and commits that verified binding at activation", async () => {
        await db.account.create({
            data: {
                id: ACCOUNT_ID,
                encryptionMode: "plain",
                publicKey: null,
                contentPublicKey: null,
                contentPublicKeySig: null,
            },
        });
        const prepared = await inTx(async (tx) =>
            await prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                request: {
                    toMode: "e2ee",
                    expectedAccountVersion: 0,
                    expectedSigningKeyFingerprint: null,
                    expectedContentKeyFingerprint: null,
                },
            })
        );
        expect(prepared.status).toBe("prepared");
        if (prepared.status !== "prepared") {
            throw new Error(`Expected prepared transition, got ${prepared.status}`);
        }
        await declareIsolatedFixtureCapacity(prepared.transition.transitionId);
        const signing = tweetnacl.sign.keyPair();
        const content = tweetnacl.box.keyPair();
        const binding = verifyAccountContentKeyBinding({
            accountSigningPublicKey: signing.publicKey,
            contentPublicKey: content.publicKey,
            contentPublicKeySignature: signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey,
                contentPublicKey: content.publicKey,
            }),
        });
        if (!binding) throw new Error("Expected a valid content-key binding.");
        const accountPublicKeyHex = Buffer.from(signing.publicKey).toString("hex");

        await expect(inTx(async (tx) =>
            await authorizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                authorization: {
                    kind: "first_key",
                    accountPublicKeyHex,
                    binding,
                    signingKeyFingerprint:
                        deriveAccountEncryptionMigrationKeyFingerprints({
                            publicKey: accountPublicKeyHex,
                            contentPublicKey: content.publicKey,
                        }).signingKeyFingerprint!,
                },
            })
        )).resolves.toEqual({ status: "authorized" });
        await expect(inTx(async (tx) =>
            await activateAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
            })
        )).resolves.toMatchObject({ status: "activated", mode: "e2ee" });
        await expect(db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: {
                encryptionMode: true,
                publicKey: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
                seq: true,
            },
        })).resolves.toEqual({
            encryptionMode: "e2ee",
            publicKey: accountPublicKeyHex,
            contentPublicKey: new Uint8Array(content.publicKey),
            contentPublicKeySig: expect.any(Uint8Array),
            seq: 1,
        });
    });

    it("restores a retained plain Account only with its exact pinned key binding and rejects rekeying", async () => {
        const retained = createSignedAccountContentBinding();
        await db.account.create({
            data: {
                id: ACCOUNT_ID,
                ...retained,
                encryptionMode: "plain",
            },
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: retained.publicKey,
            contentPublicKey: retained.contentPublicKey,
        });
        const prepared = await inTx(async (tx) =>
            await prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                request: {
                    toMode: "e2ee",
                    expectedAccountVersion: 0,
                    expectedSigningKeyFingerprint:
                        fingerprints.signingKeyFingerprint,
                    expectedContentKeyFingerprint:
                        fingerprints.contentKeyFingerprint,
                },
            })
        );
        expect(prepared.status).toBe("prepared");
        if (prepared.status !== "prepared") {
            throw new Error(`Expected prepared transition, got ${prepared.status}`);
        }
        await declareIsolatedFixtureCapacity(prepared.transition.transitionId);
        const retainedBinding = verifyAccountContentKeyBinding({
            accountSigningPublicKey: new Uint8Array(
                Buffer.from(retained.publicKey, "hex"),
            ),
            contentPublicKey: retained.contentPublicKey,
            contentPublicKeySignature: retained.contentPublicKeySig,
        });
        if (!retainedBinding) throw new Error("Expected retained key binding.");
        const replacement = createSignedAccountContentBinding();
        const replacementBinding = verifyAccountContentKeyBinding({
            accountSigningPublicKey: new Uint8Array(
                Buffer.from(replacement.publicKey, "hex"),
            ),
            contentPublicKey: replacement.contentPublicKey,
            contentPublicKeySignature: replacement.contentPublicKeySig,
        });
        if (!replacementBinding) throw new Error("Expected replacement key binding.");
        const replacementFingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: replacement.publicKey,
            contentPublicKey: replacement.contentPublicKey,
        });

        await expect(inTx(async (tx) =>
            await authorizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                authorization: {
                    kind: "first_key",
                    accountPublicKeyHex: replacement.publicKey,
                    binding: replacementBinding,
                    signingKeyFingerprint:
                        replacementFingerprints.signingKeyFingerprint!,
                },
            })
        )).resolves.toEqual({ status: "invalid_authorization" });

        await expect(inTx(async (tx) =>
            await authorizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
                authorization: {
                    kind: "first_key",
                    accountPublicKeyHex: retained.publicKey,
                    binding: retainedBinding,
                    signingKeyFingerprint:
                        fingerprints.signingKeyFingerprint!,
                },
            })
        )).resolves.toEqual({ status: "authorized" });
        await expect(inTx(async (tx) =>
            await activateAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: ACCOUNT_ID,
                transitionId: prepared.transition.transitionId,
            })
        )).resolves.toMatchObject({ status: "activated", mode: "e2ee" });
        await expect(db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: {
                encryptionMode: true,
                publicKey: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
                seq: true,
            },
        })).resolves.toEqual({
            encryptionMode: "e2ee",
            publicKey: retained.publicKey,
            contentPublicKey: retained.contentPublicKey,
            contentPublicKeySig: retained.contentPublicKeySig,
            seq: 1,
        });
    });
});
