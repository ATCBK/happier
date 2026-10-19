import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { createWorkflowAccountRunActionOwner } from "@happier-dev/protocol/actions/executor/workflowRunActions";
import { createWorkflowActionExecutor } from "@happier-dev/protocol/actions/executor/workflowAccountActions";
import { createWorkflowDefinitionActions } from "@happier-dev/protocol/actions/executor/workflowDefinitions";
import { readCompleteActionSpecV1 } from "@happier-dev/protocol/actions/actionCatalog";
import { createActionExecutor } from "@happier-dev/protocol/actions/actionExecutor";
import { StrictJsonValueSchema } from "@happier-dev/protocol/json/strictJsonValue";
import { WorkflowDefinitionArtifactBodyV1Schema, WorkflowDefinitionArtifactHeaderV1Schema } from "@happier-dev/protocol/workflows/workflowDefinitionV1";
import { WorkflowActionOutputSchemasV1 } from "@happier-dev/protocol/workflows/actionsV1";
import { validateWorkflowDefinition } from "@happier-dev/protocol/workflows/workflowValidationV1";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from "@happier-dev/protocol/storage/artifactStoredContent";
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from "@happier-dev/protocol/plugins/installations/manifests";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { registerWorkflowRunStorageRoutes } from "@/app/api/routes/automations/registerWorkflowRunStorageRoutes";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedPluginInstallationPublisherHeader, createTrustedMachineInstallation } from "@/testkit/pluginInstallationPublisherTestkit";
import { deriveAutomationAccountCurrentnessWitness } from "@/app/automations/automationAccountCurrentness";

describe("composed saved Workflow start admission", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: "happier-workflow-start-", initAuth: true }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each([false, true])("starts through materialization, signed Account storage and exact Get (publisher mis-bound: %s)", async (miswired) => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const witness = deriveAutomationAccountCurrentnessWitness(account);
        if (!witness || witness.mode !== "plain") throw new Error("plain_account_currentness_unavailable");
        const machineId = randomUUID();
        const installationId = randomUUID();
        const keyPair = tweetnacl.sign.keyPair();
        await createTrustedMachineInstallation({ accountId: account.id, machineId, installationId, keyPair });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerWorkflowRunStorageRoutes(app);
        const agentTarget = { kind: "agent" as const, identity: { pluginId: "external.workflow-test", localId: "agent" } };
        const engine = { agentTarget };
        const document = { text: "Return the requested value.", references: [], attachments: [] };
        const childId = randomUUID();
        const sourceId = randomUUID();
        const runId = randomUUID();
        const normalize = (value: unknown) => {
            const result = validateWorkflowDefinition(value);
            if (!result.valid || !result.normalizedDefinition) throw new Error(JSON.stringify(result.issues));
            return result.normalizedDefinition;
        };
        const child = normalize({ version: 1, defaults: { engine }, blocks: [{ kind: "step", id: "child-reply", document, result: { kind: "text" } }],
            finalOutput: { kind: "result", producer: { blockId: "child-reply", scope: { kind: "current" } }, path: [] } });
        // R63's authored kinds, binding topology, role and mixed target classes.
        const definition = normalize({ version: 1, inputs: [], defaults: { engine, permissionMode: "default" },
            roles: [{ roleId: "verifier", name: "Verifier", engine: { agentTargetKey: "agent:external.workflow-test/agent", modelId: "small" }, runsAs: { kind: "session" }, instructions: "Verify the supplied item." }],
            blocks: [
                { kind: "step", id: "named-ready", document, result: { kind: "json", schema: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"], additionalProperties: false } } },
                { kind: "if", id: "if-ready", when: { kind: "exists", value: { kind: "result", producer: { blockId: "named-ready", scope: { kind: "current" } }, path: ["ready"] } },
                    then: [{ kind: "step", id: "if-reply", document, result: { kind: "text" } }], otherwise: [] },
                { kind: "loop", id: "parallel-items", repetition: { kind: "items", items: { kind: "literal", value: ["alpha", "beta"] }, execution: "parallel", failurePolicy: "fail_stop" },
                    body: [{ kind: "step", id: "item-reply", document, input: [{ kind: "item", field: "value" }], execution: { engine: { role: "verifier" } }, result: { kind: "text" } }] },
                { kind: "action", id: "list-triggers", actionId: "workflow.trigger.list", input: { workflow: { kind: "literal", value: childId } } },
                { kind: "workflow", id: "nested-child", workflowRef: childId, input: {} },
                { kind: "step", id: "background-reply", document, execution: { agentTarget, executionTarget: { kind: "detached_run" }, conversation: { kind: "fresh" } }, result: { kind: "text" } },
            ], finalOutput: { kind: "result", producer: { blockId: "background-reply", scope: { kind: "current" } }, path: [] } });
        for (const [id, value] of [[childId, child], [sourceId, definition]] as const) {
            await db.artifact.create({ data: { id, accountId: account.id, headerVersion: 1, bodyVersion: 1,
                header: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent(WorkflowDefinitionArtifactHeaderV1Schema.parse({
                    kind: "workflow-definition.v1", definitionId: id, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: "Composed admission" },
                })))),
                body: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent(JSON.stringify(WorkflowDefinitionArtifactBodyV1Schema.parse({ kind: "workflow-definition.v1", definition: value }))))),
                dataEncryptionKey: new Uint8Array(privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)) } });
        }
        const unused = async (): Promise<never> => { throw new Error("unexpected_artifact_mutation"); };
        const definitions = createWorkflowDefinitionActions({ assertDefinitionWriteAllowed: unused, encodeListCursor: () => "unused", artifactStore: {
            // SQLite is the real persistence boundary; the canonical codec and
            // definition owner open exactly the producer's stored envelopes.
            read: async id => {
                const row = await db.artifact.findUnique({ where: { id } });
                if (!row || row.accountId !== account.id) return null;
                const header = WorkflowDefinitionArtifactHeaderV1Schema.parse(decodePlainArtifactStoredContent(privacyKit.encodeBase64(row.header)));
                const body = decodePlainArtifactStoredContent(privacyKit.encodeBase64(row.body));
                if (typeof body !== "string") throw new Error("invalid_artifact_body");
                return { artifactId: id, ownerAccountId: account.id, access: "owner", header, body,
                    revision: { headerVersion: row.headerVersion, bodyVersion: row.bodyVersion } };
            }, list: unused, create: unused, update: unused, delete: unused,
        } });
        // Discovery runs the real executor; unused external host/native ports fail loudly.
        const discovery = createActionExecutor({ isActionApprovalRequired: () => false,
            executionRunStart: unused, executionRunList: unused, executionRunGet: unused,
            detachedExecutionRunSend: unused, executionRunStop: unused, executionRunAction: unused, executionRunWait: unused,
            sessionOpen: unused, sessionFork: unused, sessionRollback: unused, sessionSpawnNew: unused,
            pathsListRecent: unused, projectsList: unused, machinesList: unused, serversList: unused,
            reviewEnginesList: unused, agentsBackendsList: unused, agentsModelsList: unused,
            agentsConfigOptionsList: unused, agentsSessionModesList: unused, spawnProfilesList: unused,
            spawnConnectedServicesList: unused, spawnMcpServersPreview: unused,
            sessionSendMessage: unused, sessionPermissionRespond: unused, sessionUserActionAnswer: unused,
            sessionModeSet: unused, sessionModesList: unused, sessionTargetPrimarySet: unused,
            sessionTargetTrackedSet: unused, sessionList: unused, sessionActivityGet: unused,
            sessionRecentMessagesGet: unused, resetGlobalVoiceAgent: () => { throw new Error("unexpected_native_execution"); },
            teleportVoiceAgentToSessionRoot: unused,
            daemonMemorySearch: unused, daemonMemoryGetWindow: unused, daemonMemoryEnsureUpToDate: unused,
        });
        const storageResponses: Array<{ operation: unknown; status: number }> = [];
        const runs = createWorkflowAccountRunActionOwner({ definitions,
            resolveAccountId: async () => account.id,
            resolveEncryption: async () => ({ kind: "available", witness: { mode: "plain", version: witness.version, contentKeyFingerprint: null } }),
            normalizeAbsolutePath: path => path.startsWith("/") ? path : null,
            randomBytes: () => { throw new Error("plain_account_has_no_keys"); },
            prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId, directory: "/repo", checkoutRootPath: "/repo" } } }),
            resolveMaterializationContext: async () => ({ effects: {
                resolveTargetAvailability: async () => true, // Native Agent execution is outside admission.
                readWorkflowDefinition: async ref => ref.kind === "artifact"
                    ? { ...await definitions.get({ definitionId: ref.artifactId }), sourceKey: ref.artifactId } : null,
                readActionContract: async actionId => {
                    const contract = await readCompleteActionSpecV1({ actionId, read: async input => {
                        const response = await discovery.execute("action.spec.get", input, { surface: "cli", authority: "present_user" });
                        if (!response.ok) throw new Error(response.errorCode);
                        return response.result;
                    } });
                    if (!contract.outputSchema) return null;
                    return { inputSchema: StrictJsonValueSchema.parse(contract.inputSchema), outputSchema: StrictJsonValueSchema.parse(contract.outputSchema) };
                },
            } }),
            storage: { execute: async (operation, options) => {
                const payload = { ...operation, ...(options?.publisherMachineId ? { publisherMachineId: miswired && operation.operation === "admit" ? randomUUID() : options.publisherMachineId } : {}) };
                const response = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage", payload,
                    headers: { authorization: `Bearer ${token}`, [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                        keyPair, machineId, installationId, path: "/v3/automations/runs/workflow-storage", body: payload, nonce: randomUUID(),
                    }) } });
                storageResponses.push({ operation: operation.operation, status: response.statusCode });
                if (response.statusCode !== 200) {
                    const refusal = response.json<{ error?: string } | null>();
                    throw Object.assign(new Error("storage_refused"), { code: refusal?.error ?? "run_access_denied", response: { status: response.statusCode } });
                }
                return response.json();
            } },
        });
        const execute = createWorkflowActionExecutor({ definitions, runs, isWorkflowFeatureEnabled: () => true });
        const context = { surface: "ui" as const, authority: "present_user" as const, actionCaller: { kind: "host" as const }, callerPermissionMode: "default" as const,
            externalActionTarget: { kind: "machine" as const, machineId, project: { machineId, directory: "/repo" } } };
        try {
            const started = await execute({ actionId: "workflow.run.start", input: { runId, source: { kind: "saved", definitionId: sourceId, revision: { headerVersion: 1, bodyVersion: 1 } } }, context });
            const read = await execute({ actionId: "workflow.run.get", input: { runId }, context });
            if (miswired) {
                expect(storageResponses).toContainEqual({ operation: "admit", status: 401 });
                expect(started).toMatchObject({ ok: false, errorCode: "run_access_denied" });
                expect(read).toMatchObject({ ok: false, errorCode: "run_not_found" });
                expect(await db.automationRun.findUnique({ where: { id: runId } })).toBeNull();
            } else {
                expect(started, JSON.stringify(storageResponses)).toMatchObject({ admission: "created", run: { id: runId, state: "queued", sourceArtifactId: sourceId } });
                expect(WorkflowActionOutputSchemasV1["workflow.run.get"].parse(read)).toMatchObject({ run: { id: runId, state: "queued" }, acceptedContext: {
                    frozenChildren: { [childId]: { blocks: [{ id: "child-reply" }] } },
                    materializedLeaves: expect.arrayContaining([{ sourceKey: "$root", blockId: "item-reply", kind: "step", selection: expect.any(Object), executionTarget: { kind: "session" }, authoredWorkspace: { kind: "inherit" }, role: expect.objectContaining({ roleId: "verifier" }) }]),
                } });
                const detail = WorkflowActionOutputSchemasV1["workflow.run.get"].parse(read);
                expect(detail.definition.blocks.map(block => ({ id: block.id, kind: block.kind })))
                    .toEqual(definition.blocks.map(block => ({ id: block.id, kind: block.kind })));
                expect(detail.acceptedContext.materializedLeaves.map(leaf => ({ sourceKey: leaf.sourceKey, blockId: leaf.blockId, kind: leaf.kind, target: leaf.executionTarget.kind })))
                    .toEqual([
                        { sourceKey: "$root", blockId: "named-ready", kind: "step", target: "session" },
                        { sourceKey: "$root", blockId: "if-reply", kind: "step", target: "session" },
                        { sourceKey: "$root", blockId: "item-reply", kind: "step", target: "session" },
                        { sourceKey: "$root", blockId: "list-triggers", kind: "action", target: "session" },
                        { sourceKey: "$root", blockId: "nested-child", kind: "workflow", target: "session" },
                        { sourceKey: "$root", blockId: "background-reply", kind: "step", target: "detached_run" },
                        { sourceKey: childId, blockId: "child-reply", kind: "step", target: "session" },
                    ]);
            }
        } finally { await app.close(); }
    });
});
