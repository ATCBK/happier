import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
  AccountEncryptionCurrentnessResponseSchema, V2SessionByIdResponseSchema, SessionOwnerMetadataV1Schema,
  createPlainSessionOwnerMetadataEnvelopeV1, FeaturesResponseSchema, accountSettingsParse,
  SessionInputRequestV1Schema, SessionMessageProvenanceV1Schema, settleSessionInputRequestV1, settleSessionMessageProvenanceV1, withSessionInputAuthorityV1,
  type SessionPendingEnqueueByMachineRequestV1, type SessionPendingExecutionRunEnqueueByMachineRequestV2,
  SessionTurnV1Schema, type SessionTurnV1, materializeWorkflowAcceptedSnapshotV1, type WorkflowDefinitionV1,
  SessionSharedMetadataV1Schema,
} from '@happier-dev/protocol';
import {
  ConversationObservationV1Schema, ConversationPollResultV1Schema, ConversationDeliveryInputV1Schema,
  ConversationProvidersContributionProtocolV1, type ConversationObservationV1, type ConversationDeliveryInputV1,
  ConversationBindingTargetV1Schema,
  ConversationDeliveryResolveInputV1Schema,
  ConversationDeliveryResolveResultV1Schema,
} from '@happier-dev/channels-protocol/v1';
import { createConversationProviderSetupResultV1Fixture } from '@happier-dev/channels-protocol/testing/v1';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue, parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';

import { createCliActionExecutorHarness } from '../actions/createCliActionExecutorHarness';
import { executePluginSessionMessageAction } from './executePluginSessionMessageAction';
import { createPluginSessionsInventory, type PluginSessionsInventoryParams } from './pluginSessionsInventory';
import { projectExternalShareableTranscriptPage } from './transcript/projectExternalShareableTranscriptPage';
import { createChannelsJourneyFixture } from '../../../../../packages/plugins/channels/src/testkit/channelsJourney';
import { createCurrentConversationConnectionFixture } from '../../../../../packages/plugins/channels/src/testkit/currentConnectionFixture';
import { CHANNEL_STATE_COLLECTION, CHANNEL_DELIVERIES_COLLECTION } from '../../../../../packages/plugins/channels/src/collections';
import { CHANNELS_PLUGIN, CHANNELS_PROVIDER_POINT_REF, PLUGIN_MANIFEST } from '../../../../../packages/plugins/channels/src/manifest';
import { CHANNEL_FILE_ATTACHMENT_RUNTIME } from '../../../../../packages/plugins/channels/src/channelAttachmentRuntime';
import { createConversationSessionProjectionFrontierRow } from '../../../../../packages/plugins/channels/src/sessionProjection';
import { readConversationOutwardDeliveryResolutionPage } from '../../../../../packages/plugins/channels/src/outwardDelivery';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/targetActionRegistry';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { buildWorkflowActionContext } from '@/daemon/workflows/daemonRuntime';
import { createWorkflowCoordinator } from '@/daemon/workflows/coordinator';
import { createInMemoryWorkflowCoordinatorStore } from '@/daemon/workflows/workflowCoordinator.testkit';
import { buildPluginContributionRegistry } from '@/plugins/projection/registry/normalize/package';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createCommittedContributedActionSchemaReader } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { requestInactiveSessionResume } from './requestInactiveSessionResume';
import { tryDecryptSessionOwnerMetadata, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { createBaseSessionForAttach } from '@/agent/runtime/createBaseSessionForAttach';
import { ApiClient } from '@/api/api';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import type { Metadata } from '@/api/types';
import { registerPrivateSpawnSessionRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import { createSpawnNewSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import type { RpcHandler } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { createTargetComposerAttachmentRegistry } from '@/plugins/runtime/lifecycle/contributions/targetComposerAttachments';
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { SessionExternalShareableMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';

// Only the child process's Socket.IO transport is replaced. Its attach owner,
// Session client constructor and runtime-handler registration remain real.
vi.mock('socket.io-client', () => ({ io: () => createApiSessionSocketStub() }));

// External authentication and RPC transport are system boundaries. The real
// Session Action executor beneath them owns spawn, archive and turn control.
vi.mock('@/auth/validateStoredAuthTokenAgainstActiveServer', async importOriginal => ({
  ...await importOriginal<typeof import('@/auth/validateStoredAuthTokenAgainstActiveServer')>(),
  validateStoredAuthTokenAgainstActiveServer: async () => ({ state: 'valid' }),
}));
vi.mock('@/session/transport/rpc/sessionRpc', async importOriginal => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/sessionRpc')>(), callSessionRpc: vi.fn(),
}));

const pluginId = 'test.channel.journey';
const providerMaterialization = { pluginId, machineId: 'machine-1', materializationId: 'journey-provider' };
const channelMaterialization = { pluginId: 'happier.channels', machineId: 'machine-1', materializationId: 'journey-core' };
const policy = { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } as const;
const endpoint = { kind: 'direct', audience: 'direct', id: 'mailbox' } as const;
const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
  signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });

function observation(id: string, text: string, thread = false): ConversationObservationV1 {
  const now = Date.now();
  return ConversationObservationV1Schema.parse({ v: 1, occurrenceId: `occurrence:${id}`, occurredAt: now,
    transport: { kind: 'poll' }, endpoint: thread ? { kind: 'thread', audience: 'direct', id: 'thread-1', parentId: endpoint.id, label: 'Furniture lead' } : endpoint,
    actor: { principalId: 'sender-1', label: 'Ada', kind: 'human', isIntegrationSelf: false },
    message: { id, text, providerTimestamp: now, addressingEvidence: 'none', contentProvenance: 'original' } });
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

async function journey(input: { router?: boolean; socket?: boolean; wrongDelivery?: boolean; wrongSessionCaller?: boolean; ambiguousStart?: boolean; failedBirth?: boolean; refuseSecondCreation?: boolean } = {}) {
  const pending: ConversationObservationV1[] = [];
  const delivered: ConversationDeliveryInputV1[] = [];
  const roles = ConversationProvidersContributionProtocolV1.operations;
  const definition = definePlugin({ id: pluginId, version: '0.0.0', actions: {
    setup: { title: 'Set up fixture provider', surfaces: roles.setup.declaration.surfaces, dangerLevel: roles.setup.declaration.dangerLevel,
      inputSchema: { type: 'object' }, resultSchema: roles.setup.declaration.resultSchema.jsonSchema,
      run: async () => createConversationProviderSetupResultV1Fixture() },
    inspect: { title: 'Inspect fixture provider', surfaces: roles.connectionTest.declaration.surfaces,
      dangerLevel: roles.connectionTest.declaration.dangerLevel, inputSchema: roles.connectionTest.declaration.input.schema.jsonSchema,
      resultSchema: roles.connectionTest.declaration.resultSchema.jsonSchema, run: async () => ({ kind: 'notReady', reason: 'network' }) },
    poll: { title: 'Poll fixture provider', surfaces: roles.observationsPoll.declaration.surfaces,
      dangerLevel: roles.observationsPoll.declaration.dangerLevel, inputSchema: roles.observationsPoll.declaration.input.schema.jsonSchema,
      resultSchema: roles.observationsPoll.declaration.resultSchema.jsonSchema,
      run: async request => {
        const batch = roles.observationsPoll.declaration.input.schema.parse(request).checkpoint === null ? [] : pending.splice(0);
        return ConversationPollResultV1Schema.parse(batch.length === 0
          ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: Date.now() } }
          : { kind: 'batch', observations: batch.map(observed => ({ observation: { kind: 'fullText', observation: observed }, eventCandidate: null })),
            checkpointAfterBatch: { cursor: Date.now() } });
      } },
    deliver: { title: 'Deliver fixture provider', surfaces: roles.messageDeliver.declaration.surfaces,
      dangerLevel: roles.messageDeliver.declaration.dangerLevel, inputSchema: roles.messageDeliver.declaration.input.schema.jsonSchema,
      resultSchema: roles.messageDeliver.declaration.resultSchema.jsonSchema,
      run: async request => {
        if (input.wrongDelivery) roles.connectionTest.declaration.input.schema.parse(request);
        const value = ConversationDeliveryInputV1Schema.parse(request);
        delivered.push(value);
        if (value.newThread && input.ambiguousStart) return { kind: 'outcomeUnknown' };
        return { kind: 'delivered', providerMessageIds: [`receipt-${delivered.length}`],
          ...(value.newThread ? { endpoint: { kind: 'thread', audience: 'direct', id: 'thread-1', parentId: endpoint.id } } : {}) };
      } },
  }, contributesTo: { 'happier.channels': { providers: { fixture: ConversationProvidersContributionProtocolV1.contribute({ operations: {
    setup: roles.setup.bind('setup'), connectionTest: roles.connectionTest.bind('inspect'), observationsPoll: roles.observationsPoll.bind('poll'),
    messageDeliver: roles.messageDeliver.bind('deliver'),
  } }) } } } });
  const provider = await createPluginTestkit({ manifest: definition.manifest, module: definition,
    resolveCurrentPluginMaterializationRef: () => providerMaterialization });
  const sessions = new Map<string, ReturnType<typeof V2SessionByIdResponseSchema.parse>['session']>();
  const rows: Parameters<typeof projectExternalShareableTranscriptPage>[0]['rows'][number][] = [];
  const rowSessions = new Map<unknown, string>();
  const turns: SessionTurnV1[] = [];
  const admissions: Array<SessionPendingEnqueueByMachineRequestV1 | SessionPendingExecutionRunEnqueueByMachineRequestV2> = [];
  const creations = new Map<string, string>();
  let refusedCreation = false;
  function addSession(id: string, attestedContext?: { externalPrincipalId: string; sourceMessageId: string }) {
    const session = V2SessionByIdResponseSchema.parse({ session: { id, seq: 0, createdAt: 1, updatedAt: 2,
      active: true, activeAt: 2, encryptionMode: 'plain', metadata: JSON.stringify({ v: 1 }), metadataVersion: 1, metadataLayoutVersion: 1,
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({ v: 1,
        workspace: { path: '/repo/channels', host: 'fixture', machineId: 'machine-1' }, system: attestedContext ? { attestedContext } : {} })),
      dataEncryptionKey: null, share: null, agentState: null, agentStateVersion: 1 } }).session;
    sessions.set(id, session);
    return session;
  }
  addSession('session-journey-1');
  const spawnRequests: ReturnType<typeof SpawnDaemonSessionRequestSchema.parse>[] = [];
  const transcriptPages: unknown[] = [];
  const diagnostics: unknown[] = [];
  const rpcRequests: string[] = [];
  vi.mocked(callSessionRpc).mockImplementation(async request => {
    rpcRequests.push(request.method);
    if (!request.method.endsWith(':abort')) throw new Error(`Unexpected Session RPC ${request.method}`);
    // Native abort handlers acknowledge delivery without an application result.
    // The canonical CLI cancellation owner must project this acknowledgement.
    return undefined;
  });
  resetServerFeaturesClientForTests();
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: {},
    capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } })),
  { status: 200, headers: { 'content-type': 'application/json' } }));
  // HTTP and authenticated machine transport are genuine process boundaries.
  // The Session handle, Action adapter/executor, admission envelope and
  // transcript producer beneath these boundaries are the production owners.
  const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: currentness };
    const messages = new URL(String(url));
    const messageSessionId = decodeURIComponent(messages.pathname.split('/')[3] ?? '');
    const sessionRows = rows.filter(row => rowSessions.get(row.id) === messageSessionId);
    if (messages.pathname.endsWith('/pending')) return { status: 200, data: { pending: [] } };
    if (messages.pathname.includes('/messages/by-local-id/')) {
      const localId = decodeURIComponent(messages.pathname.split('/').at(-1)!);
      const message = sessionRows.find(row => row.localId === localId);
      if (!message) throw new axios.AxiosError('Message not found', 'ERR_BAD_REQUEST', undefined, undefined,
        { status: 404, statusText: 'Not Found', headers: {}, config: { headers: new axios.AxiosHeaders() }, data: { error: 'Message not found' } });
      return { status: 200, data: { message: { ...message, updatedAt: message.createdAt } } };
    }
    if (messages.pathname.endsWith('/messages')) {
      const afterSeq = Number(messages.searchParams.get('afterSeq') ?? 0);
      return { status: 200, data: SessionExternalShareableMessagesPageV1Schema.parse({ messages: sessionRows.filter(row => Number(row.seq) > afterSeq), hasMore: false,
        externalShareableSnapshot: { turns, referencedUserRows: sessionRows.filter(row => row.messageRole === 'user')
          .map(({ sidechainId: _sidechainId, ...row }) => ({ ...row, updatedAt: row.createdAt })) } }) };
    }
    const id = [...sessions.keys()].find(candidate => String(url).includes(`/v2/sessions/${candidate}`));
    if (id) return { status: 200, data: { session: sessions.get(id) } };
    if (String(url).includes('/v1/access-keys/')) return { status: 200, data: { accessKey: 'existing' } };
    throw new Error(`Unexpected HTTP read ${String(url)}`);
  });
  // This boundary stores the real creator's row and indexes its tag. It does
  // not derive a creation identity, recipe, attestation or rejoin decision.
  const writes = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const request = record(body ?? {});
    if (String(url).endsWith('/lookup-by-tags')) {
      const tags = Array.isArray(request.tags) ? request.tags : [];
      return { status: 200, data: { sessions: tags.flatMap(tag => {
        const id = creations.get(String(tag));
        return id ? [sessions.get(id)] : [];
      }) } };
    }
    if (String(url).endsWith('/v1/sessions')) {
      const tag = String(request.tag);
      if (input.refuseSecondCreation && creations.size === 1 && !refusedCreation) {
        refusedCreation = true;
        return { status: 503, data: { error: 'database_transaction_conflict_exhausted', statusCode: 503 } };
      }
      const existingId = creations.get(tag);
      if (existingId) return { status: 200, data: { session: sessions.get(existingId), created: false } };
      const id = `session-born-${creations.size + 1}`;
      const shared = record(request.sharedMetadata);
      const created = V2SessionByIdResponseSchema.parse({ session: { ...addSession(id),
        active: false, metadata: shared.ciphertext, ownerMetadata: request.ownerMetadata } }).session;
      sessions.set(id, created); creations.set(tag, id);
      return { status: 200, data: { session: created, created: true } };
    }
    const id = [...sessions.keys()].find(candidate => String(url).includes(`/sessions/${candidate}/unarchive`));
    if (id) {
      const session = sessions.get(id)!;
      sessions.set(id, { ...session, archivedAt: null });
      return { status: 200, data: { success: true, archivedAt: null } };
    }
    throw new Error(`Unexpected HTTP write ${String(url)}`);
  });
  // The OS launch acknowledgement is the boundary. The private RPC settlement
  // remains real, including its advertised fresh-create outcome requirement.
  const privateSpawnHandlers = new Map<string, RpcHandler>();
  registerPrivateSpawnSessionRpcHandlers({
    rpcHandlerManager: { registerHandler(method, handler) { privateSpawnHandlers.set(method, handler); } },
    requireSessionCreationOutcome: true,
    spawnLifecycleHandler: createSpawnNewSessionLifecycleActionHandler({ spawnSession: async request => {
      if (!request.existingSessionId || !sessions.has(request.existingSessionId)) throw new Error('Expected committed Session');
      // Native initialization may fail after process-launch acknowledgement.
      if (input.failedBirth) return { type: 'success', sessionId: request.existingSessionId };
      const session = sessions.get(request.existingSessionId)!;
      sessions.set(session.id, { ...session, active: true, activeAt: Date.now() });
      return { type: 'success', sessionId: request.existingSessionId };
    } }),
  });
  let attachments: ReturnType<typeof createTargetComposerAttachmentRegistry> | undefined;
  const { executor } = createCliActionExecutorHarness({ token: 'journey-token', credentials: { token: 'journey-token', encryption: null },
    sessionId: 'session-journey-1', mode: 'plain', ctx: null, rawSession: {}, serverId: 'server-1', serverHttpBaseUrl: 'https://channels-home.example.test',
    actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettingsParse({}) }),
    resolveComposerAttachmentSendPreparation: () => attachments ?? null,
    sessionSpawnDirectTargetTransport: { machineId: 'machine-1',
      prepare: async () => ({ ok: true, directory: '/repo/channels', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
      spawnedSession: { spawn: async raw => {
        const request = SpawnDaemonSessionRequestSchema.parse(raw);
        spawnRequests.push(request);
        if (!request.existingSessionId || !sessions.has(request.existingSessionId)) throw new Error('Spawn must reach the real committed Session');
        return await privateSpawnHandlers.get(RPC_METHODS.SPAWN_HAPPY_SESSION)!(request);
      }, resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) } },
    machineAdmissionTransport: async request => {
      const repeated = admissions.find(previous => previous.localId === request.localId);
      if (repeated) return { status: 'alreadyAccepted', localId: request.localId };
      admissions.push(request);
      if (request.content.t !== 'plain') throw new Error('Expected a plain fixture Account');
      const body = record(request.content.v);
      const meta = record(body.meta);
      const protectedRequest = SessionInputRequestV1Schema.parse(meta.happierInputRequestV1);
      const receipt = { v: 1, issuer: 'authenticatedMachine' };
      const authority = settleSessionInputRequestV1({ request: protectedRequest, currentSessionPermissionCeiling: 'read-only', inputAdmissionReceipt: receipt });
      const provenance = settleSessionMessageProvenanceV1({ request: protectedRequest,
        requestedProvenance: SessionMessageProvenanceV1Schema.parse(meta.happierProvenanceV1), inputAdmissionReceipt: receipt });
      rows.push({ id: `user-${rows.length + 1}`, seq: rows.length + 1, localId: request.localId, createdAt: Date.now(),
        messageRole: 'user', sidechainId: null, externalShareableActor: 'machine',
        content: { t: 'plain', v: { ...body, meta: { ...withSessionInputAuthorityV1(meta, authority), happierProvenanceV1: provenance } } } });
      rowSessions.set(rows.at(-1)!.id, request.sessionId);
      return { status: 'accepted', localId: request.localId };
    } });
  const unavailable = async (): Promise<never> => { throw new Error('This journey does not use external Session or system record boundaries'); };
  let activeCore: Awaited<ReturnType<typeof createChannelsJourneyFixture>> | undefined;
  const currentCore = () => {
    if (!activeCore) throw new Error('The Channels occurrence is unavailable');
    return activeCore.kit.readTargetedContributionFixture(CHANNELS_PROVIDER_POINT_REF);
  };
  const isCoreCurrent = () => { try { currentCore(); return true; } catch { return false; } };
  const inventory = createPluginSessionsInventory({ credentials: { token: 'journey-token', encryption: null }, signal: new AbortController().signal,
    currentSessionId: null, sessionScopes: [{ access: ['read', 'write'] }], isCurrent: isCoreCurrent,
    readStoragePolicy: async () => 'optional', readAccountEncryptionCurrentness: async () => currentness,
    fetchById: async ({ sessionId }) => sessions.get(sessionId) ?? null,
    external: { capabilities: unavailable, list: unavailable, closeList: unavailable, attach: unavailable,
      readTranscript: unavailable, followTranscript: unavailable, takeover: unavailable },
    createHandleCapabilities: () => ({ listSystemRecords: unavailable, upsertSystemRecord: unavailable,
      readSystemRecord: unavailable, deleteSystemRecord: unavailable }),
    executeMessageAction: params => executePluginSessionMessageAction({ ...params, execute: executor.execute,
      pluginId: input.wrongSessionCaller ? '' : 'happier.channels', contributionLocalId: 'journey/poll',
      occurrenceId: currentCore().occurrenceId, sourceCustody: currentCore().sourceCustody,
      resolveCallerMaterialization: () => channelMaterialization }),
  } satisfies PluginSessionsInventoryParams);
  const actions = createPluginInvocationActionsService({ seed: {
    plugin: { id: 'happier.channels', version: '0.0.0' }, contribution: { id: 'journey/poll', qualifiedId: 'happier.channels/actions/journey/poll' },
    get occurrenceId() { return currentCore().occurrenceId; }, get sourceCustody() { return currentCore().sourceCustody; }, surface: 'background',
    signal: new AbortController().signal, isOccurrenceCurrent: isCoreCurrent, resolveCurrentPluginMaterializationRef: () => channelMaterialization,
  }, actionExecutor: { async execute(action, value, context) {
    const result = await executor.execute(action, value, context);
    if (action === 'session.transcript.get') transcriptPages.push(result.ok ? result.result : result);
    return result;
  } }, invokeContributedAction: unavailable });
  const connection = createCurrentConversationConnectionFixture({ connectionId: 'connection-1',
    ...(input.socket ? { transport: { kind: 'socket' as const }, replayContinuity: 'sessionBound' as const } : {}), authority: {
    providerPluginId: pluginId, providerContributionSelection: { contributionId: 'fixture' }, providerSetupInput: {}, credentialRef: null,
    transportOrigin: { serverIdentityId: 'srv_plugin_testkit', materializationRef: providerMaterialization },
    providerConnectionKey: 'fixture:provider', providerConfig: {}, integrationPrincipal: { id: 'fixture:integration' },
    routingIdentityKey: 'r'.repeat(43), authorityEpoch: 1 } });
  const binding = { id: 'binding-1', 'record-kind': 'binding', v: 1, 'connection-id': connection.id, 'binding-id': 'binding-1',
    'created-at': 1, 'updated-at': 1, payload: { endpoint, authorityEpoch: 1, enabled: true, deletionState: 'none',
      target: ConversationBindingTargetV1Schema.parse(input.router ? { kind: 'threadRouter', principalGroups: [{ id: 'brief', principalIds: ['sender-1'] }], routes: [{ id: 'intake',
        when: { group: 'brief', forwarded: 'any' }, policy, recipe: { executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
          directory: { kind: 'path', path: '/repo/channels' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
          connectedServices: { v: 2, bindingsByServiceId: {} }, memoryEnabled: false,
          ...(input.failedBirth ? { permissionMode: 'read-only', allowedTools: [], unlistedTools: 'deny',
            configuration: { mode: { value: null, updatedAtMs: 1 }, model: { value: 'recipe-model', updatedAtMs: 1 },
              permissionIntent: { value: 'read-only', updatedAtMs: 1 }, options: {} } } : {}) } }] }
        : { kind: 'session', sessionId: 'session-journey-1', policy }), allowedPrincipalIds: ['sender-1'], allowBotSenders: false,
      inputMode: 'allAllowedMessages', inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off' } };
  const core = await createChannelsJourneyFixture({ provider, connection, binding, sessions: inventory, actions,
    logger: { debug() {}, info: (_message, fields) => { diagnostics.push(fields); },
      warn: (_message, fields) => { diagnostics.push(fields); }, error() {}, diagnostic() {} },
    resolveCurrentProviderExecutionOrigin: () => ({ serverIdentityId: 'srv_plugin_testkit', materializationRef: providerMaterialization }),
    resolveCurrentPluginMaterializationRef: () => channelMaterialization }).catch(async error => {
      await provider.dispose(); http.mockRestore(); writes.mockRestore();
      vi.unstubAllGlobals(); resetServerFeaturesClientForTests();
      throw error;
    });
  activeCore = core;
  attachments = createTargetComposerAttachmentRegistry({
    declaredAttachments: (PLUGIN_MANIFEST.contributes?.composerAttachments ?? []).map(declaration => ({
      ...declaration, attachment: { pluginId: 'happier.channels', localId: declaration.id },
    })),
    targetRegistrations: [{ pluginId: 'happier.channels', occurrenceId: currentCore().occurrenceId,
      registration: { family: 'composerAttachments', localId: 'channel-file', value: CHANNEL_FILE_ATTACHMENT_RUNTIME } }],
    resolveOccurrenceLifecycle: () => ({ isCurrent: isCoreCurrent, retirementSignal: new AbortController().signal }),
    activateAttachmentOnDemand: async () => {},
    createInvocationContext: () => { throw new Error('Channel-file has no admission-phase callback'); },
  });
  if (!input.router) await core.state.put(createConversationSessionProjectionFrontierRow({ bindingId: binding.id,
    targetSessionId: 'session-journey-1', transcriptCursor: null, lastScannedSeq: 0, revision: 1, now: Date.now() }), { expectedRevision: 'absent' });
  function answer(text: string) {
    const user = rows.at(-1);
    if (!user) throw new Error('Answer requires an admitted input');
    const seq = rows.length + 1;
    rows.push({ id: `answer-${seq}`, seq, localId: null, createdAt: Date.now(), messageRole: 'agent', sidechainId: null,
      content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text } } } });
    rowSessions.set(rows.at(-1)!.id, rowSessions.get(user.id)!);
    turns.push(SessionTurnV1Schema.parse({ turnId: `turn-${seq}`, status: 'completed', startedAt: 1, updatedAt: 2,
      transcriptAnchors: { startSeqInclusive: Number(user.seq), endSeqInclusive: seq, userMessageSeqs: [Number(user.seq)], finalAssistantMessageSeq: seq } }));
  }
  function validateWrites() {
    for (const [collection, schema] of [[core.state, CHANNEL_STATE_COLLECTION.schema], [core.deliveries, CHANNEL_DELIVERIES_COLLECTION.schema]] as const) {
      const compiled = compilePluginJsonSchema(schema);
      for (const row of collection.rows.values()) expect(isValidPluginJsonSchemaValue(compiled, row.value), row.rowId).toBe(true);
    }
  }
  return { ...core, pending, delivered, admissions, sessions, inventory, creations, spawnRequests, transcriptPages, diagnostics, answer, validateWrites, rpcRequests,
    async dispose() { await core.dispose(); await provider.dispose(); http.mockRestore(); writes.mockRestore();
      activeCore = undefined;
      vi.unstubAllGlobals(); resetServerFeaturesClientForTests(); } };
}

describe('registered Channels composed journeys through real CLI Session admission', { timeout: 60_000 }, () => {
  it('rejoins committed thread births and recovers the same creation key after rollback without resetting the checkpoint', async () => {
    const fixture = await journey({ router: true, refuseSecondCreation: true });
    try {
      await fixture.poll();
      const first = observation('b04', 'First thread', true);
      fixture.pending.push(first);
      await fixture.poll();
      const firstTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'plugin:happier.channels',
        creationKey: 'channel-thread:binding-1:thread-1' });
      const firstSessionId = fixture.creations.get(firstTag);
      expect(firstSessionId).toBeDefined();
      expect(fixture.admissions.map(request => request.sessionId)).toEqual([firstSessionId]);
      const second = ConversationObservationV1Schema.parse({ ...observation('b05', 'Second thread', true),
        endpoint: { ...first.endpoint, id: 'thread-2' } });
      const checkpointBefore = [...fixture.state.rows.values()].find(row => row.value['record-kind'] === 'checkpoint');
      expect(checkpointBefore).toBeDefined();
      fixture.pending.push(second);
      await expect(fixture.poll()).rejects.toMatchObject({ code: 'channels_thread_spawn_failed', retryable: true });
      expect(fixture.creations.size).toBe(1);
      expect([...fixture.state.rows.values()].find(row => row.rowId === checkpointBefore!.rowId)).toEqual(checkpointBefore);
      // A checkpointed provider redelivers the retained batch after refusal.
      fixture.pending.push(first, second);
      await fixture.poll();
      fixture.pending.push(ConversationObservationV1Schema.parse({ ...observation('follow-up', 'Original thread follow-up', true) }));
      await fixture.poll();
      const secondTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'plugin:happier.channels',
        creationKey: 'channel-thread:binding-1:thread-2' });
      expect([...fixture.creations.keys()].sort()).toEqual([firstTag, secondTag].sort());
      expect(fixture.spawnRequests.map(request => request.existingSessionId)).toEqual([firstSessionId, fixture.creations.get(secondTag)]);
      expect(fixture.admissions.map(request => request.sessionId)).toEqual([firstSessionId, fixture.creations.get(secondTag), firstSessionId]);
      expect([...fixture.state.rows.values()].filter(row => row.value['record-kind'] === 'binding'
        && record(row.value.payload).parentBindingId === 'binding-1')).toHaveLength(2);
      fixture.validateWrites();
    } finally { await fixture.dispose(); }
  });
  it('retries transient Account currentness through the registered outward cycle and delivers once', async () => {
    const fixture = await journey({ router: true });
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const get = fixture.state.get.bind(fixture.state);
    let unavailable = true;
    const read = vi.spyOn(fixture.state, 'get').mockImplementation(async rowId => {
      const attempting = [...fixture.deliveries.rows.values()].some(row => record(row.value.payload).state === 'attempting');
      if (unavailable && attempting && rowId === 'connection-1') {
        unavailable = false;
        throw new Error('Account read transport disconnected');
      }
      return await get(rowId);
    });
    try {
      const admitted = record(await fixture.invoke('conversation/start-v1', {
        routerBindingId: 'binding-1', audienceGroupId: 'brief', subject: 'Recoverable brief',
        content: { text: 'A transient read must retain this body.' }, sessionId: 'session-journey-1',
      }));
      const request = { custodyId: String(admitted.custodyId) };
      await fixture.outward();
      expect(await fixture.invoke('delivery/read-v1', request)).toMatchObject({ kind: 'ready', delivery: {
        state: 'retryDue', lastOutcome: 'pending',
      } });
      expect(fixture.delivered).toEqual([]);
      unavailable = false;
      await fixture.outward();
      expect(fixture.delivered).toEqual([]);
      now += 1_000;
      await fixture.outward();
      await fixture.outward();
      expect(fixture.delivered).toHaveLength(1);
      expect(await fixture.invoke('delivery/read-v1', request)).toMatchObject({ kind: 'ready', delivery: {
        state: 'delivered', lastOutcome: 'delivered',
      } });
      fixture.validateWrites();
    } finally { read.mockRestore(); clock.mockRestore(); await fixture.dispose(); }
  });

  it.each(['mismatch', 'attempted', 'misbound'] as const)('preserves %s settlement through the registered outward cycle', async scenario => {
    const fixture = await journey({ router: true, ambiguousStart: scenario === 'attempted', wrongDelivery: scenario === 'misbound' });
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const admitted = record(await fixture.invoke('conversation/start-v1', {
        routerBindingId: 'binding-1', audienceGroupId: 'brief', subject: 'Settlement control',
        content: { text: 'Preserve the currentness boundary.' }, sessionId: 'session-journey-1',
      }));
      const request = { custodyId: String(admitted.custodyId) };
      if (scenario === 'mismatch') {
        const binding = await fixture.state.get('binding-1');
        if (!binding) throw new Error('Expected router binding');
        await fixture.state.put({ ...binding.value, payload: { ...record(binding.value.payload), authorityEpoch: 2 } },
          { expectedRevision: binding.revision });
      }
      await fixture.outward();
      const expected = scenario === 'mismatch' ? 'suppressed' : 'outcomeUnknown';
      expect(await fixture.invoke('delivery/read-v1', request)).toMatchObject({ kind: 'ready', delivery: { state: expected } });
      if (scenario === 'mismatch') {
        // Restoring valid authority never reactivates historical suppression.
        const binding = await fixture.state.get('binding-1');
        if (!binding) throw new Error('Expected router binding');
        await fixture.state.put({ ...binding.value, payload: { ...record(binding.value.payload), authorityEpoch: 1 } },
          { expectedRevision: binding.revision });
      }
      now += 60_000;
      await fixture.outward();
      expect(fixture.delivered).toHaveLength(scenario === 'attempted' ? 1 : 0);
      expect(await fixture.invoke('delivery/read-v1', request)).toMatchObject({ kind: 'ready', delivery: { state: expected } });
      fixture.validateWrites();
    } finally { clock.mockRestore(); await fixture.dispose(); }
  });

  it('retries a failed first runtime start in the same committed Session with its recipe and pending inputs intact', async () => {
    const fixture = await journey({ router: true, socket: true, failedBirth: true });
    try {
      const observed = ConversationObservationV1Schema.parse({ ...observation('failed-birth', 'Original input', true), transport: { kind: 'socket' } });
      const entry = { observation: { kind: 'fullText' as const, observation: observed }, eventCandidate: null };
      await fixture.ingest({ connectionId: 'connection-1', entry });
      const sessionId = fixture.admissions[0]?.sessionId;
      const session = sessionId ? fixture.sessions.get(sessionId) : undefined;
      if (!session) throw new Error('The failed native start must retain its committed Session and input');
      expect(session.active).toBe(false);
      expect(session.agentState).toBeNull();
      const credentials = { token: 'journey-token', encryption: null };
      const metadata = tryDecryptSessionOwnerMetadataView({ credentials, rawSession: session, accountEncryptionMode: 'plain' });
      if (!metadata) throw new Error('The real committed birth metadata must be readable');
      const requests: unknown[] = [];
      const machineRpcTransport = async (_method: string, request: unknown) => {
        requests.push(request);
        const ownerMetadata = tryDecryptSessionOwnerMetadata({ credentials, rawSession: session, accountEncryptionMode: 'plain' });
        if (!ownerMetadata || !session.ownerMetadata) throw new Error('The child requires the committed owner envelope');
        const attached = await createBaseSessionForAttach({ existingSessionId: session.id,
          metadata: createTestMetadata({ flavor: 'claude', path: '/repo/channels', machineId: 'machine-1' }),
          state: { controlledByUser: false }, sessionAttachSecret: { encryptionMode: 'plain', snapshot: {
            metadata: SessionSharedMetadataV1Schema.parse(JSON.parse(session.metadata)) as Metadata,
            metadataVersion: session.metadataVersion, metadataLayoutVersion: 1,
            ownerMetadata, ownerMetadataEnvelope: session.ownerMetadata,
            agentState: null, agentStateVersion: session.agentStateVersion,
          } },
        });
        const api = await ApiClient.create(credentials);
        const child = api.sessionSyncClient(attached, { durableMutationDeliveryInitiallyActive: false });
        try {
          expect(child.getMetadataSnapshot()).toMatchObject({ flavor: 'claude',
            sessionCreationCorrespondenceV1: metadata.sessionCreationCorrespondenceV1 });
        } finally { await child.close(); }
        return { type: 'success', sessionId: session.id };
      };
      const resume = (savedMetadata: Record<string, unknown>) => requestInactiveSessionResume({ credentials,
        sessionId: session.id, rawSession: session, metadata: savedMetadata, requestId: 'person-retry', machineRpcTransport });
      // Removing the actual creator's correspondence must refuse before launch.
      const { sessionCreationCorrespondenceV1: _correspondence, ...unbound } = metadata;
      expect(await resume(unbound)).toMatchObject({ ok: false, code: 'unsupported' });
      expect(requests).toEqual([]);
      expect(await resume(metadata)).toEqual({ ok: true });
      expect(requests).toMatchObject([{ type: 'resume-session', sessionId: session.id,
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        permissionMode: 'read-only', modelSelection: { ref: { modelId: 'recipe-model' } },
        sessionCreationCorrespondence: expect.objectContaining({ recipe: expect.objectContaining({ allowedTools: [], unlistedTools: 'deny' }) }),
      }]);
      await fixture.ingest({ connectionId: 'connection-1', entry });
      expect(fixture.creations.size).toBe(1);
      expect(fixture.admissions.map(request => request.sessionId)).toEqual([session.id]);
      fixture.validateWrites();
    } finally { await fixture.dispose(); }
  });
  it('reads accepted custody through the registered safe delivery Action before and after provider delivery', async () => {
    const fixture = await journey({ router: true });
    // The host materializes put results through this exact stored-value
    // decoder. A mutable Collection alone misses union-field demotion.
    const storedDeliverySchema = createStoredReadSchema(createPluginJsonSchemaZodValueAdapter(CHANNEL_DELIVERIES_COLLECTION.schema));
    const putDelivery = fixture.deliveries.put.bind(fixture.deliveries);
    fixture.deliveries.put = async (...args: Parameters<typeof fixture.deliveries.put>) => {
      const row = await putDelivery(...args);
      const decoded = { ...row, value: record(storedDeliverySchema.parse(row.value)) };
      fixture.deliveries.rows.set(row.rowId, decoded);
      return decoded;
    };
    try {
      const admitted = record(await fixture.invoke('conversation/start-v1', {
        routerBindingId: 'binding-1', audienceGroupId: 'brief', subject: 'Private read subject',
        content: { text: 'Private read body', html: '<p>' + 'a'.repeat(120 * 1024) + '</p>' }, sessionId: 'session-journey-1',
      }));
      const request = { custodyId: String(admitted.custodyId) };
      const queued = await fixture.invoke('delivery/read-v1', request);
      expect(queued).toMatchObject({ kind: 'ready', delivery: {
        custodyId: request.custodyId, revision: expect.any(Number), state: 'ready', lastOutcome: 'pending',
      } });
      expect(JSON.stringify(queued)).not.toContain('Private read');
      await fixture.outward();
      expect(await fixture.invoke('delivery/read-v1', request)).toMatchObject({ kind: 'ready', delivery: {
        custodyId: request.custodyId, state: 'delivered', lastOutcome: 'delivered',
      } });
      fixture.validateWrites();
    } finally { await fixture.dispose(); }
  });

  it('projects the missing started-thread endpoint and accepts its current custody without resending', async () => {
    const fixture = await journey({ router: true, ambiguousStart: true });
    try {
      await fixture.poll();
      await fixture.invoke('conversation/start-v1', {
        routerBindingId: 'binding-1', audienceGroupId: 'brief', subject: 'Private brief subject',
        content: { text: 'Private brief body' }, sessionId: 'session-journey-1',
      });
      await fixture.outward();
      const page = await readConversationOutwardDeliveryResolutionPage({
        deliveriesCollection: fixture.deliveries as never, connectionId: 'connection-1',
      });
      expect(page.rows).toEqual([expect.objectContaining({
        state: 'outcomeUnknown', createdThreadEndpointRequired: { parentId: 'mailbox' },
      })]);
      expect(JSON.stringify(page)).not.toContain('Private brief');
      const row = page.rows[0]!;
      const request = { custodyId: row.custodyId, expectedRevision: row.revision, resolution: 'accepted' } as const;
      await expect(fixture.invoke('delivery/resolve-v1', request))
        .rejects.toMatchObject({ code: 'channels_delivery_resolve_endpoint_required' });
      await expect(fixture.invoke('delivery/resolve-v1', { ...request,
        endpoint: { kind: 'thread', audience: 'direct', id: 'thread-1', parentId: 'another-mailbox' },
      })).rejects.toMatchObject({ code: 'channels_delivery_resolve_endpoint_required' });
      const accepted = ConversationDeliveryResolveInputV1Schema.parse({ ...request,
        endpoint: { kind: 'thread', audience: 'direct', id: 'thread-1', parentId: 'mailbox' },
      });
      expect(ConversationDeliveryResolveResultV1Schema.parse(await fixture.invoke('delivery/resolve-v1', accepted)))
        .toMatchObject({ kind: 'resolved', custodyId: row.custodyId, resolution: 'accepted' });
      await fixture.outward();
      await fixture.outward();
      expect(fixture.delivered).toHaveLength(1);
      const children = [...fixture.state.rows.values()].filter(child => child.value['record-kind'] === 'binding'
        && record(child.value.payload).parentBindingId === 'binding-1');
      expect(children).toHaveLength(1);
      expect(children[0]?.value.payload).toMatchObject({
        endpoint: accepted.endpoint, target: { kind: 'session', sessionId: 'session-journey-1' },
      });
      fixture.pending.push(observation('confirmed-brief-reply', 'Merci', true));
      await fixture.poll();
      expect(fixture.admissions.map(admission => admission.sessionId)).toEqual(['session-journey-1']);
      fixture.validateWrites();
    } finally { await fixture.dispose(); }
  });

  it('projects an admitted input through custody and the registered provider with its exact reply relation', async () => {
    const fixture = await journey();
    try {
      const archived = fixture.sessions.get('session-journey-1');
      if (!archived) throw new Error('Missing bound Session');
      fixture.sessions.set(archived.id, { ...archived, archivedAt: Date.now() });
      await fixture.poll();
      const inbound = observation('inbound-1', 'Bonjour Ada');
      fixture.pending.push(inbound);
      await fixture.poll();
      fixture.pending.push(inbound); await fixture.poll();
      expect(fixture.admissions, JSON.stringify({ pages: fixture.transcriptPages, diagnostics: fixture.diagnostics })).toHaveLength(1);
      expect(fixture.admissions[0]?.sessionId).toBe(archived.id);
      expect(fixture.sessions.get(archived.id)?.archivedAt).toBeNull();
      fixture.answer('Bonjour, votre demande est reçue.');
      await fixture.outward();
      await fixture.outward();
      expect(fixture.delivered, JSON.stringify(fixture.transcriptPages)).toEqual([expect.objectContaining({ content: { text: 'Bonjour, votre demande est reçue.' },
        replyContext: expect.objectContaining({ replyToMessageId: 'inbound-1' }) })]);
      fixture.validateWrites();
    } finally { await fixture.dispose(); }
  });

  it('replies once to a follow-up in the same router child through authenticated transcript admission', async () => {
    const fixture = await journey({ router: true });
    try {
      await fixture.poll();
      fixture.pending.push(observation('thread-first', 'First question', true));
      await fixture.poll();
      fixture.answer('First answer');
      await fixture.outward();
      fixture.pending.push(observation('thread-follow-up', 'Follow-up question', true));
      await fixture.poll();
      fixture.answer('Follow-up answer');
      await fixture.outward();
      await fixture.outward();
      expect(fixture.creations.size).toBe(1);
      expect(fixture.admissions.map(request => request.sessionId)).toEqual(['session-born-1', 'session-born-1']);
      expect(fixture.delivered, JSON.stringify({ pages: fixture.transcriptPages, diagnostics: fixture.diagnostics })).toEqual([
        expect.objectContaining({ content: { text: 'First answer' }, replyContext: expect.objectContaining({ replyToMessageId: 'thread-first' }) }),
        expect.objectContaining({ content: { text: 'Follow-up answer' }, replyContext: expect.objectContaining({ replyToMessageId: 'thread-follow-up' }) }),
      ]);
      const child = [...fixture.state.rows.values()].find(row => record(row.value.payload).parentBindingId === 'binding-1');
      const finals = fixture.transcriptPages.flatMap(page => {
        const items = record(page).items;
        return Array.isArray(items) ? items.filter(item => record(item).kind === 'assistantText') : [];
      });
      expect(finals).toHaveLength(2);
      for (const final of finals) expect(final).toMatchObject({ consumedInputs: [{ origin: { sourceAuthority: {
        mediatorPluginId: 'happier.channels', sourceRef: `channels:binding:${child?.rowId}`,
      } } }] });
      fixture.validateWrites();
    } finally { await fixture.dispose(); }
  });

  it('replies once to an attachment-bearing routed input without losing its child binding authority', async () => {
    const fixture = await journey({ router: true });
    try {
      await fixture.poll();
      const inbound = observation('thread-files', 'Forwarded attachment text', true);
      fixture.pending.push(ConversationObservationV1Schema.parse({ ...inbound, message: { ...inbound.message,
        contentProvenance: 'forwarded', attachments: [
          { attachmentId: 'forwarded-eml', name: 'forwarded.eml', mediaType: 'message/rfc822' },
          { attachmentId: 'lead-pdf', name: 'lead.pdf', mediaType: 'application/pdf' },
        ],
      } }));
      await fixture.poll();
      expect(fixture.admissions).toHaveLength(1);
      const input = fixture.admissions[0]!;
      expect(input.content.t).toBe('plain');
      if (input.content.t !== 'plain') throw new Error('Expected plain fixture input');
      expect(input.content.v).toMatchObject({ meta: { [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: { composerAttachments: [
        expect.objectContaining({ attachment: { pluginId: 'happier.channels', localId: 'channel-file' } }),
        expect.objectContaining({ attachment: { pluginId: 'happier.channels', localId: 'channel-file' } }),
      ] } } });
      fixture.answer('Attachment answer');
      await fixture.outward();
      await fixture.outward();
      expect(fixture.delivered, JSON.stringify(fixture.transcriptPages)).toEqual([expect.objectContaining({
        content: { text: 'Attachment answer' }, replyContext: expect.objectContaining({ replyToMessageId: 'thread-files' }),
      })]);
      const child = [...fixture.state.rows.values()].find(row => record(row.value.payload).parentBindingId === 'binding-1');
      expect(fixture.transcriptPages).toContainEqual(expect.objectContaining({ items: expect.arrayContaining([
        expect.objectContaining({ kind: 'assistantText', consumedInputs: [{ localId: input.localId, origin: expect.objectContaining({
          sourceAuthority: expect.objectContaining({ mediatorPluginId: 'happier.channels', sourceRef: `channels:binding:${child?.rowId}` }),
          contentProvenance: 'forwarded',
        }) }] }),
      ]) }));
      fixture.validateWrites();
    } finally { await fixture.dispose(); }
  });

  it('rejects a mis-bound Session caller before any machine admission or delivery', async () => {
    const fixture = await journey({ wrongSessionCaller: true });
    try {
      await fixture.poll(); fixture.pending.push(observation('wrong-input', 'Never admitted'));
      await fixture.poll(); await fixture.outward();
      expect(fixture.admissions).toEqual([]);
      expect(fixture.delivered).toEqual([]);
      expect([...fixture.state.rows.values()].filter(row => row.value['record-kind'] === 'ingress-obligation')).not.toHaveLength(0);
    } finally { await fixture.dispose(); }
  });

  it('retains custody when the registered delivery operation is mis-bound to the connection-test consumer', async () => {
    const fixture = await journey({ wrongDelivery: true });
    try {
      await fixture.poll(); fixture.pending.push(observation('wrong-delivery', 'Admit this input'));
      await fixture.poll(); fixture.answer('This answer must remain in custody'); await fixture.outward();
      expect(fixture.admissions).toHaveLength(1);
      expect(fixture.delivered).toEqual([]);
      expect([...fixture.deliveries.rows.values()].filter(row => row.deleted !== true)).not.toHaveLength(0);
    } finally { await fixture.dispose(); }
  });

  it('converges concurrent first observations and replay on one thread Session, then restores it and stops its turn', async () => {
    const fixture = await journey({ router: true, socket: true });
    try {
      const socketObservation = (id: string, text: string) => ConversationObservationV1Schema.parse({
        ...observation(id, text, true), transport: { kind: 'socket' },
      });
      const admit = (observed: ConversationObservationV1) => fixture.ingest({
        connectionId: 'connection-1', entry: { observation: { kind: 'fullText', observation: observed }, eventCandidate: null },
      });
      const first = socketObservation('thread-first', 'Furniture lead');
      await Promise.all([first, socketObservation('thread-concurrent', 'Concurrent details')].map(admit));
      await admit(first);
      expect(fixture.creations.size).toBe(1);
      expect(fixture.admissions).toHaveLength(2);
      fixture.answer('Créé'); await fixture.outward();
      const routedSessionId = fixture.admissions[0]?.sessionId;
      const session = routedSessionId ? fixture.sessions.get(routedSessionId) : undefined;
      if (!session) throw new Error('Missing routed Session');
      expect(session.ownerMetadata).toMatchObject({ t: 'plain', v: { workspace: { machineId: 'machine-1' }, system: { attestedContext: {
        externalPrincipalId: 'sender-1', sourceMessageId: expect.stringMatching(/^thread-(first|concurrent)$/u),
      } } } });
      expect(JSON.parse(session.metadata!)).toMatchObject({ summary: { text: 'Furniture lead' } });
      const handle = await fixture.inventory.get(session.id);
      expect(await handle?.summary()).toMatchObject({ machineId: 'machine-1', title: 'Furniture lead' });
      const child = [...fixture.state.rows.values()].find(row => row.deleted !== true
        && record(row.value.payload).parentBindingId === 'binding-1');
      expect(child?.value.payload).toMatchObject({ allowedPrincipalIds: ['sender-1'], target: { sessionId: routedSessionId } });
      fixture.sessions.set(session.id, { ...session, archivedAt: Date.now() });
      await admit(socketObservation('thread-follow', 'One more detail'));
      expect(fixture.admissions.map(request => request.sessionId)).toEqual([routedSessionId, routedSessionId, routedSessionId]);
      expect(fixture.sessions.get(session.id)?.archivedAt).toBeNull();
      await admit(socketObservation('thread-stop', '/stop'));
      expect(fixture.rpcRequests).toEqual([`${session.id}:abort`]);
      const stop = [...fixture.state.rows.values()].find(row => record(row.value.payload).stopOutcome !== undefined);
      expect(stop?.value.payload).toMatchObject({ stopOutcome: 'cancelled', disposition: 'admitted' });
      expect(fixture.admissions).toHaveLength(3);
      fixture.validateWrites();
    } finally { await fixture.dispose(); }
  });

  it('records unknown and unmatched router observations without content or Session creation', async () => {
    const fixture = await journey({ router: true, socket: true });
    try {
      const router = await fixture.state.get('binding-1');
      if (!router) throw new Error('Missing router');
      const payload = record(router.value.payload);
      const target = record(payload.target);
      const routes = target.routes;
      if (!Array.isArray(routes)) throw new Error('Missing routes');
      await fixture.state.put({ ...router.value, payload: { ...payload, target: { ...target,
        routes: routes.map(route => ({ ...record(route), when: { group: 'brief', forwarded: true } })),
      } } }, { expectedRevision: router.revision });
      for (const [id, principalId] of [['unknown-drop', 'outsider'], ['unmatched-drop', 'sender-1']] as const) {
        const observed = ConversationObservationV1Schema.parse({ ...observation(id, `Private content ${id}`, true),
          transport: { kind: 'socket' }, actor: { principalId, label: 'Sender', kind: 'human', isIntegrationSelf: false } });
        await fixture.ingest({ connectionId: 'connection-1', entry: { observation: { kind: 'fullText', observation: observed }, eventCandidate: null } });
      }
      expect(fixture.admissions).toEqual([]);
      expect(fixture.creations.size).toBe(0);
      const obligations = [...fixture.state.rows.values()].filter(row => row.value['record-kind'] === 'ingress-obligation');
      expect(obligations.map(row => record(record(row.value.payload).nonAdmission).reason)).toEqual(['actorNotAllowed', 'routeNotMatched']);
      expect(JSON.stringify(obligations)).not.toContain('Private content');
      fixture.validateWrites();
    } finally { await fixture.dispose(); }
  });

  it('stops child admission with its router and rejoins the immutable Session birth after child deletion', async () => {
    const fixture = await journey({ router: true, socket: true });
    try {
      const admit = async (id: string) => fixture.ingest({ connectionId: 'connection-1', entry: {
        observation: { kind: 'fullText', observation: ConversationObservationV1Schema.parse({ ...observation(id, id, true), transport: { kind: 'socket' } }) },
        eventCandidate: null,
      } });
      await admit('birth');
      const sessionId = fixture.admissions[0]?.sessionId;
      const child = [...fixture.state.rows.values()].find(row => row.deleted !== true
        && record(row.value.payload).parentBindingId === 'binding-1');
      const router = await fixture.state.get('binding-1');
      if (!child || !router || !sessionId) throw new Error('Missing routed birth');
      await fixture.state.put({ ...router.value, payload: { ...record(router.value.payload), enabled: false } }, { expectedRevision: router.revision });
      await admit('disabled');
      expect(fixture.admissions.map(request => request.sessionId)).toEqual([sessionId]);
      const disabled = await fixture.state.get(router.rowId);
      if (!disabled) throw new Error('Missing disabled router');
      await fixture.state.put(router.value, { expectedRevision: disabled.revision });
      await fixture.state.forget(child.rowId, { expectedRevision: child.revision });
      for (const row of fixture.state.rows.values()) if (row.value['record-kind'] === 'projection-frontier'
        && row.value['binding-id'] === child.rowId) await fixture.state.forget(row.rowId, { expectedRevision: row.revision });
      await admit('rejoin');
      expect(fixture.creations.size).toBe(1);
      expect(fixture.admissions.map(request => request.sessionId)).toEqual([sessionId, sessionId]);
      expect(fixture.sessions.get(sessionId)?.ownerMetadata).toMatchObject({ t: 'plain', v: { system: {
        attestedContext: { externalPrincipalId: 'sender-1', sourceMessageId: 'birth' },
      } } });
      fixture.validateWrites();
    } finally { await fixture.dispose(); }
  });

  it('starts through a workflow and registered Action custody, then admits the reply to its named Session', async () => {
    const fixture = await journey({ router: true });
    const localId = 'conversation/start-v1';
    const actionId = `happier.channels/actions/${localId}`;
    const manifest = parsePluginManifest(CHANNELS_PLUGIN.manifest);
    if (!manifest.ok) throw new Error('The actual Channels manifest is invalid');
    const declaration = manifest.manifest.contributes.actions.find(action => action.id === localId);
    if (!declaration?.inputSchema || !declaration.resultSchema) throw new Error('The activated start Action contract is missing');
    const projected = buildPluginContributionRegistry({ loadedPlugins: [{
      pluginId: 'happier.channels', pluginRootPath: '/fixture/channels', manifestPath: '/fixture/channels/.happier-plugin/plugin.json',
      daemonEntryPath: null, devDaemonEntryPath: null,
      sourceSpec: { kind: 'bundled', locator: '@happier-dev/plugins-channels' },
      manifest: normalizePluginManifestV2(CHANNELS_PLUGIN.manifest),
    }] });
    const definitions = projected.actions.filter(action => action.definition.id === localId).map(action =>
      ActionDefinitionV1Schema.parse({ ...action.definition, id: actionId, inputSchema: action.definition.inputSchema ?? {} }));
    const listDefinitions = () => definitions;
    const content = { text: 'Votre brief', html: `<main>${'x'.repeat(120 * 1024)}</main>` };
    const authorization = { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const };
    const occurrenceId = createPluginRuntimeOccurrenceId('happier.channels');
    const confirmations: unknown[] = [];
    const registry = createTargetActionInvocationRegistry({ actions: [{ pluginId: 'happier.channels', pluginVersion: '0.0.0',
      occurrenceId, sourceCustody: createManagedPluginSourceCustody('channels-workflow-journey'), localId,
      definition: declaration,
      // The target transport crosses into the actual activated SDK test host;
      // its registered handler, schemas, storage and custody remain real.
      handler: value => fixture.invoke(localId, value),
    }], readCurrentPluginOccurrenceId: () => occurrenceId,
    resolveAuthorizationFacts: action => ({ generation: { targetGeneration: action.occurrenceId,
      desiredGeneration: action.occurrenceId, appliedGeneration: action.occurrenceId },
      resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
    createServices: createUnavailablePluginServicesFactory(), resolveHostBinding: createTargetActionHostBindingResolver() });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      listContributedActionDefinitions: listDefinitions,
      readContributedActionSchemas: createCommittedContributedActionSchemaReader(listDefinitions),
      invokeContributedAction: async request => {
      const result = await registry.invoke({ ...request.action, input: request.input, surface: 'agent',
        initiatingActionCaller: request.context.actionCaller, signal: request.signal,
        requestCurrentIntent: async confirmation => {
          confirmations.push(confirmation.action.input);
          return { status: 'approved', fingerprint: confirmation.fingerprint };
        } });
      if (result.status === 'executed') return { ok: true, result: result.value };
      if (result.status === 'deferred') throw new Error('The approved workflow start must execute');
      return { ok: false, errorCode: result.code, error: result.message };
    } });
    try {
      await fixture.poll();
      const workflow: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { agentTarget: {
        kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
      } }, blocks: [
        { kind: 'step', id: 'brief', document: { text: 'Produce the brief', references: [], attachments: [] }, input: [],
          result: { kind: 'json', schema: { type: 'object', properties: { content: {
            type: 'object', properties: { text: { type: 'string' }, html: { type: 'string' } }, required: ['text'], additionalProperties: false,
          } }, required: ['content'], additionalProperties: false } } },
        { kind: 'action', id: 'send', actionId, input: {
          routerBindingId: { kind: 'literal', value: 'binding-1' }, audienceGroupId: { kind: 'literal', value: 'brief' },
          sessionId: { kind: 'literal', value: 'session-journey-1' }, subject: { kind: 'literal', value: 'Morning brief' },
          content: { kind: 'result', producer: { blockId: 'brief', scope: { kind: 'current' } }, path: ['content'] },
        } },
      ] };
      const workspace = { machineId: 'machine-1', directory: '/repo/channels', checkoutRootPath: '/repo/channels' };
      const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: workflow,
        context: { source: { kind: 'inline' }, inputs: {}, machineId: workspace.machineId, executionTarget: { kind: 'session' },
          workspaceTarget: { project: workspace }, origin: { kind: 'direct' }, authorization }, admission: { kind: 'user' },
        effects: { resolveTargetAvailability: async () => true, readActionContract: async id => id === actionId
          ? { inputSchema: declaration.inputSchema!, outputSchema: declaration.resultSchema! } : null } });
      if (!accepted.ok) throw new Error(accepted.error.code);
      const coordinator = createWorkflowCoordinator({ store: createInMemoryWorkflowCoordinatorStore(),
        executeStep: async params => {
          await params.beforeInputAdmission();
          await params.onInputAccepted({ kind: 'session', sessionId: 'session-journey-1', localInputId: params.invocationRecordId! });
          return { kind: 'completed', result: { content }, resultEncoding: 'typed' };
        }, resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
        action: { executor, buildContext: async params => buildWorkflowActionContext(params),
          observeRun: async () => { throw new Error('The immediate start Action does not observe a Run'); } } });
      const run = { ...accepted.snapshot, runId: 'channels-brief-journey' };
      const result = await coordinator.run(run);
      expect(result, JSON.stringify(result)).toMatchObject({ state: 'succeeded' });
      expect(confirmations).toEqual([{ routerBindingId: 'binding-1', audienceGroupId: 'brief', sessionId: 'session-journey-1', subject: 'Morning brief', content }]);
      await coordinator.run(run);
      expect(confirmations).toHaveLength(1);
      await fixture.outward();
      await fixture.outward();
      expect(fixture.delivered).toHaveLength(1);
      expect(fixture.delivered[0]?.content.html).toBe(content.html);
      expect(fixture.delivered[0]?.newThread).toEqual({ recipients: ['sender-1'], subject: 'Morning brief' });
      expect([...fixture.state.rows.values()].filter(row => row.value['record-kind'] === 'binding'
        && record(row.value.payload).parentBindingId === 'binding-1').map(row => row.value.payload),
      JSON.stringify({ state: [...fixture.state.rows.values()], deliveries: [...fixture.deliveries.rows.values()] }))
        .toEqual([expect.objectContaining({ target: expect.objectContaining({ sessionId: 'session-journey-1' }) })]);
      fixture.pending.push(observation('brief-reply', 'Merci, une question', true)); await fixture.poll();
      expect(fixture.admissions.map(request => request.sessionId)).toEqual(['session-journey-1']);
      expect(fixture.creations.size).toBe(0);
      expect(fixture.sessions.get('session-journey-1')?.ownerMetadata).toMatchObject({ t: 'plain', v: { system: {} } });
      fixture.validateWrites();
    } finally { registry.dispose(); await fixture.dispose(); }
  });
});
