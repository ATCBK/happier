import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { join } from 'node:path';
import { spawn, ChildProcess, type SpawnOptions } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { io } from 'socket.io-client';
import Fastify from 'fastify';
import type { Fastify as AppFastify } from '../../../../../server/sources/app/api/types';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, ExternalActionDaemonDispatchRequestSchema,
    ExternalActionExecutionAuthorizationRequestV1Schema,
    ExternalActionRequestEnvelopeV1Schema,
    computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import { decodeBase64, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER,
    signMachineInstallationProof, SessionSpawnNewInputV2Schema, SessionSpawnNewResultV1Schema,
    MachineOperationProtocolCapabilitiesV1Schema, SessionTurnsProjectionV1Schema, PluginManifestV2Schema,
    SessionTurnMutationActionV1Schema, SessionTurnMutationDecisionV1Schema, SessionTurnMutationV1Schema } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerRegistrar } from '../../../../../cli/src/api/rpc/types';
import type { VerifyExternalActionExecutionAuthorization } from '../../../../../cli/src/daemon/externalActions/executeExternalAction';
import type { PluginTargetActivationFact } from '../../../../../cli/src/plugins/runtime/lifecycle/activation/facts';
import { ApiClient } from '../../../../../cli/src/api/api';
import type { ApiMachineClient } from '../../../../../cli/src/api/apiMachine';
import { commitDaemonLaunchSession } from '../../../../../cli/src/daemon/spawn/commitDaemonLaunchSession';
import { createSessionAttachFile } from '../../../../../cli/src/daemon/sessionAttachFile';
import { createBaseSessionForAttach } from '../../../../../cli/src/agent/runtime/createBaseSessionForAttach';
import { createInitialHostRuntimeActivityMutation } from '../../../../../cli/src/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import { ApiSessionClient } from '../../../../../cli/src/api/session/sessionClient';
import { createTestApiSessionClient } from '../../../../../cli/src/testkit/backends/createTestApiSessionClient';
import { createAccountSessionClientTransport } from '../../../../../cli/src/api/client/createAccountSessionClientTransport';
import { readCredentials, updateSettings, writeCredentialsTokenOnly, writeDaemonState, type StoredCredentials } from '../../../../../cli/src/persistence';
import { logger } from '../../../../../cli/src/ui/logger';
import { configuration } from '../../../../../cli/src/configuration';
import { readInstallationIdentityIfExistsSync } from '../../../../../cli/src/daemon/identity/store';
import { isCanonicalAbsolutePathInsideRoot } from '../../../../../cli/src/utils/path/expandHomeDirPath';
import { createRequesterSessionRuntimeContext } from '../../../../../cli/src/daemon/sessionEncryption/createRequesterSessionRuntimeContext';
import type { TrackedSession } from '../../../../../cli/src/daemon/types';
import { createOnHappySessionWebhook } from '../../../../../cli/src/daemon/sessions/onHappySessionWebhook';
import { readProcessIdentityByPid } from '../../../../../cli/src/daemon/processIdentity';
import * as processIdentityBoundary from '../../../../../cli/src/daemon/processIdentity';
import { readOrCreateDeviceLocalSecretStorage } from '../../../../../cli/src/daemon/deviceLocalSecretStorage';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '../../../../../cli/src/plugins/testkit/admittedRuntime';
import { startInProcessAgentSessionRunner } from '../../../../../cli/src/testkit/backends/inProcessAgentSessionRunner';
import { bootstrapAccountSettingsContext } from '../../../../../cli/src/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveSessionStartAccountSettingsContext } from '../../../../../cli/src/settings/accountSettings/resolveSessionStartAccountSettingsContext';
import { createCliPromptLibraryStore } from '../../../../../cli/src/settings/prompts/promptLibraryStore';
import { refreshActivePromptLibraryCatalogAfterChange } from '../../../../../cli/src/settings/prompts/hydratePromptLibraryCatalog';
import { commitActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '../../../../../cli/src/settings/accountSettings/activeAccountSettingsSnapshot';
import { PromptLibraryRecordV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { readPromptLibraryCatalogRecordV1, type PromptLibraryCatalogSnapshotV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { buildPluginSessionBindingInput } from '../../../../../cli/src/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY } from '../../../../../cli/src/daemon/agentRuntime/sessionBridgeAuthorization';
import { buildHappyCliSubprocessLaunchSpec, resolveTsxImportHookPath } from '../../../../../cli/src/utils/spawnHappyCLI';
import { partitionProviderSessionArgs } from '../../../../../cli/src/cli/providerSessionArgPartition';
import { pluginReloadController } from '../../../../../cli/src/plugins/runtime/reload/singleton';
import { readRequesterSessionCredentialsForChild, REQUESTER_SESSION_ID_ENV, bindRequesterSessionRuntimeMachineAdmissionCurrentness, type RequesterSessionRuntimeContext } from '../../../../../cli/src/daemon/sessionEncryption/requesterSessionCredentials';
import { AgentRuntimeRunnerBootstrapV1Schema, HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY } from '../../../../../cli/src/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { resolveSessionStartupTimeoutMs } from '../../../../../cli/src/daemon/spawn/waitForSessionWebhook';
import { DEFAULT_SESSION_SPAWN_OPERATION_TIMEOUT_MS } from '@happier-dev/protocol/sessions/creation/sessionSpawnBudget';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { createSessionTurnLifecycle } from '../../../../../cli/src/agent/runtime/session/turn/lifecycle';
import { projectRuntimeTranscriptEvent } from '../../../../../cli/src/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { UserMessageSchema } from '../../../../../cli/src/api/types';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { runWithServerHttpBaseUrl } from '../../../../../cli/src/api/client/serverHttpBaseUrl';
import { registerExternalActionRpcHandler } from '../../../../../cli/src/rpc/handlers/externalAction';
import { registerWorkflowRunStorageRoutes } from '../../../../../server/sources/app/api/routes/automations/registerWorkflowRunStorageRoutes';
import { createMachineSessionDirectTargetTransport } from '../../../../../cli/src/rpc/handlers/sessionServerStartLifecycleAdapter';
import { createSpawnNewSessionLifecycleActionHandler } from '../../../../../cli/src/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import { createRequesterSessionControlRuntimeFixture } from '../../../../../cli/src/daemon/testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '../../../../../cli/src/daemon/connectedServices/runtimeRegistry/registry';
import { createTestMetadata } from '../../../../../cli/src/testkit/backends/sessionMetadata';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { enableSchemaValidation } from '../../../../../server/sources/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '../../../../../server/sources/app/api/utils/enableErrorHandlers';
import { enableAuthentication } from '../../../../../server/sources/app/api/utils/enableAuthentication';
import { enableMonitoring } from '../../../../../server/sources/app/api/utils/enableMonitoring';
import { enableOptionalStatics } from '../../../../../server/sources/app/api/utils/enableOptionalStatics';
import { registerAuthPingRoute } from '../../../../../server/sources/app/api/routes/auth/registerAuthPingRoute';
import { registerAccountApiTokenManagementRoutes } from '../../../../../server/sources/app/api/routes/auth/registerAccountApiTokenManagementRoutes';
import { registerAccountSecurityRoutes } from '../../../../../server/sources/app/api/routes/auth/registerAccountSecurityRoutes';
import { currentAccountStoredContentCompatibilitySocketAuth } from '../../../../../server/sources/app/api/testkit/accountStoredContentCompatibility';
import { auth } from '../../../../../server/sources/app/auth/auth';
import { db } from '../../../../../server/sources/storage/db';
import { getOrCreateServerIdentityId, initializeServerIdentityCache } from '../../../../../server/sources/app/serverIdentity/serverIdentity';
import { createCurrentMachineExecutionOriginContextResolver } from '../../../../../cli/src/api/machine/resolveCurrentMachineExecutionOriginContext';
import { isOriginalAccountExecutionAction } from '../../../../../server/sources/app/auth/externalActionExecutionAuthorization';
import { resolveMachineAdmission } from '../../../../../server/sources/app/machines/machineAccess';
import { accountRoutes } from '../../../../../server/sources/app/api/routes/account/accountRoutes';
import { sessionRoutes } from '../../../../../server/sources/app/api/routes/session/sessionRoutes';
import { sessionPendingRoutes } from '../../../../../server/sources/app/api/routes/session/pendingRoutes';
import { accessKeysRoutes } from '../../../../../server/sources/app/api/routes/accessKeys/accessKeysRoutes';
import { machinesRoutes } from '../../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { registerExternalActionRoutes } from '../../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import { featuresRoutes } from '../../../../../server/sources/app/api/routes/features/featuresRoutes';
import { artifactsRoutes } from '../../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import { createCredentialedAccountArtifactStore } from '../../../../../cli/src/api/artifacts/accountArtifactStore';
import { readSessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import { PromptDocArtifactHeaderV1Schema, PromptDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { startSocket } from '../../../../../server/sources/app/api/socket';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { TokenStorage, type HomeCredentialWriteRollback } from '@/auth/storage/tokenStorage';
import { removeServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { buildManualSessionCreationKey, executeSessionSpawnNewAction } from './sessionSpawnNewAction';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { SpawnCapabilitiesPreviewOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { EPHEMERAL_RUNNER_UNMATERIALIZED_MACHINE_ID_V1 } from '@happier-dev/protocol/ephemeralRunner/runnerMcpMaterial';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { writeMcpServerCatalogInContext } from '@/sync/api/account/apiMcpServerCatalog';
import { writePromptLibraryRecordInContext } from '@/sync/api/account/apiPromptLibraryCatalog';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';

// The two requester-custody slices omit a physical control listener. The full
// retained-runner case serves the actual daemon HTTP routes on an ephemeral port.
const composedControl = vi.hoisted(() => ({ real: false, port: 0, token: '' }));
vi.mock('../../../../../cli/src/daemon/controlServer', () => ({
    startDaemonControlServer: async (...args: Parameters<typeof import('../../../../../cli/src/daemon/controlServer')['startDaemonControlServer']>) => {
        if (!composedControl.real) return { port: 44322, stop: async () => {} };
        // The real listener imports SessionHostBridge too. Load it only after
        // collection settles, rather than self-waiting in an async mock factory.
        const actual = await vi.importActual<typeof import('../../../../../cli/src/daemon/controlServer')>(
            '../../../../../cli/src/daemon/controlServer');
        const control = await actual.startDaemonControlServer(...args);
        composedControl.port = control.port;
        composedControl.token = args[0].controlToken;
        return control;
    },
}));
const physicalRunner = vi.hoisted(() => ({ launch: null as null | ((args: string[], options: SpawnOptions) => ChildProcess) }));

describe('shared Machine spawn through the real UI, Home, daemon and SQLite owners', () => {
    let database: LightSqliteHarness;
    let app: AppFastify;
    let endpoint: string;
    let unavailableArtifactId: string | null = null;
    let unavailableArtifactReads = 0;
    let requiredAccountArtifactId: string | null = null;
    let requiredAccountArtifactReads = 0;
    let onRequiredAccountArtifactResponse: (() => void) | null = null;
    const sourceRuntimeFixtures: Array<Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>> = [];
    beforeAll(async () => {
        database = await createLightSqliteHarness({ tempDirPrefix: 'happier-r35-shared-spawn-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
        if (!await initializeServerIdentityCache()) throw new Error('Fixture Home identity did not initialize');
        // Each slice uses the same real Home and transport route.
        app = Fastify({ logger: false }) as unknown as AppFastify;
        app.addHook('onRequest', async (request, reply) => {
            if (requiredAccountArtifactId && request.method === 'GET'
                && request.url.split('?')[0] === `/v1/artifacts/${requiredAccountArtifactId}`) {
                requiredAccountArtifactReads += 1;
            }
            if (unavailableArtifactId && request.method === 'GET'
                && request.url.split('?')[0] === `/v1/artifacts/${unavailableArtifactId}`) {
                unavailableArtifactReads += 1;
                return await reply.code(503).send({ error: 'fixture_artifact_transport_unavailable' });
            }
        });
        app.addHook('onSend', async (request, reply, payload) => {
            if (requiredAccountArtifactId && request.method === 'GET' && reply.statusCode === 200
                && request.url.split('?')[0] === `/v1/artifacts/${requiredAccountArtifactId}`) {
                onRequiredAccountArtifactResponse?.();
            }
            if (request.method === 'POST' && /^\/v1\/sessions\/[^/]+\/turns\/mutations$/.test(request.url)) {
                const action = request.body && typeof request.body === 'object' ? Reflect.get(request.body, 'action') : null;
                const anchors = request.body && typeof request.body === 'object' ? Reflect.get(request.body, 'transcriptAnchors') : null;
                let response: unknown = null;
                try { if (typeof payload === 'string') response = JSON.parse(payload); } catch { /* Observation cannot change the response. */ }
                const code = response && typeof response === 'object' ? Reflect.get(response, 'code') : null;
                const applied = response && typeof response === 'object' ? Reflect.get(response, 'applied') : null;
                const receipt = response && typeof response === 'object' ? Reflect.get(response, 'receipt') : null;
                const decision = receipt && typeof receipt === 'object' ? Reflect.get(receipt, 'decision') : null;
                const observedAction = SessionTurnMutationActionV1Schema.safeParse(action);
                const observedDecision = SessionTurnMutationDecisionV1Schema.safeParse(decision);
                const observedMutation = SessionTurnMutationV1Schema.safeParse(request.body);
                console.info('SESSIONOPEN actual turn mutation outcome', JSON.stringify({
                    action: observedAction.success ? observedAction.data : null, statusCode: reply.statusCode,
                    code: typeof code === 'string' ? code : null,
                    applied: typeof applied === 'boolean' ? applied : null,
                    decision: observedDecision.success ? observedDecision.data : null,
                    hasStart: Boolean(anchors && typeof anchors === 'object' && typeof Reflect.get(anchors, 'startSeqInclusive') === 'number'),
                    hasEnd: Boolean(anchors && typeof anchors === 'object' && typeof Reflect.get(anchors, 'endSeqInclusive') === 'number'),
                    hasFinal: Boolean(anchors && typeof anchors === 'object' && typeof Reflect.get(anchors, 'finalAssistantMessageSeq') === 'number'),
                    schemaIssues: observedMutation.success ? [] : observedMutation.error.issues.map(issue => ({
                        code: issue.code, path: issue.path, message: issue.message,
                    })),
                }));
            }
            return payload;
        });
        enableSchemaValidation(app);
        enableErrorHandlers(app);
        enableAuthentication(app);
        enableMonitoring(app);
        enableOptionalStatics(app);
        registerAuthPingRoute(app);
        registerAccountApiTokenManagementRoutes(app);
        registerAccountSecurityRoutes(app);
        accountRoutes(app);
        featuresRoutes(app);
        artifactsRoutes(app);
        sessionRoutes(app);
        sessionPendingRoutes(app);
        accessKeysRoutes(app);
        machinesRoutes(app);
        startSocket(app);
        registerExternalActionRoutes(app);
        registerWorkflowRunStorageRoutes(app);
        endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    }, 180_000);
    afterAll(async () => {
        // These fixtures share the actual process-wide controller. Release
        // every suite lease before its owning fixture shuts that controller down.
        await Promise.all(sourceRuntimeFixtures.map(fixture => fixture.lease.release()));
        for (const fixture of sourceRuntimeFixtures) await fixture.dispose();
        await app?.close();
        if (database) await database.close();
    });

    it('previews a temporary-computer draft through the real UI Action and Account HTTP SQLite catalogs', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: endpoint, accountId: owner.id, currentAccount: true }],
            route: async request => fetch(request.url, { method: request.method, headers: request.headers,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }), signal: request.signal }) });
        onTestFinished(() => homes.dispose());
        const serverId = homes.homes.home!.id;
        await TokenStorage.setCredentialsForServerUrl(endpoint, { serverId }, { token });
        // This existing Home fixture supplies native storage; every Account request here reaches the real HTTP listener.
        setRuntimeFetch((input, init) => fetch(input, init));
        const account = await captureLazyActionAccountContext(serverId);
        onTestFinished(() => account.dispose());
        const created = await account.createArtifactDocument({ header: { v: 1, kind: 'prompt_bundle.v2', title: 'Review', bundleSchemaId: 'skills.skill_md_v1' },
            body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
                contentBase64: Buffer.from('---\nname: review\ndescription: Review changes\n---\nRead the changes.').toString('base64') }] }) });
        const skillId = created.artifactId;
        expect(await writePromptLibraryRecordInContext(account, { expectedRevision: 'absent', sourceSettingsVersion: 0,
            record: { key: 'skill-rules', value: { v: 1, rules: [{ id: 'review-everywhere', skillId, enabled: true,
                target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] } } })).toMatchObject({ status: 'updated' });
        expect(await writeMcpServerCatalogInContext(account, { expectedRevision: 'absent', sourceSettingsVersion: 0,
            catalog: McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'portable-server', name: 'portable',
                transport: 'http', remote: { url: 'https://portable.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 }],
                bindings: [{ id: 'portable-everywhere', serverId: 'portable-server', enabled: true,
                    target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] }) })).toMatchObject({ status: 'updated' });
        const preview = async (removed: boolean) => {
            const receipt = await createDefaultActionExecutor().execute('sessions.spawn.capabilities.preview', {
                machineId: EPHEMERAL_RUNNER_UNMATERIALIZED_MACHINE_ID_V1, agentId: 'codex',
                ...(removed ? { capabilitySelection: { skills: { forceExcludeSkillIds: [skillId] } } } : {}),
            }, { surface: 'ui', authority: 'present_user', serverId });
            return SpawnCapabilitiesPreviewOutputV1Schema.parse(receipt.ok ? receipt.result : undefined);
        };
        expect(await preview(false)).toMatchObject({ ok: true, machinePlatform: null,
            skills: { items: expect.arrayContaining([expect.objectContaining({ id: skillId, selected: true, reason: 'rule_on' })]) },
            mcp: { items: [expect.objectContaining({ id: 'portable-server', selected: true,
                preview: expect.objectContaining({ serverId: 'portable-server', portability: 'portable' }) })] } });
        expect(await preview(true)).toMatchObject({ ok: true,
            skills: { items: expect.arrayContaining([expect.objectContaining({ id: skillId, selected: false, reason: 'session_removed' })]) },
            mcp: { items: [expect.objectContaining({ id: 'portable-server', selected: true })] } });
        expect(await db.machine.count({ where: { accountId: owner.id } })).toBe(0);
    });

    it('admits the original requester resume Action without opening private raw spawn', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            installationId: crypto.randomUUID(), active: true,
            metadata: encodePlainMachineStoredContent({ host: 'r35-resume', platform: 'linux', happyCliVersion: '0.3',
                homeDir: database.baseDir, happyHomeDir: database.baseDir }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
        await db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: requester.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const actor = { actorAccountId: requester.id, machineId: machine.id };
        expect(await resolveMachineAdmission(actor)).toMatchObject({ kind: 'admitted', role: 'use' });
        expect({ originalAccountRoot: isOriginalAccountExecutionAction('session.open'),
            admission: await resolveMachineAdmission({ ...actor, actionId: 'session.open' }),
            raw: await resolveMachineAdmission({ ...actor, actionId: 'session.open', rpcMethod: RPC_METHODS.SPAWN_HAPPY_SESSION }) })
            .toMatchObject({ originalAccountRoot: true, admission: { kind: 'admitted', role: 'use' },
                raw: { kind: 'denied', code: 'unsupported_operation' } });
    });

    it.for([
        ['selected Claude birth', 'shared'],
        ['full isolated Claude host runtime', 'shared'],
        ['retained in-process Agent first reply', 'shared'],
        ['retained in-process Agent optional prompt unavailable', 'shared'],
        ['own-Account retained in-process Agent first reply', 'owner'],
        ['own-Account retained in-process Agent optional prompt unavailable', 'owner'],
        ['own-Account retained in-process Agent reply wiring sensitivity', 'owner'],
        ['own-Account retained in-process Agent late Account plan withdrawal', 'owner'],
    ] as const)(
        '%s preserves initial-input admission and native reply wiring', { timeout: DEFAULT_SESSION_SPAWN_OPERATION_TIMEOUT_MS }, async ([journey, requesterKind], context) => {
        const ownAccount = requesterKind === 'owner';
        const disconnectNativeReplyEvents = journey === 'own-Account retained in-process Agent reply wiring sensitivity';
        const withdrawPreparedAccountPlan = journey === 'own-Account retained in-process Agent late Account plan withdrawal';
        let accountPlanWithdrawals = 0;
        let withdrawalHookStage = 'unobserved';
        let observedWithdrawal: { code: string; reason: string } | null = null;
        const observeExpectedWithdrawal = (error: unknown) => {
            if (!withdrawPreparedAccountPlan || accountPlanWithdrawals !== 1 || !error || typeof error !== 'object'
                || Reflect.get(error, 'code') !== 'context_source_unavailable'
                || Reflect.get(error, 'reason') !== 'active-account-settings-changed') return false;
            observedWithdrawal = { code: 'context_source_unavailable', reason: 'active-account-settings-changed' };
            return true;
        };
        let withdrawalAccount: { scopeKey: string; lifetimeToken: number } | null = null;
        let withdrawalAdmittedCatalog: PromptLibraryCatalogSnapshotV1 | null = null;
        const retainedRunner = journey === 'retained in-process Agent first reply'
            || journey === 'retained in-process Agent optional prompt unavailable'
            || journey === 'own-Account retained in-process Agent first reply'
            || journey === 'own-Account retained in-process Agent optional prompt unavailable'
            || disconnectNativeReplyEvents || withdrawPreparedAccountPlan;
        // Windows startup cancellation invokes its exact OS process adapter.
        // A virtual runner sharing this worker's PID cannot prove that custody.
        if (retainedRunner && process.platform === 'win32') context.skip();
        const optionalPromptUnavailable = journey === 'retained in-process Agent optional prompt unavailable'
            || journey === 'own-Account retained in-process Agent optional prompt unavailable';
        unavailableArtifactId = null;
        unavailableArtifactReads = 0;
        requiredAccountArtifactId = null;
        requiredAccountArtifactReads = 0;
        onTestFinished(() => { unavailableArtifactId = null; });
        onTestFinished(() => { requiredAccountArtifactId = null; });
        const fullHostRuntime = journey !== 'selected Claude birth';
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const requester = ownAccount ? owner : await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ownerToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const requesterToken = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
        const outsiderToken = await auth.createToken(outsider.id, undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await getOrCreateServerIdentityId();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, active: true,
            metadata: encodePlainMachineStoredContent({ host: 'r35-host', platform: 'linux', happyCliVersion: '0.3',
                homeDir: database.baseDir, happyHomeDir: database.baseDir }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({
                sessionSpawn: { protocolVersions: [1, 2] },
                sessionInputAdmission: { protocolVersions: [1, 2] },
                externalActionExecutionAuthorization: { protocolVersions: [1] },
            }) } });
        if (!ownAccount) await db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: requester.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        let physicalLaunches = 0;
        let daemonReceipts = 0;
        let hostSpawnResult: unknown;
        let rejectChildStartup!: (error: unknown) => void;
        const childStartupFailure = new Promise<never>((_resolve, reject) => { rejectChildStartup = reject; });
        void childStartupFailure.catch(() => undefined);
        let apiMachine: ApiMachineClient | null = null;
        let runnerClient: ApiSessionClient | null = null;
        let requesterRuntime: RequesterSessionRuntimeContext | null = null;
        const readRunnerClient = () => runnerClient;
        const selectedServices = { v: 2 as const, bindingsByServiceId: fullHostRuntime ? {} : {
            'happier.agent.claude/claude-subscription': { source: 'team_resource' as const,
                resourceId: crypto.randomUUID(), deliveryMode: 'brokered' as const },
        } };
        const trackedSessions = new Map<number, TrackedSession>();
        const awaiters = new Map<number, (session: TrackedSession) => void>();
        const connectedServiceRegistry = new ConnectedServiceRuntimeRegistry();
        const runtimeId = crypto.randomUUID();
        const runnerStages: Array<{ stage: string; elapsedMs: number }> = [];
        let inProcessRunner: Awaited<ReturnType<typeof startInProcessAgentSessionRunner>> | null = null;
        const readInProcessRunner = () => inProcessRunner;
        const fixturePluginId = 'acme.native-runtime-proof';
        const fixtureLocalId = 'novel-native-agent';
        const fixtureEntrypoint = fileURLToPath(new URL('../../../../../cli/bin/happier.mjs', import.meta.url));
        if (fullHostRuntime) {
            // Declare the executable launcher at the OS boundary. Its virtual
            // child below runs current source in-process, not a built release.
            const previous = process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT;
            process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT = fixtureEntrypoint;
            onTestFinished(() => {
                if (previous === undefined) delete process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT;
                else process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT = previous;
            });
        }
        composedControl.real = retainedRunner;
        onTestFinished(() => { composedControl.real = false; });
        const startRunner = async (api: ApiClient, credentials: StoredCredentials, sessionId: string, attachPath: string) => {
            const baseSession = await createBaseSessionForAttach({ existingSessionId: sessionId,
                metadata: createTestMetadata(), state: { controlledByUser: false }, sessionAttachFilePath: attachPath });
            const client = await runWithServerHttpBaseUrl(endpoint, async () => createTestApiSessionClient(ApiSessionClient, credentials.token, baseSession, {
                // The simulated OS child receives this issued credential as its
                // persistence boundary input. Session transport/owners remain real.
                transport: { ...createAccountSessionClientTransport(credentials.token), resolveToken: async () => credentials.token },
                metadataAuthority: { kind: 'owner', credentials, readCurrentCredentials: async () => credentials },
                localMachineId: machine.id,
                getAccountEncryptionCurrentness: async () => await api.getAccountEncryptionCurrentness(),
                initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({
                    sessionId: baseSession.id, agentRuntimeApplicability: 'not_applicable',
                })], durableMutationDeliveryInitiallyActive: false,
            }));
            runnerClient = client;
            onTestFinished(async () => { await client.close(); });
            expect(await client.claimCurrentSessionPublisherAuthorityForStartup()).toEqual({ status: 'claimed' });
            await client.activateDurableMutationDelivery();
            return baseSession;
        };
        const spawnLifecycleHandler = createSpawnNewSessionLifecycleActionHandler({ serverId: homeId,
            spawnSession: async options => {
                // Both journeys receive the production-issued requester bootstrap.
                // Empty-service Claude consumes the complete host launch root; the selected-Claude
                // slice proves only installed ingress and committed birth/service carry.
                const bootstrap = options.requesterSessionBootstrap;
                if (retainedRunner) {
                    const result = await readDaemonRuntime().spawnSession(options);
                    hostSpawnResult = result;
                    return result;
                }
                expect(bootstrap?.attribution).toMatchObject({ accountId: requester.id, machineId: machine.id, serverId: homeId });
                if (!bootstrap || !options.sessionCreationTag) throw new Error('Missing requester spawn custody');
                expect(await bootstrap.isCurrent()).toBe(true);
                if (fullHostRuntime) {
                    const result = await readDaemonRuntime().spawnSession(options);
                    hostSpawnResult = result;
                    return result;
                }
                const api = await runWithServerHttpBaseUrl(endpoint, () => ApiClient.create(bootstrap.credentials));
                expect(options.connectedServices).toEqual(selectedServices);
                const committed = await runWithServerHttpBaseUrl(endpoint, () => commitDaemonLaunchSession({
                    api, credentials: bootstrap.credentials, options: { ...options,
                        runtimeDescriptorV1: RuntimeDescriptorV1Schema.parse({ v: 1, agentId: 'claude', agent: {} }),
                    }, directory: options.directory,
                }));
                expect(committed).toMatchObject({ ok: true });
                if (!committed.ok) throw new Error('Session creation did not settle');
                expect(committed.session.options.existingSessionId).toBe(committed.session.sessionId);
                expect(committed.session.attachPayload.snapshot?.ownerMetadata?.connectedServices?.connectedServices).toEqual(selectedServices);
                const attachFile = await createSessionAttachFile({ happySessionId: committed.session.sessionId,
                    payload: committed.session.attachPayload });
                onTestFinished(attachFile.cleanup);
                await startRunner(api, bootstrap.credentials, committed.session.options.existingSessionId!, attachFile.filePath);
                physicalLaunches += 1;
                return { type: 'success', sessionId: committed.session.sessionId,
                    sessionCreationOutcome: committed.session.sessionCreationOutcome };
            } });
        const transport = createMachineSessionDirectTargetTransport({ machineId: machine.id, spawnLifecycleHandler });
        const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({ path: join(database.baseDir, journey, 'device-local-key.json') });
        const report = createOnHappySessionWebhook({ pidToTrackedSession: trackedSessions, pidToAwaiter: awaiters, deviceLocalSecretStorage });
        const daemonHomeDir = retainedRunner ? join(database.baseDir, 'daemon', journey) : join(database.baseDir, 'daemon');
        const daemon: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: daemonHomeDir,
            activeServerDir: join(daemonHomeDir, 'servers', homeId), serverId: homeId, serverHttpBaseUrl: endpoint,
            machineId: machine.id, custodianAccountId: owner.id, credentials: { token: ownerToken, encryption: null },
            connectedServicesMaterializationBaseDir: join(database.baseDir, 'connected-services'), registry: connectedServiceRegistry,
            trackedSessions, pidToAwaiter: awaiters, getRequester: () => requesterRuntime, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
            getApiMachineForSessions: () => apiMachine,
            processEnv: { NODE_ENV: 'test', HAPPIER_CLAUDE_PATH: process.execPath,
                ...(fullHostRuntime ? { HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: fixtureEntrypoint } : {}),
                [resolveAgentCliOverrideEnvKey(`${fixturePluginId}/${fixtureLocalId}`)]: process.execPath },
            beforeStartup: async () => {
                if (!fullHostRuntime) return;
                if (retainedRunner) {
                    const fixtureRoot = new URL('../../../../../../packages/tests/fixtures/plugin-platform/agent-runtime-conformance/', import.meta.url);
                    const sourceManifest = PluginManifestV2Schema.parse(JSON.parse(await readFile(new URL('.happier-plugin/plugin.json', fixtureRoot), 'utf8')));
                    // Only the own-Account variant characterizes the nullable CLI
                    // contract. Shared rows retain the incumbent fixture exactly.
                    const manifest = ownAccount ? { ...sourceManifest, contributes: { ...sourceManifest.contributes,
                        agents: sourceManifest.contributes.agents.map(({ cli: _cli, ...agent }) => agent) } } : sourceManifest;
                    let agentRuntimeSource = await readFile(new URL('agent-runtime.mjs', fixtureRoot), 'utf8');
                    if (disconnectNativeReplyEvents) {
                        // A third-party Agent boundary subtraction: all real
                        // host/input/user/turn owners remain wired, but the
                        // ordinary native assistant event does not arrive.
                        const assistantEvent = "emit({ kind: 'message-delta', turnId: activeTurnId, channel: 'assistant', text: input.input.text });";
                        expect(agentRuntimeSource.split(assistantEvent)).toHaveLength(2);
                        agentRuntimeSource = agentRuntimeSource.replace(assistantEvent, '/* Native assistant event deliberately disconnected in this authored variant. */');
                        const committedAssistantEvent = [
                            '        emit({',
                            "          kind: 'transcript-message-committed',",
                            '          messageId: `${input.inputIds[0]}:assistant`,',
                            '          turnId: activeTurnId,',
                            "          role: 'assistant',",
                            '          text: input.input.text,',
                            '        });',
                        ].join('\n');
                        expect(agentRuntimeSource.split(committedAssistantEvent)).toHaveLength(2);
                        agentRuntimeSource = agentRuntimeSource.replace(committedAssistantEvent,
                            '/* Native committed assistant event deliberately disconnected in this authored variant. */');
                    }
                    const sourceRuntime = await createAuthoredAdmittedPluginRuntimeFixture({
                        happyHomeDir: daemonHomeDir, controller: pluginReloadController,
                        plugins: [{ manifest,
                            files: { 'daemon.mjs': await readFile(new URL('daemon.mjs', fixtureRoot), 'utf8'),
                                'agent-runtime.mjs': agentRuntimeSource } }],
                        runtimeOptions: { pluginIds: [fixturePluginId] },
                    });
                    sourceRuntimeFixtures.push(sourceRuntime);
                    await sourceRuntime.registry.activateContributionsOnDemand([
                        { pluginId: fixturePluginId, family: 'agents', localId: fixtureLocalId },
                    ]);
                    expect(sourceRuntime.registry.targetActivationFacts?.filter((fact: PluginTargetActivationFact) => fact.pluginId === fixturePluginId))
                        .toEqual(expect.arrayContaining([expect.objectContaining({ status: 'active' })]));
                    return;
                }
                const sourceRuntime = await createAdmittedPluginRuntimeFixture({
                    happyHomeDir: daemonHomeDir, controller: pluginReloadController,
                    runtimeOptions: { pluginIds: ['happier.agent.claude'] },
                });
                sourceRuntimeFixtures.push(sourceRuntime);
                await sourceRuntime.registry.activateContributionsOnDemand([
                    { pluginId: 'happier.agent.claude', family: 'agents', localId: 'claude' },
                ]);
            },
            startup: { resolveSessionSpawnDirectTargetTransport: () => transport,
                deviceLocalSecretStorage, onHappySessionWebhook: report,
                createRequesterSessionRuntimeContext: async bootstrap => {
                    if (bootstrap.serverHttpBaseUrl !== endpoint) return null;
                    bindRequesterSessionRuntimeMachineAdmissionCurrentness({ bootstrap, boundary: {
                        machineId: machine.id, daemonToken: ownerToken,
                        isHomeCurrent: () => configuration.activeServerId === homeId
                            && bootstrap.attribution.serverId === homeId
                            && bootstrap.attribution.machineId === machine.id,
                        readInstallation: readInstallationIdentityIfExistsSync,
                    } });
                    const context = await createRequesterSessionRuntimeContext({ bootstrap,
                        activeServerDir: join(daemonHomeDir, 'servers', homeId),
                        connectedServicesMaterializationBaseDir: join(database.baseDir, 'connected-services'),
                        resolveQualifiedConnectedAccountV4Support: () => 'advertised',
                        coordinatorInput: {
                            happyHomeDir: daemonHomeDir, machineId: machine.id,
                            machineIdProvider: () => machine.id, runtimeId, logger, processEnv: { NODE_ENV: 'test' },
                            pidToTrackedSession: trackedSessions, connectedServiceRuntimeRegistry: connectedServiceRegistry,
                            connectedServiceAuthGroupPreTurnSwitchCoordinator: readDaemonRuntime().connectedServiceAuthGroupPreTurnSwitchCoordinator,
                            connectedServicePredictiveSwitchGuard: readDaemonRuntime().connectedServicePredictiveSwitchGuard,
                            consumeCommittedAuthGroupGeneration: readDaemonRuntime().consumeCommittedAuthGroupGeneration,
                        },
                    });
                    requesterRuntime = context;
                    if (context) onTestFinished(context.dispose);
                    return context;
                },
                resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
                    serverUrl: endpoint, resolveCurrentMachineId: () => machine.id,
                }) } });
        onTestFinished(daemon.dispose);
        if (retainedRunner) {
            await mkdir(configuration.activeServerDir, { recursive: true });
            await writeCredentialsTokenOnly({ token: ownerToken });
            await updateSettings(settings => ({ ...settings, machineIdByServerId: {
                ...settings.machineIdByServerId, [homeId]: machine.id,
            }, machineIdByServerIdByAccountId: { ...settings.machineIdByServerIdByAccountId,
                [homeId]: { ...settings.machineIdByServerIdByAccountId?.[homeId], [owner.id]: machine.id } },
            lastTokenSubByServerId: { ...settings.lastTokenSubByServerId, [homeId]: owner.id },
            servers: { ...settings.servers, [homeId]: { id: homeId, name: 'Composed Home',
                serverUrl: endpoint, webappUrl: endpoint, createdAt: 1, updatedAt: 1, lastUsedAt: 1 } },
            }));
            await writeDaemonState({ pid: process.pid, httpPort: composedControl.port,
                controlToken: composedControl.token, startedAt: Date.now(), startedWithCliVersion: 'test' });
            const actualProcessIdentity = await readProcessIdentityByPid(process.pid);
            if (!actualProcessIdentity) throw new Error('Missing composed test process generation');
            const tsxHook = resolveTsxImportHookPath();
            if (!tsxHook) throw new Error('Missing current-source CLI runtime loader');
            // This is the virtual runner's loaded source process, not the
            // launcher's command. Keep process/snapshot recognition real.
            const launch = buildHappyCliSubprocessLaunchSpec(['daemon', 'start-sync'], {
                runtimeDecision: { runtime: 'node', argvPrefix: ['--import', tsxHook,
                    fileURLToPath(new URL('../../../../../cli/src/index.ts', import.meta.url))] },
            });
            const command = [launch.filePath, ...launch.args].join(' ');
            // Only the OS child identity is simulated. The daemon bearer,
            // source custody, open attestation and turn admission remain real.
            const readActualProcessIdentity = processIdentityBoundary.readProcessIdentityByPid;
            const identitySpy = vi.spyOn(processIdentityBoundary, 'readProcessIdentityByPid')
                .mockImplementation(async (pid, dependencies) => pid === process.pid
                    ? { ...actualProcessIdentity, command }
                    : await readActualProcessIdentity(pid, dependencies));
            onTestFinished(() => { identitySpy.mockRestore(); });
            const realKill = process.kill;
            const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
                if (signal !== 0) throw new Error('In-process runner attempted a real OS signal');
                return realKill(pid, signal);
            });
            onTestFinished(() => { killSpy.mockRestore(); });
            if (optionalPromptUnavailable || withdrawPreparedAccountPlan) {
                const store = createCredentialedAccountArtifactStore({ token: requesterToken, encryption: null });
                const created = await runWithServerHttpBaseUrl(endpoint, () => store.create({
                    header: PromptDocArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_doc.v2',
                        title: withdrawPreparedAccountPlan ? 'Required Account context' : 'Optional context' }),
                    body: JSON.stringify(PromptDocBodyV1Schema.parse({ v: 1,
                        markdown: withdrawPreparedAccountPlan ? 'Required Account context for this fixture' : 'Optional context',
                        createdAtMs: 0, updatedAtMs: 0 })),
                }));
                if (withdrawPreparedAccountPlan) requiredAccountArtifactId = created.artifactId;
                else unavailableArtifactId = created.artifactId;
            }
        }
        if (fullHostRuntime) {
            physicalRunner.launch = (_args, options) => {
                if (retainedRunner) {
                    const child = new ChildProcess();
                    const childCredentialEnvironment = new Map<string, string | undefined>();
                    Object.defineProperties(child, {
                        pid: { value: process.pid },
                        stderr: { value: new PassThrough() },
                        stdout: { value: new PassThrough() },
                    });
                    child.kill = () => true;
                    onTestFinished(async () => {
                        physicalRunner.launch = null;
                        try {
                            if (withdrawPreparedAccountPlan) console.info('SESSIONOPEN withdrawal cleanup', JSON.stringify({ stage: 'stop_started' }));
                            await inProcessRunner?.stop().catch(error => {
                                if (!observeExpectedWithdrawal(error)) throw error;
                            });
                            if (withdrawPreparedAccountPlan) console.info('SESSIONOPEN withdrawal cleanup', JSON.stringify({ stage: 'stop_settled' }));
                        }
                        finally {
                            for (const [key, previous] of childCredentialEnvironment) {
                                if (previous === undefined) delete process.env[key];
                                else process.env[key] = previous;
                            }
                        }
                    });
                    void Promise.resolve().then(async () => {
                        const sessionOptions = partitionProviderSessionArgs({ args: _args });
                        const attachPath = options.env?.HAPPIER_SESSION_ATTACH_FILE;
                        const bootstrapPath = options.env?.[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY];
                        const authorityPath = options.env?.[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY];
                        const credentialPath = options.env?.HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE;
                        const sessionId = options.env?.HAPPIER_SESSION_REQUESTER_SESSION_ID;
                        if (!bootstrapPath || !authorityPath)
                            throw new Error('Missing retained runner launch custody');
                        if ((!credentialPath || !sessionId) && !ownAccount)
                            throw new Error('Missing retained requester runner launch custody');
                        // These keys are also consumed by the real attach-ACK
                        // guard; passing file paths to the bridge alone is not
                        // an OS child environment.
                        for (const key of [HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY,
                            HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]) {
                            childCredentialEnvironment.set(key, process.env[key]);
                            process.env[key] = options.env![key];
                        }
                        // The virtual OS child retains its issued environment
                        // for all later credential-currentness reads, just as
                        // a separate child process does. Never install its token
                        // into the daemon's Account credential store.
                        let credentials: StoredCredentials | null;
                        if (credentialPath && sessionId) {
                            for (const [key, value] of [[REQUESTER_SESSION_ID_ENV, sessionId],
                                ['HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE', credentialPath]]) {
                                childCredentialEnvironment.set(key, process.env[key]);
                                process.env[key] = value;
                            }
                            credentials = await readRequesterSessionCredentialsForChild(credentialPath);
                        } else {
                            // Only the named own-Account scenario reads the
                            // fixture's actual persisted Account credential.
                            credentials = await readCredentials();
                        }
                        if (!credentials) throw new Error('Retained requester child credential was not admitted');
                        const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(bootstrapPath, 'utf8')));
                        inProcessRunner = await runWithServerHttpBaseUrl(endpoint, async () => {
                            const bootstrapSnapshot = await bootstrapAccountSettingsContext({ credentials, mode: 'fast' });
                            if (withdrawPreparedAccountPlan) {
                                if (!requiredAccountArtifactId) throw new Error('Missing required Account prompt Artifact');
                                const library = createCliPromptLibraryStore({ credentials });
                                const source = await library.readSourceSnapshot();
                                const written = await library.writeRecord({ expectedRevision: 'absent', sourceSettingsVersion: source.version,
                                    record: PromptLibraryRecordV1Schema.parse({ key: 'coding', value: {
                                        v: 1, scope: { kind: 'coding' }, entries: [{ id: 'required-account-context',
                                            ref: { kind: 'doc', artifactId: requiredAccountArtifactId }, enabled: true,
                                            required: true, placement: 'system_append' }],
                                    } }) });
                                expect(written.status).toBe('updated');
                                const writtenAccount = getActiveAccountSettingsSnapshot();
                                if (!writtenAccount?.scopeKey) throw new Error('Required Account prompt scope was not admitted');
                                withdrawalAdmittedCatalog = await refreshActivePromptLibraryCatalogAfterChange({ credentials,
                                    scopeKey: writtenAccount.scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() });
                            }
                            const activeSnapshot = withdrawPreparedAccountPlan ? getActiveAccountSettingsSnapshot() : null;
                            if (withdrawPreparedAccountPlan && !activeSnapshot) throw new Error('Required Account settings snapshot was not admitted');
                            // This is the settled active snapshot after the awaited catalog write, not a pending bootstrap refresh.
                            const snapshot = activeSnapshot ? { ...activeSnapshot, whenRefreshed: null } : bootstrapSnapshot;
                            if (withdrawPreparedAccountPlan) {
                                if (!snapshot?.scopeKey) throw new Error('Required Account prompt scope was not admitted');
                                withdrawalAccount = { scopeKey: snapshot.scopeKey,
                                    lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
                            }
                            if (!snapshot) throw new Error('Account settings snapshot was not admitted');
                            const accountSettingsContext = await resolveSessionStartAccountSettingsContext({ startedBy: 'daemon', snapshot });
                            return await startInProcessAgentSessionRunner({
                            backendId: bootstrap.descriptor.backendId,
                            agentTarget: { kind: 'agent', identity: { pluginId: fixturePluginId, localId: fixtureLocalId } },
                            happyHomeDir: configuration.happyHomeDir,
                            binding: buildPluginSessionBindingInput({ ...sessionOptions, credentials,
                                accountSettingsContext,
                                environmentVariables: Object.fromEntries(Object.entries(options.env ?? {})
                                    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
                                startedBy: 'daemon', directory: database.baseDir,
                                sessionAttachFilePath: attachPath, runtimeDescriptorV1: bootstrap.launch?.runtimeDescriptorV1 }),
                            bootstrapFilePath: bootstrapPath, authorityFilePath: authorityPath,
                            onSessionInitialized: ({ session }: { session: ApiSessionClient }) => {
                                runnerClient = session;
                            },
                            onStage: (stage, elapsedMs) => runnerStages.push({ stage, elapsedMs }),
                            });
                        });
                        void inProcessRunner.run.catch(error => {
                            console.info('SESSIONOPEN runner withdrawal', JSON.stringify({ journey,
                                code: error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined,
                                reason: error && typeof error === 'object' ? Reflect.get(error, 'reason') : undefined,
                            }));
                            if (!observeExpectedWithdrawal(error)) rejectChildStartup(error);
                        });
                        await inProcessRunner.ready;
                    }).catch(error => {
                        rejectChildStartup(error);
                        child.stderr?.emit('data', Buffer.from(String(error)));
                        child.emit('exit', 1, null);
                    });
                    return child;
                }
                const isolatedHome = options.env?.CLAUDE_CONFIG_DIR;
                expect(typeof isolatedHome === 'string'
                    && isCanonicalAbsolutePathInsideRoot(database.baseDir, isolatedHome)).toBe(true);
                // A harmless real child preserves process-generation and exit custody;
                // the external Agent executable and its output are simulated here.
                const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'pipe'] });
                onTestFinished(async () => {
                    physicalRunner.launch = null;
                    if (child.exitCode === null && child.signalCode === null) {
                        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
                        child.kill();
                        await exited;
                    }
                });
                void Promise.resolve().then(async () => {
                    const sessionId = options.env?.HAPPIER_SESSION_REQUESTER_SESSION_ID;
                    const attachPath = options.env?.HAPPIER_SESSION_ATTACH_FILE;
                    const credentialPath = options.env?.HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE;
                    const bootstrapPath = options.env?.[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY];
                    if (!sessionId || !attachPath || !credentialPath || !bootstrapPath || !child.pid)
                        throw new Error('Host launch dropped committed requester custody');
                    const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(bootstrapPath, 'utf8')));
                    expect(bootstrap.launch?.runtimeDescriptorV1?.agentId).toBe('claude');
                    const previous = process.env[REQUESTER_SESSION_ID_ENV];
                    let credentials: StoredCredentials | null;
                    try {
                        process.env[REQUESTER_SESSION_ID_ENV] = sessionId;
                        credentials = await readRequesterSessionCredentialsForChild(credentialPath);
                    } finally {
                        if (previous === undefined) delete process.env[REQUESTER_SESSION_ID_ENV];
                        else process.env[REQUESTER_SESSION_ID_ENV] = previous;
                    }
                    if (!credentials) throw new Error('Requester child credential was not admitted');
                    const api = await runWithServerHttpBaseUrl(endpoint, () => ApiClient.create(credentials));
                    const base = await startRunner(api, credentials, sessionId, attachPath);
                    await vi.waitFor(() => expect(awaiters.has(child.pid!)).toBe(true), { timeout: resolveSessionStartupTimeoutMs() });
                    const identity = await readProcessIdentityByPid(child.pid);
                    if (!identity) throw new Error('Child process generation unavailable');
                    await report(sessionId, { ...base.metadata, hostPid: child.pid,
                        hostProcessStartTimeMs: identity.processStartTimeMs });
                }).catch(error => {
                    child.stderr?.emit('data', Buffer.from(error instanceof Error ? error.message : String(error)));
                    child.kill();
                });
                return child;
            };
            // Native-required host modules can reach a second module identity
            // for the CLI helper. Intercept the actual OS boundary, identified
            // by the production-issued private runner bootstrap, not an
            // internal Session/runtime service. Other tooling spawns stay real.
            const realSpawn = childProcess.spawn;
            const osSpawn = vi.spyOn(childProcess, 'spawn').mockImplementation((command, argv, options) => {
                if (options?.env?.[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]) {
                    const controlIndex = argv.indexOf('--happy-starting-mode');
                    if (controlIndex < 1 || !physicalRunner.launch) throw new Error('Unexpected runner OS launch');
                    physicalLaunches += 1;
                    return physicalRunner.launch(Array.from(argv).slice(controlIndex - 1), options);
                }
                return realSpawn(command, argv, options);
            });
            syncBuiltinESMExports();
            onTestFinished(() => { osSpawn.mockRestore(); syncBuiltinESMExports(); });
        }
        function readDaemonRuntime() {
            if (!daemon.runtime) throw new Error('Missing installed daemon runtime');
            return daemon.runtime;
        }
        const daemonRuntime = readDaemonRuntime();
        if (!daemon.installation || !daemonRuntime.externalActionIngressOwner) throw new Error('Missing installed production Action ingress');
        const installation = daemon.installation;
        await db.machine.update({ where: { id: machine.id }, data: { installationId: installation.installationId,
            installationPublicKey: new Uint8Array(decodeBase64(installation.publicKey, 'base64url')) } });
        // Canonical registrar erases request generics at the Socket.IO boundary; the real registered handler validates its packet.
        const handlers = new Map<string, RpcHandler>();
        const registerHandler: RpcHandlerRegistrar['registerHandler'] = (method, handler) => { handlers.set(method, handler); };
        registerExternalActionRpcHandler({ registerHandler }, {
            ...daemonRuntime.externalActionIngressOwner,
            machineId: machine.id, resolveAccountId: async () => owner.id, resolveInstallationId: () => installation.installationId,
            verifyExecutionAuthorization: async (input: Parameters<VerifyExternalActionExecutionAuthorization>[0]) => {
                const { verifyExternalActionExecutionAuthorizationCurrent } = await import('../../../../../cli/src/api/externalActionExecutionAuthorization');
                return await verifyExternalActionExecutionAuthorizationCurrent({ ...input, serverHttpBaseUrl: endpoint,
                    installationId: installation.installationId, privateKey: installation.privateKey });
            },
        });
        const socket = io(endpoint, { path: '/v1/updates', transports: ['websocket'], reconnection: false, autoConnect: false,
            auth: { ...currentAccountStoredContentCompatibilitySocketAuth, token: ownerToken, clientType: 'machine-scoped', machineId: machine.id, installationId: installation.installationId,
                installationPublicKey: installation.publicKey, installationProof: signMachineInstallationProof({
                    payload: { version: 1, installationId: installation.installationId, machineId: machine.id, accountId: owner.id },
                    privateKey: installation.privateKey }) } });
        onTestFinished(() => { socket.disconnect(); });
        const ownerApi = await runWithServerHttpBaseUrl(endpoint, () => ApiClient.create({ token: ownerToken, encryption: null }));
        const publishedMachine = await runWithServerHttpBaseUrl(endpoint, () => ownerApi.getMachine(machine.id));
        if (!publishedMachine) throw new Error('Machine read did not settle');
        apiMachine = await runWithServerHttpBaseUrl(endpoint, async () => ownerApi.machineSyncClient(publishedMachine));
        const currentApiMachine = apiMachine;
        onTestFinished(async () => { await currentApiMachine.shutdown(); });
        // Only inject the genuine Socket.IO transport boundary; the signing and
        // enqueueSessionPendingByMachine producer execute unchanged on the real instance.
        (apiMachine as unknown as { socket: typeof socket }).socket = socket;
        socket.on(SOCKET_RPC_EVENTS.REQUEST, (request: SocketRpcRequestPayload, acknowledge: (reply: unknown) => void) => {
            daemonReceipts += 1;
            const carried = ExternalActionDaemonDispatchRequestSchema.parse(request.params);
            expect(carried.envelope.v).toBe(1);
            if (carried.envelope.v !== 1) throw new Error('Expected the original plaintext fixture envelope');
            if (!retainedRunner) {
                expect(carried.executionAuthorization?.binding.accountEncryptionMode).toBe('plain');
                expect(carried.executionAuthorization?.binding.requestEnvelopeDigest)
                    .toBe(computeExternalActionRequestEnvelopeDigestV1(carried.envelope));
                expect(carried.executionAuthorization?.binding.accountId).toBe(carried.principal.accountId);
            } else {
                expect(carried.principal.accountId).toBe(requester.id);
                expect(SessionSpawnNewInputV2Schema.parse(carried.envelope.input).agentTarget?.identity.pluginId).toBe(fixturePluginId);
            }
            const binding = carried.executionAuthorization?.binding;
            if ('authentication' in carried.principal && binding && 'authentication' in binding) expect(sameStrictJsonValue(
                binding.authentication, carried.principal.authentication)).toBe(true);
            const handler = handlers.get(request.method.slice(machine.id.length + 1));
            if (!handler) { acknowledge({ error: 'method_not_available' }); return; }
            void Promise.resolve(handler(request.params, { signal: new AbortController().signal,
                authorization: request.authorization })).then(acknowledge,
                    () => acknowledge({ error: 'daemon_effect_failed' }));
        });
        let homes: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
        let realCredentials: HomeCredentialWriteRollback | null = null;
        let learnedProfileId: string | undefined;
        let homeCleanup: Promise<void> | undefined;
        const disposeHomes = () => homeCleanup ??= (async () => {
            if (realCredentials && !await realCredentials.rollback()) throw new Error('Requester token rollback failed');
            await homes?.dispose();
            if (learnedProfileId) await removeServerProfile(learnedProfileId);
            else if (homes?.homes.home) await removeServerProfile(homes.homes.home.id);
        })();
        onTestFinished(disposeHomes);
        const httpResults: Array<{ path: string; status: number; code?: string }> = [];
        try {
            await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
            await new Promise<void>(resolve => {
                socket.once(SOCKET_RPC_EVENTS.REGISTERED, () => resolve());
                socket.emit(SOCKET_RPC_EVENTS.REGISTER, { method: `${machine.id}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}` });
            });
            homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: endpoint, accountId: requester.id, currentAccount: true }],
                route: async request => {
                    if (request.url.pathname.startsWith('/v1/actions/session.spawn_new')) {
                        const wrapped = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(request.body);
                        const envelope = retainedRunner && request.url.pathname === '/v1/actions/session.spawn_new' && !wrapped.success
                            ? ExternalActionRequestEnvelopeV1Schema.parse(request.body)
                            : ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.body).envelope;
                        expect(envelope.v).toBe(1);
                    }
                    const method = request.method;
                    if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'PATCH'
                        && method !== 'DELETE' && method !== 'HEAD' && method !== 'OPTIONS') throw new Error('Unsupported fixture HTTP method');
                    const response = await app.inject({ method, url: request.url.pathname + request.url.search,
                        headers: Object.fromEntries(request.headers), ...(request.body === undefined ? {} : { payload: JSON.stringify(request.body) }) });
                    const error = response.statusCode >= 400 ? response.json() : null;
                    httpResults.push({ path: request.url.pathname, status: response.statusCode,
                        ...(typeof error?.code === 'string' ? { code: error.code } : {}) });
                    return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
                } });
            const learnedProfile = await setServerProfileIdentityForUrl(endpoint, homeId);
            expect(learnedProfile).not.toBeNull();
            if (!learnedProfile) throw new Error('Home identity was not learned');
            learnedProfileId = learnedProfile.id;
            realCredentials = await TokenStorage.setCredentialsForServerUrlWithRollback(endpoint,
                { serverId: learnedProfile.id }, { token: requesterToken });
            if (!realCredentials) throw new Error('Could not store the real requester token');
            const requestId = crypto.randomUUID();
            const creationKey = buildManualSessionCreationKey(requestId);
            const input = { ...SessionSpawnNewInputV2Schema.parse({ creationKey,
                executionTarget: { serverId: homeId, machineId: machine.id }, directory: { kind: 'path', path: database.baseDir },
                connectedServices: selectedServices,
                ...(unavailableArtifactId ? { promptStack: [{ id: 'optional-context', ref: { kind: 'doc', artifactId: unavailableArtifactId },
                    enabled: true, placement: 'system_append', required: false }] } : {}),
                initialInput: { text: retainedRunner ? 'packed daemon-child bridge' : 'Reply with recipient input accepted.' },
                agentTarget: { kind: 'agent', identity: retainedRunner
                    ? { pluginId: fixturePluginId, localId: fixtureLocalId }
                    : { pluginId: 'happier.agent.claude', localId: 'claude' } } }), creationKey };
            const initialInputText = input.initialInput?.text;
            if (typeof initialInputText !== 'string') throw new Error('Missing authored fixture input text');
            if (withdrawPreparedAccountPlan) {
                // Retire the actual Settings fact while the required document
                // response is in flight, before native open or input custody
                // can commit a user transcript. The Home and reader stay real.
                onRequiredAccountArtifactResponse = () => {
                    if (accountPlanWithdrawals !== 0) return;
                    try {
                        withdrawalHookStage = 'required_artifact_read';
                        expect(requiredAccountArtifactReads).toBeGreaterThan(0);
                        const current = getActiveAccountSettingsSnapshot();
                        withdrawalHookStage = 'account_present';
                        if (!withdrawalAccount || !current || !withdrawalAdmittedCatalog)
                            throw new Error('Prepared Account prompt catalog was not observed');
                        withdrawalHookStage = 'account_scope';
                        expect(current.scopeKey).toBe(withdrawalAccount.scopeKey);
                        withdrawalHookStage = 'account_lifetime';
                        expect(getActiveAccountSettingsSnapshotLifetimeToken()).toBe(withdrawalAccount.lifetimeToken);
                        // Current global catalogue maintenance cannot replace
                        // the admission facts retained by this preparation.
                        const coding = readPromptLibraryCatalogRecordV1({ catalog: withdrawalAdmittedCatalog, key: 'coding' });
                        withdrawalHookStage = 'coding_inventory';
                        expect(coding).toMatchObject({ status: 'ready', record: { key: 'coding', value: {
                            entries: [expect.objectContaining({ required: true,
                                ref: { kind: 'doc', artifactId: requiredAccountArtifactId } })],
                        } } });
                        // Catalogue-only refresh retains this admitted dispatch;
                        // the negative must retire a fact that owns its policy.
                        const rawSettings = { ...current.rawSettings, codingPromptBehaviorV1: {
                            ...current.settings.codingPromptBehaviorV1,
                            sessionTitleUpdates: current.settings.codingPromptBehaviorV1.sessionTitleUpdates === 'disabled'
                                ? 'ongoing' : 'disabled',
                        } };
                        withdrawalHookStage = 'settings_publication';
                        expect(commitActiveAccountSettingsSnapshot({ ...current, rawSettings,
                            settings: accountSettingsParse(rawSettings), settingsVersion: current.settingsVersion + 1,
                        }).didCommit).toBe(true);
                        accountPlanWithdrawals += 1;
                        withdrawalHookStage = 'published';
                        console.info('SESSIONOPEN withdrawal publication', JSON.stringify({ reason: 'settings-changed', accountPlanWithdrawals }));
                    } catch (error) {
                        // A fixture assertion must not disappear inside the real
                        // transport's unavailable handling and become a five-minute wait.
                        rejectChildStartup(new Error(`Late withdrawal fixture hook failed at ${withdrawalHookStage}`));
                        throw error;
                    }
                };
                onTestFinished(() => { onRequiredAccountArtifactResponse = null; });
            }
            const openStartedAt = performance.now();
            const openStartedAtMs = Date.now();
            if (retainedRunner) console.info('SESSIONOPEN composed open started', { journey, openStartedAtMs });
            const outcome = retainedRunner ? await Promise.race([childStartupFailure, (async () => {
                // The shared recipient's Account Action enters the same real
                // installed ingress and retained runner as the composer path.
                const account = await captureLazyActionAccountContext(learnedProfile.id);
                try {
                    const execution = await executeOriginalAccountMachineAction({ account,
                        actionId: 'session.spawn_new', requestId, machineId: machine.id, input, authority: 'present_user' });
                    return execution.ok ? { ok: true as const, result: SessionSpawnNewResultV1Schema.parse(execution.result) } : execution;
                } finally { account.dispose(); }
            })()]) : await executeSessionSpawnNewAction(input, {
                surface: 'ui', authority: 'present_user', actionRequestId: requestId,
            }, createDefaultActionExecutor());
            expect(outcome, JSON.stringify({ outcome, httpResults, physicalLaunches, daemonReceipts, hostSpawnResult }))
                .toMatchObject({ ok: true, result: { type: 'success' } });
            if (!outcome.ok || outcome.result.type !== 'success') throw new Error('Spawn was not committed');
            const spawnResult = outcome.result;
            expect(SessionSpawnNewResultV1Schema.parse(outcome.result)).toMatchObject({ executionTarget: input.executionTarget });
            expect(outcome.result.initialInput).toMatchObject({ status: 'accepted' });
            // Creation rejoin can observe the committed Session before the
            // outstanding daemon launch reports readiness. Observe that same
            // root's completed startup, not just the early birth fact.
            if (fullHostRuntime) {
                await Promise.race([childStartupFailure, vi.waitFor(() => {
                    expect(hostSpawnResult).toBeDefined();
                }, { timeout: resolveSessionStartupTimeoutMs() })]);
                expect(hostSpawnResult, JSON.stringify(hostSpawnResult)).toMatchObject({ type: 'success', sessionId: outcome.result.sessionId });
                expect(physicalLaunches).toBe(1);
            }
            if (retainedRunner) {
                // The daemon ACK precedes the host's initialized callback.
                // Join that real runner stage before inspecting its client.
                const child = readInProcessRunner();
                if (!child) throw new Error('Missing physically launched retained runner');
                await Promise.race([childStartupFailure, child.ready]);
            }
            const currentRunner = readRunnerClient();
            if (!currentRunner) throw new Error('Missing requester runner');
            if (retainedRunner) {
                expect(await currentRunner.ensureMetadataSnapshot({ timeoutMs: resolveSessionStartupTimeoutMs() }))
                    .toMatchObject({ runtimeDescriptorV1: { agentId: `${fixturePluginId}/${fixtureLocalId}` } });
                const acceptedInput = outcome.result.initialInput;
                if (acceptedInput.status !== 'accepted') throw new Error('Runner input lacks committed admission identity');
                const acceptedInputLocalId = acceptedInput.localId;
                if (!acceptedInputLocalId) throw new Error('Runner input lacks its exact local identity');
                if (withdrawPreparedAccountPlan) {
                    let observedTurns: Array<{ status: string; code?: string; source?: string }> = [];
                    try {
                        await Promise.race([childStartupFailure, vi.waitFor(async () => {
                            const turns = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/turns`,
                                headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                            expect(turns.statusCode).toBe(200);
                            const projection = SessionTurnsProjectionV1Schema.parse(turns.json());
                            observedTurns = projection.turns.map(turn => ({ status: turn.status,
                                ...(turn.lastRuntimeIssue ? { code: turn.lastRuntimeIssue.code, source: turn.lastRuntimeIssue.source } : {}) }));
                            expect(accountPlanWithdrawals).toBe(1);
                            expect(observedWithdrawal).toEqual({ code: 'context_source_unavailable', reason: 'active-account-settings-changed' });
                            expect(projection.turns).toEqual(expect.arrayContaining([
                                expect.objectContaining({ status: 'failed', lastRuntimeIssue: expect.objectContaining({
                                    code: 'preparation_pending', source: 'dependency_failure',
                                }) }),
                            ]));
                            expect(projection.turns.some(turn => turn.status === 'completed')).toBe(false);
                        }, { timeout: resolveSessionStartupTimeoutMs() })]);
                    } catch (error) {
                        console.info('SESSIONOPEN late withdrawal diagnostics', JSON.stringify({
                            accountPlanWithdrawals, requiredAccountArtifactReads, withdrawalHookStage,
                            withdrawal: observedWithdrawal, turns: observedTurns,
                            runnerStages,
                        }));
                        throw error;
                    }
                    await currentRunner.flushDurableMutationDelivery();
                    expect(currentRunner.getCommittedUserMessageSeq(acceptedInputLocalId)).toBeNull();
                    expect(await db.sessionMessage.findUnique({ where: { sessionId_localId: {
                        sessionId: currentRunner.sessionId, localId: acceptedInputLocalId,
                    } } })).toBeNull();
                    const transcript = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/messages`,
                        headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                    expect(transcript.statusCode).toBe(200);
                    expect(transcript.json().messages).not.toEqual(expect.arrayContaining([
                        expect.objectContaining({ messageRole: 'user' }),
                    ]));
                    expect(transcript.json().messages.some((row: { messageRole: string; content: unknown }) =>
                        row.messageRole === 'agent' && JSON.stringify(row.content).includes(initialInputText))).toBe(false);
                    expect(physicalLaunches).toBe(1);
                    expect(daemonReceipts).toBe(1);
                    console.info('SESSIONOPEN withdrawal verified', JSON.stringify({ turns: observedTurns,
                        requiredAccountArtifactReads, withdrawalHookStage }));
                    return;
                }
                if (disconnectNativeReplyEvents) {
                    await Promise.race([childStartupFailure, vi.waitFor(async () => {
                        const transcript = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/messages`,
                            headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                        expect(transcript.statusCode).toBe(200);
                        expect(transcript.json().messages).toEqual(expect.arrayContaining([
                            expect.objectContaining({ messageRole: 'user', content: { t: 'plain', v: expect.objectContaining({
                                content: { type: 'text', text: initialInputText },
                            }) } }),
                        ]));
                    }, { timeout: resolveSessionStartupTimeoutMs() })]);
                    const committedUser = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                        sessionId: currentRunner.sessionId, localId: acceptedInputLocalId,
                    } } });
                    await vi.waitFor(async () => {
                        const turns = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/turns`,
                            headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                        expect(turns.statusCode).toBe(200);
                        expect(SessionTurnsProjectionV1Schema.parse(turns.json()).turns).toEqual(expect.arrayContaining([
                            expect.objectContaining({ status: 'completed', transcriptAnchors: expect.objectContaining({
                                startUserMessageSeq: committedUser.seq, userMessageSeqs: [committedUser.seq],
                            }) }),
                        ]));
                    }, { timeout: resolveSessionStartupTimeoutMs() });
                    const terminalTranscript = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/messages`,
                        headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                    expect(terminalTranscript.statusCode).toBe(200);
                    expect(terminalTranscript.json().messages).not.toEqual(expect.arrayContaining([
                        expect.objectContaining({ messageRole: 'agent', content: { t: 'plain', v: expect.objectContaining({
                            content: expect.objectContaining({ data: expect.objectContaining({
                                message: expect.stringContaining(initialInputText),
                            }) }),
                        }) } }),
                    ]));
                    expect(runnerStages.some(({ stage }) => stage === 'runner_settled')).toBe(false);
                    console.info('SESSIONOPEN reply wiring sensitivity', JSON.stringify({ journey,
                        nativeAssistantEvent: 'disconnected', userMessageSeq: committedUser.seq,
                        turnStatus: 'completed', matchingAssistantReply: false }));
                    return;
                }
                let firstReplyStoredCreatedAtMs: number | null = null;
                let firstReplyStoredMessageId: string | null = null;
                // The host's completion contract waits for transcript ACKs.
                // Once this turn settles, missing required output is a failure,
                // not a future row to poll for after terminal admission.
                await Promise.race([childStartupFailure, vi.waitFor(async () => {
                    const turns = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/turns`,
                        headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                    expect(turns.statusCode).toBe(200);
                    const projection = SessionTurnsProjectionV1Schema.parse(turns.json());
                    expect(projection.turns).toHaveLength(1);
                    expect(projection.turns[0]?.status).not.toBe('in_progress');
                }, { timeout: resolveSessionStartupTimeoutMs() })]);
                const settled = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/turns`,
                    headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                expect(SessionTurnsProjectionV1Schema.parse(settled.json()).turns[0]).toMatchObject({ status: 'completed' });
                // Only read the resulting transcript. Pending consumption, native
                // send, lifecycle, transcript commit and turn anchors come from
                // the production host runner, never test orchestration.
                await Promise.race([childStartupFailure, (async () => {
                    const transcript = await app.inject({ method: 'GET', url: `/v1/sessions/${spawnResult.sessionId}/messages`,
                        headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                    expect(transcript.statusCode).toBe(200);
                    expect(transcript.json().messages).toEqual(expect.arrayContaining([
                        expect.objectContaining({ messageRole: 'user', content: { t: 'plain', v: expect.objectContaining({
                            content: { type: 'text', text: initialInputText },
                        }) } }),
                        expect.objectContaining({ messageRole: 'agent', content: { t: 'plain', v: expect.objectContaining({
                            content: expect.objectContaining({ data: expect.objectContaining({
                                message: expect.stringContaining(initialInputText),
                            }) }),
                        }) } }),
                    ]));
                    const rows: unknown = transcript.json().messages;
                    if (Array.isArray(rows)) {
                        const reply = rows.find(row => row && typeof row === 'object'
                            && Reflect.get(row, 'messageRole') === 'agent'
                            && JSON.stringify(Reflect.get(row, 'content')).includes(initialInputText));
                        const createdAt = reply && typeof reply === 'object' ? Reflect.get(reply, 'createdAt') : null;
                        firstReplyStoredCreatedAtMs = typeof createdAt === 'number' ? createdAt : null;
                        const messageId = reply && typeof reply === 'object' ? Reflect.get(reply, 'id') : null;
                        firstReplyStoredMessageId = typeof messageId === 'string' ? messageId : null;
                    }
                })()]);
                const openToFirstReplyObservedMs = performance.now() - openStartedAt;
                const committedUser = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                    sessionId: currentRunner.sessionId, localId: acceptedInputLocalId,
                } } });
                if (!firstReplyStoredMessageId) throw new Error('Committed assistant reply lacks its server transcript identity');
                const committedReply = await db.sessionMessage.findUniqueOrThrow({ where: { id: firstReplyStoredMessageId } });
                expect(committedReply.sessionId).toBe(currentRunner.sessionId);
                expect(committedReply.localId).toBe(`${acceptedInputLocalId}:assistant`);
                expect(committedUser.messageRole).toBe('user');
                expect(committedReply.messageRole).toBe('agent');
                console.info('SESSIONOPEN composed timings', JSON.stringify({
                    journey, entry: 'executeOriginalAccountMachineAction/session.spawn_new',
                    openToFirstReplyObservedMs, openStartedAtMs, firstReplyStoredCreatedAtMs,
                    openToFirstReplyStoredCreatedMs: firstReplyStoredCreatedAtMs === null ? null : firstReplyStoredCreatedAtMs - openStartedAtMs,
                    runnerStages,
                }));
                const initialTurns = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/turns`,
                    headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                console.info('SESSIONOPEN actual turn projection', JSON.stringify({ journey,
                    statusCode: initialTurns.statusCode, projection: initialTurns.json(),
                    committedUserSeq: committedUser.seq, committedReplySeq: committedReply.seq,
                    assistantIsMainChain: committedReply.sidechainId === null }));
                // Completion follows transcript commit. Read the canonical
                // strict projection and require anchors for these exact rows.
                await vi.waitFor(async () => {
                    const turns = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/turns`,
                        headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                    expect(turns.statusCode).toBe(200);
                    expect(SessionTurnsProjectionV1Schema.parse(turns.json()).turns).toEqual(expect.arrayContaining([
                        expect.objectContaining({ status: 'completed', transcriptAnchors: expect.objectContaining({
                            startUserMessageSeq: committedUser.seq, userMessageSeqs: [committedUser.seq],
                            startSeqInclusive: committedUser.seq, endSeqInclusive: committedReply.seq,
                            finalAssistantMessageSeq: committedReply.seq,
                        }) }),
                    ]));
                }, { timeout: resolveSessionStartupTimeoutMs() });
                expect(await db.session.findUniqueOrThrow({ where: { id: outcome.result.sessionId } }))
                    .toMatchObject({ accountId: requester.id });
                if (optionalPromptUnavailable) {
                    expect(unavailableArtifactReads).toBeGreaterThan(0);
                    const transcript = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/messages`,
                        headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                    const notices = transcript.json().messages.flatMap((row: { content: unknown }) => {
                        const stored = SessionStoredMessageContentSchema.parse(row.content);
                        if (typeof stored === 'string' || stored.t !== 'plain') return [];
                        const event = stored.v && typeof stored.v === 'object' && 'content' in stored.v ? stored.v.content : null;
                        const data = event && typeof event === 'object' && 'data' in event ? event.data : null;
                        return readSessionCapabilityNoticeV1(data)?.items ?? [];
                    });
                    expect(notices).toContainEqual({ kind: 'prompt_library', name: 'Prompt library', code: 'prompt_library_unavailable' });
                    expect(JSON.stringify(notices)).not.toContain(unavailableArtifactId);
                    expect(JSON.stringify(notices)).not.toContain(ownerToken);
                }
                expect(physicalLaunches).toBe(1);
                expect(daemonReceipts).toBe(1);
                return;
            }
            const consumed = await currentRunner.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
            expect(consumed).toMatchObject({ type: 'materialized' });
            if (consumed.type !== 'materialized') throw new Error('Initial input was not consumed');
            const storedPrompt = SessionStoredMessageContentSchema.parse(consumed.content);
            if (typeof storedPrompt === 'string' || storedPrompt.t !== 'plain') throw new Error('Expected Plain requester input');
            expect(storedPrompt.t).toBe('plain');
            const prompt = UserMessageSchema.parse(storedPrompt.v);
            expect(prompt.content).toEqual({ type: 'text', text: initialInputText });
            const provider = 'claude';
            const turnId = `session-turn:${crypto.randomUUID()}`;
            const replyId = `${consumed.localId}:assistant`;
            const lifecycle = createSessionTurnLifecycle({ session: currentRunner, agentId: provider,
                readTurnFacts: () => ({ initiator: 'user', workDepth: 0 }) });
            lifecycle.observeRuntimeEvent(AgentSessionRuntimeEventSchema.parse({ sequence: 1,
                sessionId: currentRunner.sessionId, emittedAtMs: Date.now(), kind: 'turn-start', turnId, startedBy: 'host' }));
            await lifecycle.drainAcceptedLifecycle();
            // Current pending admission can return seq:null until the external
            // Agent acknowledges this claimed prompt into the transcript.
            expect(await projectRuntimeTranscriptEvent({ session: currentRunner, provider,
                event: AgentSessionRuntimeEventSchema.parse({ sequence: 2, sessionId: currentRunner.sessionId,
                    emittedAtMs: Date.now(), kind: 'transcript-message-committed', turnId,
                    messageId: consumed.localId, role: 'user', text: prompt.content.text }),
            })).toEqual({ projected: true, kind: 'transcript-message-committed' });
            const committedUser = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                sessionId: currentRunner.sessionId, localId: consumed.localId,
            } } });
            // The external Agent responds to this consumed prompt. Its strict event
            // enters the production transcript projector on the same primary turn.
            expect(await projectRuntimeTranscriptEvent({ session: currentRunner, provider,
                event: AgentSessionRuntimeEventSchema.parse({ sequence: 3, sessionId: currentRunner.sessionId,
                    emittedAtMs: Date.now(), kind: 'transcript-message-committed', turnId,
                    messageId: replyId, role: 'assistant', text: 'recipient input accepted' }),
            })).toEqual({ projected: true, kind: 'transcript-message-committed' });
            const transcript = await app.inject({ method: 'GET', url: `/v1/sessions/${outcome.result.sessionId}/messages`,
                headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
            expect(transcript.statusCode).toBe(200);
            expect(transcript.json().messages).toEqual(expect.arrayContaining([
                expect.objectContaining({ messageRole: 'user', content: { t: 'plain', v: expect.objectContaining({
                    content: { type: 'text', text: initialInputText },
                }) } }),
                expect.objectContaining({ messageRole: 'agent', content: { t: 'plain', v: expect.objectContaining({
                    content: expect.objectContaining({ data: { type: 'message', message: 'recipient input accepted' } }),
                }) } }),
            ]));
            const reply = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                sessionId: currentRunner.sessionId, localId: replyId,
            } } });
            // Test orchestration supplies causal transcript anchors using the
            // public turn mutation owner; this is not Agent-native anchor evidence.
            await currentRunner.enqueueSessionTurnMutation({ v: 1, sessionId: currentRunner.sessionId,
                mutationId: crypto.randomUUID(), observedAt: Date.now(), agentId: provider,
                action: 'append_transcript_anchors', turnId, transcriptAnchors: {
                    startUserMessageSeq: committedUser.seq, userMessageSeqs: [committedUser.seq],
                    startSeqInclusive: committedUser.seq, endSeqInclusive: reply.seq, finalAssistantMessageSeq: reply.seq,
                } });
            // Anchors are admitted while the turn is active. The retained
            // runner cases supply them through the actual host terminal owner.
            lifecycle.observeRuntimeEvent(AgentSessionRuntimeEventSchema.parse({ sequence: 4,
                sessionId: currentRunner.sessionId, emittedAtMs: Date.now(), kind: 'turn-complete', turnId }));
            await lifecycle.drainAcceptedLifecycle();
            await currentRunner.flushDurableMutationDelivery();
            const turns = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/turns`,
                headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
            expect(turns.statusCode).toBe(200);
            expect(turns.json().turns).toEqual(expect.arrayContaining([expect.objectContaining({ turnId,
                status: 'completed', transcriptAnchors: expect.objectContaining({ startUserMessageSeq: committedUser.seq,
                    finalAssistantMessageSeq: reply.seq }) })]));
            expect(await db.session.findUniqueOrThrow({ where: { id: outcome.result.sessionId } })).toMatchObject({ accountId: requester.id });
            expect(physicalLaunches).toBe(1);
            expect(daemonReceipts).toBe(1);
            const requesterSocket = io(endpoint, { path: '/v1/updates', transports: ['websocket'], reconnection: false,
                autoConnect: false, auth: { ...currentAccountStoredContentCompatibilitySocketAuth, token: requesterToken, clientType: 'user-scoped' } });
            onTestFinished(() => { requesterSocket.disconnect(); });
            await new Promise<void>((resolve, reject) => {
                requesterSocket.once('connect', resolve); requesterSocket.once('connect_error', reject); requesterSocket.connect();
            });
            for (const rpcMethod of [RPC_METHODS.SPAWN_HAPPY_SESSION, RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE, RPC_METHODS.SESSION_SPAWN_NEW]) {
                const raw = await new Promise<unknown>(resolve => requesterSocket.emit(SOCKET_RPC_EVENTS.CALL, {
                    method: `${machine.id}:${rpcMethod}`, params: 'opaque-private-spawn',
                }, resolve));
                expect(raw).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
            }
            for (const token of [outsiderToken, requesterToken]) {
                if (token === requesterToken) await db.machineAccountGrant.delete({ where: { machineId_accountId: {
                    machineId: machine.id, accountId: requester.id } } });
                const envelope = { v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: machine.id }, input };
                const denied = await app.inject({ method: 'POST', url: '/v1/actions/session.spawn_new/execution-authorization',
                    headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: machine.id, envelope } });
                expect(denied.statusCode).toBe(409);
            }
            expect(physicalLaunches).toBe(1);
        } finally {
            await disposeHomes();
        }
    });
});
