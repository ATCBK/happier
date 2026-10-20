import {
    AutomationSourceSelectorIdV1Schema,
    AutomationTriggerIdSchema,
    AutomationRunExecutionInputV1Schema,
    buildAutomationConversationOccurrenceEvidenceV1,
    buildAutomationPluginEventOccurrenceEvidenceV1,
    deriveAutomationOccurrenceKeyV1,
    parseAutomationStoredDefinitionExecutionRecipeV1,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    serializeAutomationRunExecutionRecipeV1,
    serializeAutomationStoredDefinitionExecutionRecipeV1,
} from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";
import { AutomationV3WorkerFailRequestSchema } from "@happier-dev/protocol/automations/automationApiV3";
import { sealAutomationRunFailureDetailStoredEnvelopeV1 } from "@happier-dev/protocol/automations/automationRunFailureDetailStoredContent";

import { db } from "@/storage/db";
import {
    automationAccountCurrentnessSelect,
    deriveAutomationAccountCurrentnessWitness,
} from "@/app/automations/automationAccountCurrentness";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    createSignedPluginInstallationPublisherHeader,
    createTrustedMachineInstallation,
} from "@/testkit/pluginInstallationPublisherTestkit";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { automationRoutes } from "./automationRoutes";
import { AUTOMATION_TEMPLATE_V02_PLAIN } from "@happier-dev/protocol/testing/accountScopedCipherFixtures";

function buildTemplateEnvelope(existingSessionId?: string): string {
    return JSON.stringify({
        kind: "happier_automation_template_encrypted_v1",
        payloadCiphertext: "ciphertext-base64",
        ...(existingSessionId ? { existingSessionId } : {}),
    });
}

function buildPlainTemplateEnvelope(): string {
    return JSON.stringify({
        kind: "happier_automation_template_plain_v1",
        payload: { prompt: "automation test" },
    });
}

function buildFrozenV2RunInput(params: Readonly<{
    templateCiphertext: string;
    origin: { kind: "scheduled"; scheduledFor: number } | { kind: "manual"; invokedAt: number };
}>): string {
    const input = {
        kind: "happier_automation_run_execution_input_v1",
        targetType: "new_session",
        templateVersion: 1,
        templateCiphertext: params.templateCiphertext,
        origin: params.origin,
    };
    return JSON.stringify(AutomationRunExecutionInputV1Schema.parse(input));
}

function strictV3RecipeShape(templateVersion: number) {
    return {
        v: 1,
        templateVersion,
        template: { t: "plain", v: { v: 1, prompt: "strict V3 definition" } },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: { serverId: "server", machineId: "machine-1" },
                directory: { kind: "path", path: "/tmp/strict-v3-automation" },
                agentTarget: {
                    kind: "agent",
                    identity: { pluginId: "happier.agent.codex", localId: "codex" },
                },
            },
        },
    } as const;
}

function buildStrictV3Recipe(templateVersion: number): string {
    const recipe = serializeAutomationStoredDefinitionExecutionRecipeV1(
        strictV3RecipeShape(templateVersion),
    );
    if (recipe.kind !== "available") {
        throw new Error("Expected strict V3 test recipe to serialize");
    }
    return recipe.serialized;
}

function buildStrictV3RunRecipe(templateVersion: number, machineId: string): string {
    const recipe = serializeAutomationRunExecutionRecipeV1({
        ...strictV3RecipeShape(templateVersion),
        assignmentMachineIds: [machineId],
    });
    if (recipe.kind !== "available") {
        throw new Error("Expected frozen strict V3 Run recipe to serialize");
    }
    return recipe.serialized;
}

function strictV3ExecutionRunRecipeShape(templateVersion: number) {
    return {
        v: 1,
        templateVersion,
        template: { t: "plain", v: { v: 1, prompt: "strict V3 detached execution" } },
        triggerEvidence: null,
        target: {
            kind: "executionRun" as const,
            request: {
                intent: "task" as const,
                backendTarget: { kind: "builtInAgent" as const, agentId: "codex" },
                permissionMode: "read_only" as const,
                retentionPolicy: "ephemeral" as const,
                runClass: "bounded" as const,
                ioMode: "request_response" as const,
            },
        },
    };
}

function buildStrictV3ExecutionRunDefinition(templateVersion: number): string {
    const recipe = serializeAutomationStoredDefinitionExecutionRecipeV1(
        strictV3ExecutionRunRecipeShape(templateVersion),
    );
    if (recipe.kind !== "available") {
        throw new Error("Expected strict V3 detached definition to serialize");
    }
    return recipe.serialized;
}

function buildStrictV3ExecutionRunRecipe(templateVersion: number, machineId: string): string {
    const recipe = serializeAutomationRunExecutionRecipeV1({
        ...strictV3ExecutionRunRecipeShape(templateVersion),
        assignmentMachineIds: [machineId],
    });
    if (recipe.kind !== "available") {
        throw new Error("Expected strict V3 detached Run recipe to serialize");
    }
    return recipe.serialized;
}

type UnsupportedV2RunCauseKind = "pluginEvent" | "conversation";

const UNSUPPORTED_V2_SOURCE_SELECTOR_ID = AutomationSourceSelectorIdV1Schema.parse(
    "8f2f9a52-6bd3-4d29-92bd-2b0b3f9a4a71",
);

/**
 * Truthful frozen inputs for the unsupported-cause Run rows. V2 must refuse
 * these Runs, but they remain real nonterminal current-model Runs, so each one
 * carries the frozen strict recipe, immutable occurrence evidence envelope,
 * and derived occurrence key the canonical admission owner would have
 * written. Event/Conversation causes cannot exist under predecessor V2
 * template bytes, so the fixture's Automation uses strict definition bytes.
 */
function unsupportedV2RunEvidenceInputs(params: Readonly<{
    causeKind: UnsupportedV2RunCauseKind;
    suffix: string;
    occurredAt: number;
    machineId: string;
}>): Readonly<{
    occurrenceKey: string;
    triggerEvidenceEnvelope: string;
    executionInputEnvelope: string;
}> {
    const definition = parseAutomationStoredDefinitionExecutionRecipeV1(buildStrictV3Recipe(1));
    if (definition.kind !== "available") {
        throw new Error("Expected the strict V3 fixture definition to parse");
    }
    const freeze = (triggerEvidence: { t: "plain"; v: unknown }, occurrenceKey: string,
        triggerEvidenceEnvelope: string) => {
        const frozen = serializeAutomationRunExecutionRecipeV1({
            ...definition.recipe,
            triggerEvidence,
            assignmentMachineIds: [params.machineId],
        });
        if (frozen.kind !== "available") {
            throw new Error("Expected the unsupported-cause fixture to freeze a strict Run recipe");
        }
        return {
            occurrenceKey,
            triggerEvidenceEnvelope,
            executionInputEnvelope: frozen.serialized,
        };
    };
    if (params.causeKind === "pluginEvent") {
        const evidence = buildAutomationPluginEventOccurrenceEvidenceV1({
            eventRef: { pluginId: "test.plugin", localId: "event-1" },
            sourceSelectorId: UNSUPPORTED_V2_SOURCE_SELECTOR_ID,
            occurrenceId: `unsupported-v2-${params.suffix}`,
            occurredAt: params.occurredAt,
            payload: {},
        });
        return freeze(
            {
                t: "plain",
                v: {
                    ...evidence,
                    sourceInstanceId: "unsupported-v2-source",
                    sourceContractVersion: 1,
                    observationReceivedAt: params.occurredAt,
                    filter: { version: null, result: "matched" as const },
                },
            },
            deriveAutomationOccurrenceKeyV1({
                triggerId: AutomationTriggerIdSchema.parse(`trigger-plugin-event-${params.causeKind}`),
                evidence,
            }),
            JSON.stringify({ t: "plain", v: evidence }),
        );
    }
    const evidence = buildAutomationConversationOccurrenceEvidenceV1({
        accountMode: "plain",
        bindingId: "binding-unsupported-v2",
        occurrenceId: `unsupported-v2-${params.suffix}`,
        occurredAt: params.occurredAt,
        caller: {
            pluginId: "happier.channels",
            contributionLocalId: "provider/observation-ingest-v1",
            machineId: params.machineId,
        },
        sender: { id: "sender-1" },
        text: "V2 must not touch this Conversation Run.",
        resultDelivery: {
            kind: "finalResult",
            actionRef: {
                pluginId: "happier.channels",
                localId: "automation/result-deliver-v1",
            },
            opaqueContext: { conversationId: `conversation-${params.suffix}` },
        },
    });
    return freeze(
        { t: "plain", v: { ...evidence, observationReceivedAt: params.occurredAt } },
        deriveAutomationOccurrenceKeyV1(evidence),
        JSON.stringify({ t: "plain", v: evidence }),
    );
}

function scheduleTriggerCreate(id: string, everyMs = 60_000) {
    return {
        id,
        kind: "schedule" as const,
        enabled: true,
        revision: 1,
        scheduleKind: "interval" as const,
        everyMs,
    };
}

function scheduleRunCause(params: Readonly<{
    triggerId: string;
    scheduledFor: Date;
}>) {
    const triggerId = AutomationTriggerIdSchema.parse(params.triggerId);
    return {
        triggerId,
        causeKind: "trigger" as const,
        causeTriggerKind: "schedule" as const,
        causeTriggerRevision: 1,
        causeOccurredAt: params.scheduledFor,
        causeScheduledFor: params.scheduledFor,
        occurrenceKey: deriveAutomationOccurrenceKeyV1({
            triggerId,
            evidence: {
                v: 1,
                kind: "schedule",
                scheduledFor: params.scheduledFor.getTime(),
            },
        }),
    };
}

async function snapshotAutomationPersistence(accountId: string) {
    const [account, automations, triggers, assignments, runs, runEvents, accountChanges] =
        await Promise.all([
            db.account.findUnique({ where: { id: accountId } }),
            db.automation.findMany({
                where: { accountId },
                orderBy: { id: "asc" },
            }),
            db.automationTrigger.findMany({
                where: { automation: { is: { accountId } } },
                orderBy: { id: "asc" },
            }),
            db.automationAssignment.findMany({
                where: { automation: { is: { accountId } } },
                orderBy: { id: "asc" },
            }),
            db.automationRun.findMany({
                where: { accountId },
                orderBy: { id: "asc" },
            }),
            db.automationRunEvent.findMany({
                where: { run: { is: { accountId } } },
                orderBy: { id: "asc" },
            }),
            db.accountChange.findMany({
                where: { accountId },
                orderBy: [{ kind: "asc" }, { entityId: "asc" }],
            }),
        ]);

    return { account, automations, triggers, assignments, runs, runEvents, accountChanges };
}

async function seedUnsupportedV2Automation(params: Readonly<{
    accountId: string;
    machineId: string;
    causeKind: UnsupportedV2RunCauseKind;
}>) {
    const now = Date.now();
    const isConversationRun = params.causeKind === "conversation";
    const triggerId = `trigger-plugin-event-${params.causeKind}`;
    const automation = await db.automation.create({
        data: {
            accountId: params.accountId,
            name: `pluginEvent V2 rejection fixture`,
            enabled: true,
            targetType: "new_session",
            templateCiphertext: buildStrictV3Recipe(1),
            templateVersion: 1,
            triggers: {
                create: {
                    id: triggerId,
                    kind: "pluginEvent",
                    enabled: true,
                    revision: 1,
                    definitionEnvelope: JSON.stringify({ t: "plain", v: {} }),
                    eventPluginId: "test.plugin",
                    eventLocalId: "event-1",
                    sourceSelectorId: UNSUPPORTED_V2_SOURCE_SELECTOR_ID,
                    sourceContractVersion: 1,
                    observationTransport: "durablePush",
                    webhookEndpointId: "endpoint-1",
                    observationStartsAt: new Date(now - 120_000),
                },
            },
        },
        select: { id: true },
    });
    await db.automationAssignment.create({
        data: {
            automationId: automation.id,
            machineId: params.machineId,
            enabled: true,
            priority: 0,
        },
    });

    const runInput = (suffix: string) => ({
        id: `${params.causeKind}-${suffix}`,
        automationId: automation.id,
        accountId: params.accountId,
        triggerId: isConversationRun ? null : triggerId,
        causeKind: isConversationRun ? "conversation" as const : "trigger" as const,
        causeTriggerKind: isConversationRun ? null : "pluginEvent" as const,
        causeTriggerRevision: isConversationRun ? null : 1,
        causeOccurredAt: new Date(now - 60_000),
        causeEventPluginId: isConversationRun ? null : "test.plugin",
        causeEventLocalId: isConversationRun ? null : "event-1",
        ...unsupportedV2RunEvidenceInputs({
            causeKind: params.causeKind,
            suffix,
            occurredAt: now - 60_000,
            machineId: params.machineId,
        }),
        causeSourceSelectorId: isConversationRun ? null : UNSUPPORTED_V2_SOURCE_SELECTOR_ID,
        ...(isConversationRun
            ? {
                replyContextEnvelope: JSON.stringify({
                    t: "plain",
                    v: {
                        v: 1,
                        correspondence: {
                            accountId: params.accountId,
                            automationId: automation.id,
                            runId: `${params.causeKind}-${suffix}`,
                            handoffId: `handoff-${suffix}`,
                        },
                        source: {
                            kind: "automationResult",
                            automationRunId: `${params.causeKind}-${suffix}`,
                            resultId: `handoff-${suffix}`,
                            automationId: automation.id,
                            templateVersion: 1,
                            resultDelivery: "finalResult",
                        },
                        opaqueContext: { conversationId: `conversation-${suffix}` },
                    },
                }),
                replyHandoffActionPluginId: "happier.channels",
                replyHandoffActionLocalId: "automation/result-deliver-v1",
                replyHandoffTargetMachineId: params.machineId,
                replyHandoffTargetMachineInstallationId: "installation-1",
                replyHandoffTargetMaterializationId: "materialization-1",
                replyHandoffId: `handoff-${suffix}`,
                replyHandoffState: "awaitingResult" as const,
            }
            : {}),
        scheduledAt: new Date(now - 60_000),
        dueAt: new Date(now - 30_000),
    });
    const [queued, claimed, running] = await Promise.all([
        db.automationRun.create({
            data: {
                ...runInput("queued"),
                state: "queued",
                attempt: 0,
                assignments: { create: { machineId: params.machineId, priority: 0 } },
            },
            select: { id: true },
        }),
        db.automationRun.create({
            data: {
                ...runInput("claimed"),
                state: "claimed",
                claimedAt: new Date(now - 20_000),
                claimedByMachineId: params.machineId,
                leaseExpiresAt: new Date(now + 60_000),
                attempt: 1,
                assignments: { create: { machineId: params.machineId, priority: 0 } },
            },
            select: { id: true },
        }),
        db.automationRun.create({
            data: {
                ...runInput("running"),
                state: "running",
                claimedAt: new Date(now - 20_000),
                startedAt: new Date(now - 10_000),
                claimedByMachineId: params.machineId,
                leaseExpiresAt: new Date(now + 60_000),
                attempt: 1,
                assignments: { create: { machineId: params.machineId, priority: 0 } },
            },
            select: { id: true },
        }),
    ]);

    return { automation, queued, claimed, running };
}

describe("automation daemon routes (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-automation-daemon-routes-" });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        harness.resetEnv({ HAPPIER_FEATURE_AUTOMATIONS__ENABLED: "1" });
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automationTrigger.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });


    it("projects a pinned 0.2 template in its retained frozen input through the real V3 worker claim route", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = "machine-v2-frozen-via-v3";
        const installationId = "installation-v2-frozen-via-v3";
        const keyPair = tweetnacl.sign.keyPair();
        await createTrustedMachineInstallation({
            accountId: account.id,
            machineId,
            installationId,
            keyPair,
        });
        const scheduledFor = new Date(Date.now() - 10_000);
        const triggerId = "trigger-v2-frozen-via-v3";
        const frozenTemplateCiphertext = AUTOMATION_TEMPLATE_V02_PLAIN;
        const frozenInput = buildFrozenV2RunInput({
            templateCiphertext: frozenTemplateCiphertext,
            origin: { kind: "scheduled", scheduledFor: scheduledFor.getTime() },
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Released V2 frozen input",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: frozenTemplateCiphertext,
                templateVersion: 1,
                triggers: { create: scheduleTriggerCreate(triggerId) },
                assignments: { create: { machineId, enabled: true, priority: 0 } },
            },
            select: { id: true },
        });
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId: account.id,
                state: "queued",
                ...scheduleRunCause({ triggerId, scheduledFor }),
                scheduledAt: scheduledFor,
                dueAt: scheduledFor,
                executionInputEnvelope: frozenInput,
                assignments: { create: { machineId, priority: 0 } },
            },
            select: { id: true },
        });
        await db.automation.update({
            where: { id: automation.id },
            data: {
                templateCiphertext: buildStrictV3Recipe(2),
                templateVersion: 2,
            },
        });
        const body = { machineId, leaseDurationMs: 30_000 };

        await withAuthenticatedTestApp(
            (app) => automationRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: "/v3/automations/runs/claim",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                        [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]:
                            createSignedPluginInstallationPublisherHeader({
                                keyPair,
                                machineId,
                                installationId,
                                path: "/v3/automations/runs/claim",
                                body,
                            }),
                    },
                    payload: body,
                });

                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toEqual(expect.objectContaining({
                    run: expect.objectContaining({
                        id: run.id,
                        automationId: automation.id,
                        triggerRetired: false,
                        cause: expect.objectContaining({
                            kind: "trigger",
                            triggerKind: "schedule",
                            evidence: { scheduledFor: scheduledFor.getTime() },
                        }),
                        executionInputEnvelope: frozenInput,
                    }),
                    automation: {
                        id: automation.id,
                        name: "Released V2 frozen input",
                        enabled: true,
                        scopeSessionId: null,
                        workflowDefinitionId: null,
                    },
                    accountCurrentness: expect.objectContaining({ mode: "plain" }),
                }));
            },
        );
    });


    it("settles a signed pre-admission refusal despite unrelated Account publications", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const machineId = "machine-refused-workflow";
        const installationId = "installation-refused-workflow";
        const keyPair = tweetnacl.sign.keyPair();
        await createTrustedMachineInstallation({ accountId: account.id, machineId, installationId, keyPair });
        const triggerId = "trigger-refused-workflow";
        const automation = await db.automation.create({ data: {
            accountId: account.id, name: "Refused workflow", targetType: "new_session",
            templateCiphertext: buildStrictV3Recipe(1),
            triggers: { create: scheduleTriggerCreate(triggerId) },
            assignments: { create: { machineId, enabled: true, priority: 0 } },
        } });
        const scheduledFor = new Date(Date.now() - 60_000);
        const run = await db.automationRun.create({ data: {
            accountId: account.id, automationId: automation.id,
            ...scheduleRunCause({ triggerId, scheduledFor }),
            state: "claimed", claimedByMachineId: machineId, attempt: 1,
            claimedAt: scheduledFor, scheduledAt: scheduledFor, dueAt: scheduledFor,
            leaseExpiresAt: new Date(Date.now() + 60_000),
            executionInputEnvelope: buildStrictV3RunRecipe(1, machineId),
            workflowCustodyState: "pending",
        } });
        const accountCurrentness = deriveAutomationAccountCurrentnessWitness(
            await db.account.findUniqueOrThrow({ where: { id: account.id }, select: automationAccountCurrentnessSelect }),
        );
        if (!accountCurrentness) throw new Error("Expected current Account witness");
        const errorDetailEnvelope = JSON.stringify(sealAutomationRunFailureDetailStoredEnvelopeV1({
            mode: "plain", correspondence: { automationId: automation.id, runId: run.id },
            detail: "Workflow trigger admission refused: invalid_input",
        }));
        const body = AutomationV3WorkerFailRequestSchema.parse({ machineId, attempt: 1,
            accountCurrentness, errorCode: "invalid_input", errorDetailEnvelope });
        const path = `/v3/automations/runs/${run.id}/fail`;
        // An ordinary publication can race the worker's witness read and HTTP
        // send. It changes sequence, not encryption identity or claim authority.
        await db.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
        await withAuthenticatedTestApp(automationRoutes, async (app) => {
            for (const refusedBody of [
                { ...body, attempt: 2 },
                { ...body, accountCurrentness: { ...accountCurrentness, mode: "e2ee", contentKeyFingerprint: "other-key" } },
            ]) {
                const response = await app.inject({ method: "POST", url: path,
                    headers: { "x-test-user-id": account.id,
                        [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                            keyPair, machineId, installationId, path, body: refusedBody,
                        }) }, payload: refusedBody });
                expect(response.statusCode, response.body).toBe(404);
                expect(await db.automationRun.findUniqueOrThrow({ where: { id: run.id } }))
                    .toMatchObject({ state: "claimed", workflowCustodyState: "pending", errorCode: null });
            }
            const response = await app.inject({ method: "POST", url: path,
                headers: { "x-test-user-id": account.id,
                    [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                        keyPair, machineId, installationId, path, body,
                    }) }, payload: body });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ run: { id: run.id, state: "failed", errorCode: "invalid_input" } });
        });
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: run.id } }))
            .toMatchObject({ state: "failed", workflowCustodyState: "settled", errorCode: "invalid_input",
                errorMessage: errorDetailEnvelope, finishedAt: expect.any(Date), attempt: 1 });
    });

    it("rejects generic V3 start, succeed, and fail mutations for Workflow-custody Runs", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = "machine-v3-workflow-custody";
        const installationId = "installation-v3-workflow-custody";
        const keyPair = tweetnacl.sign.keyPair();
        await createTrustedMachineInstallation({
            accountId: account.id,
            machineId,
            installationId,
            keyPair,
        });
        const triggerId = "trigger-v3-workflow-custody";
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Workflow custody lifecycle rejection",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: buildStrictV3Recipe(1),
                templateVersion: 1,
                triggers: { create: scheduleTriggerCreate(triggerId) },
                assignments: { create: { machineId, enabled: true, priority: 0 } },
            },
            select: { id: true },
        });
        const accountRow = await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: automationAccountCurrentnessSelect,
        });
        const accountCurrentness = deriveAutomationAccountCurrentnessWitness(accountRow);
        if (!accountCurrentness) throw new Error("Expected current plain Account witness");
        const now = Date.now();
        const createWorkflowRun = async (state: "claimed" | "running", offsetMs: number) => {
            const scheduledFor = new Date(now - 60_000 - offsetMs);
            return await db.automationRun.create({
                data: {
                    automationId: automation.id,
                    accountId: account.id,
                    ...scheduleRunCause({ triggerId, scheduledFor }),
                    state,
                    scheduledAt: scheduledFor,
                    dueAt: scheduledFor,
                    claimedAt: new Date(now - 20_000),
                    ...(state === "running" ? { startedAt: new Date(now - 10_000) } : {}),
                    claimedByMachineId: machineId,
                    leaseExpiresAt: new Date(now + 60_000),
                    attempt: 1,
                    executionInputEnvelope: buildStrictV3RunRecipe(1, machineId),
                    workflowAcceptedSnapshotEnvelope: "{}",
                    workflowCustodyState: "pending",
                    assignments: { create: { machineId, priority: 0 } },
                },
                select: { id: true },
            });
        };
        const [startRun, succeedRun, failRun] = await Promise.all([
            createWorkflowRun("claimed", 1),
            createWorkflowRun("running", 2),
            createWorkflowRun("running", 3),
        ]);
        const mutations = [
            {
                runId: startRun.id,
                operation: "start",
                body: { machineId, attempt: 1, accountCurrentness },
            },
            {
                runId: succeedRun.id,
                operation: "succeed",
                body: { machineId, attempt: 1, accountCurrentness },
            },
            {
                runId: failRun.id,
                operation: "fail",
                body: { machineId, attempt: 1, accountCurrentness, errorCode: "must-not-terminalize" },
            },
        ] as const;

        await withAuthenticatedTestApp(
            (app) => automationRoutes(app as any),
            async (app) => {
                for (const mutation of mutations) {
                    const path = `/v3/automations/runs/${mutation.runId}/${mutation.operation}`;
                    const before = await snapshotAutomationPersistence(account.id);
                    const response = await app.inject({
                        method: "POST",
                        url: path,
                        headers: {
                            "content-type": "application/json",
                            "x-test-user-id": account.id,
                            [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]:
                                createSignedPluginInstallationPublisherHeader({
                                    keyPair,
                                    machineId,
                                    installationId,
                                    path,
                                    body: mutation.body,
                                    nonce: `workflow-custody-${mutation.operation}`,
                                }),
                        },
                        payload: mutation.body,
                    });
                    expect(response.statusCode, `${mutation.operation}: ${response.body}`).toBe(404);
                    expect(await snapshotAutomationPersistence(account.id)).toEqual(before);
                }
            },
        );
    });


    it("renews lease only for the claiming machine", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const machine1KeyPair = tweetnacl.sign.keyPair();
        const machine2KeyPair = tweetnacl.sign.keyPair();
        await createTrustedMachineInstallation({
            accountId: account.id,
            machineId: "machine-1",
            installationId: "installation-1",
            keyPair: machine1KeyPair,
        });
        await createTrustedMachineInstallation({
            accountId: account.id,
            machineId: "machine-2",
            installationId: "installation-2",
            keyPair: machine2KeyPair,
        });
        const templateCiphertext = buildPlainTemplateEnvelope();
        const triggerId = "trigger-heartbeat";
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Heartbeat run",
                enabled: true,
                targetType: "new_session",
                templateCiphertext,
                templateVersion: 1,
                triggers: { create: scheduleTriggerCreate(triggerId) },
            },
            select: { id: true },
        });
        const scheduledAt = new Date(Date.now() - 30_000);
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId: account.id,
                state: "claimed",
                ...scheduleRunCause({
                    triggerId,
                    scheduledFor: scheduledAt,
                }),
                scheduledAt,
                dueAt: new Date(Date.now() - 20_000),
                claimedAt: new Date(Date.now() - 10_000),
                claimedByMachineId: "machine-1",
                leaseExpiresAt: new Date(Date.now() + 1_000),
                attempt: 1,
                executionInputEnvelope: buildFrozenV2RunInput({
                    templateCiphertext,
                    origin: { kind: "scheduled", scheduledFor: scheduledAt.getTime() },
                }),
                assignments: { create: { machineId: "machine-1", priority: 0 } },
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => automationRoutes(app as any),
            async (app) => {
                const heartbeatHeaders = (params: Readonly<{
                    machineId: "machine-1" | "machine-2";
                    body: Readonly<Record<string, unknown>>;
                    nonce: string;
                }>) => ({
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                    [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]:
                        createSignedPluginInstallationPublisherHeader({
                            keyPair: params.machineId === "machine-1"
                                ? machine1KeyPair
                                : machine2KeyPair,
                            machineId: params.machineId,
                            installationId: params.machineId === "machine-1"
                                ? "installation-1"
                                : "installation-2",
                            path: `/v3/automations/runs/${run.id}/heartbeat`,
                            body: params.body,
                            nonce: params.nonce,
                        }),
                });
                const okRequestBody = {
                    machineId: "machine-1",
                    attempt: 1,
                    leaseDurationMs: 45_000,
                };
                const okResponse = await app.inject({
                    method: "POST",
                    url: `/v3/automations/runs/${run.id}/heartbeat`,
                    headers: heartbeatHeaders({
                        machineId: "machine-1",
                        body: okRequestBody,
                        nonce: "heartbeat-machine-1-ok",
                    }),
                    payload: okRequestBody,
                });
                expect(okResponse.statusCode).toBe(200);
                const okBody = okResponse.json() as any;
                expect(okBody.ok).toBe(true);
                expect(typeof okBody.leaseExpiresAt).toBe("number");

                const deniedBody = {
                    machineId: "machine-2",
                    attempt: 1,
                    leaseDurationMs: 45_000,
                };
                const deniedResponse = await app.inject({
                    method: "POST",
                    url: `/v3/automations/runs/${run.id}/heartbeat`,
                    headers: heartbeatHeaders({
                        machineId: "machine-2",
                        body: deniedBody,
                        nonce: "heartbeat-machine-2-denied",
                    }),
                    payload: deniedBody,
                });
                expect(deniedResponse.statusCode).toBe(404);
                expect(deniedResponse.json()).toEqual({ error: "automation_run_not_found_or_not_claimed" });

                await db.automationRun.update({
                    where: { id: run.id },
                    data: { attempt: 2 },
                });

                const staleBody = {
                    machineId: "machine-1",
                    leaseDurationMs: 45_000,
                };
                // Current worker requests require the exact attempt token.
                const legacyMissingAttemptResponse = await app.inject({
                    method: "POST",
                    url: `/v3/automations/runs/${run.id}/heartbeat`,
                    headers: heartbeatHeaders({
                        machineId: "machine-1",
                        body: staleBody,
                        nonce: "heartbeat-machine-1-stale",
                    }),
                    payload: staleBody,
                });
                expect(legacyMissingAttemptResponse.statusCode).toBe(400);

                const explicitStaleBody = {
                    machineId: "machine-1",
                    attempt: 1,
                    leaseDurationMs: 45_000,
                };
                const explicitStaleAttemptResponse = await app.inject({
                    method: "POST",
                    url: `/v3/automations/runs/${run.id}/heartbeat`,
                    headers: heartbeatHeaders({
                        machineId: "machine-1",
                        body: explicitStaleBody,
                        nonce: "heartbeat-machine-1-explicit-stale",
                    }),
                    payload: explicitStaleBody,
                });
                expect(explicitStaleAttemptResponse.statusCode).toBe(404);

                const currentBody = {
                    machineId: "machine-1",
                    attempt: 2,
                    leaseDurationMs: 45_000,
                };
                const currentAttemptResponse = await app.inject({
                    method: "POST",
                    url: `/v3/automations/runs/${run.id}/heartbeat`,
                    headers: heartbeatHeaders({
                        machineId: "machine-1",
                        body: currentBody,
                        nonce: "heartbeat-machine-1-current",
                    }),
                    payload: currentBody,
                });
                expect(currentAttemptResponse.statusCode).toBe(200);
            },
        );
    });


});
