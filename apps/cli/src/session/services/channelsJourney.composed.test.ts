import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
  AccountEncryptionCurrentnessResponseSchema, V2SessionByIdResponseSchema, SessionOwnerMetadataV1Schema,
  createPlainSessionOwnerMetadataEnvelopeV1, ExternalShareableTranscriptPageV1Schema, FeaturesResponseSchema, accountSettingsParse,
  SessionInputRequestV1Schema, SessionMessageProvenanceV1Schema, settleSessionInputRequestV1, settleSessionMessageProvenanceV1,
  type SessionPendingEnqueueByMachineRequestV1, type SessionPendingExecutionRunEnqueueByMachineRequestV2,
  SessionTurnV1Schema, type SessionTurnV1,
} from '@happier-dev/protocol';
import {
  ConversationObservationV1Schema, ConversationPollResultV1Schema, ConversationDeliveryInputV1Schema,
  ConversationProvidersContributionProtocolV1, type ConversationObservationV1, type ConversationDeliveryInputV1,
  ConversationBindingTargetV1Schema,
} from '@happier-dev/channels-protocol/v1';
import { createConversationProviderSetupResultV1Fixture } from '@happier-dev/channels-protocol/testing/v1';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';

import { createCliActionExecutorHarness } from '../actions/createCliActionExecutorHarness';
import { executePluginSessionMessageAction } from './executePluginSessionMessageAction';
import { createPluginSessionsInventory, type PluginSessionsInventoryParams } from './pluginSessionsInventory';
import { projectExternalShareableTranscriptPage } from './transcript/projectExternalShareableTranscriptPage';
import { createChannelsJourneyFixture } from '../../../../../packages/plugins/channels/src/testkit/channelsJourney';
import { createCurrentConversationConnectionFixture } from '../../../../../packages/plugins/channels/src/testkit/currentConnectionFixture';
import { CHANNEL_STATE_COLLECTION, CHANNEL_DELIVERIES_COLLECTION } from '../../../../../packages/plugins/channels/src/collections';
import { CHANNELS_PROVIDER_POINT_REF } from '../../../../../packages/plugins/channels/src/manifest';
import { createConversationSessionProjectionFrontierRow } from '../../../../../packages/plugins/channels/src/sessionProjection';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';

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
    transport: { kind: 'poll' }, endpoint: thread ? { kind: 'thread', audience: 'direct', id: 'thread-1', parentId: endpoint.id } : endpoint,
    actor: { principalId: 'sender-1', label: 'Ada', kind: 'human', isIntegrationSelf: false },
    message: { id, text, providerTimestamp: now, addressingEvidence: 'none', contentProvenance: 'original' } });
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

async function journey(input: { router?: boolean; socket?: boolean; wrongDelivery?: boolean; wrongSessionCaller?: boolean } = {}) {
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
  const turns: SessionTurnV1[] = [];
  const admissions: Array<SessionPendingEnqueueByMachineRequestV1 | SessionPendingExecutionRunEnqueueByMachineRequestV2> = [];
  const creations = new Map<string, string>();
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
  const { executor } = createCliActionExecutorHarness({ token: 'journey-token', credentials: { token: 'journey-token', encryption: null },
    sessionId: 'session-journey-1', mode: 'plain', ctx: null, rawSession: {}, serverId: 'server-1', serverHttpBaseUrl: 'https://channels-home.example.test',
    actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettingsParse({}) }),
    sessionSpawnDirectTargetTransport: { machineId: 'machine-1',
      prepare: async () => ({ ok: true, directory: '/repo/channels', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
      spawnedSession: { spawn: async raw => {
        const request = SpawnDaemonSessionRequestSchema.parse(raw);
        spawnRequests.push(request);
        if (!request.existingSessionId || !sessions.has(request.existingSessionId)) throw new Error('Spawn must reach the real committed Session');
        const session = sessions.get(request.existingSessionId)!;
        sessions.set(session.id, { ...session, active: true, activeAt: Date.now() });
        return { type: 'success', sessionId: request.existingSessionId };
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
        content: { t: 'plain', v: { ...body, meta: { ...meta, happierInputAuthorityV1: authority, happierProvenanceV1: provenance } } } });
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
    if (action === 'session.transcript.get') {
      const request = record(value);
      const page = await projectExternalShareableTranscriptPage({ sessionId: String(request.sessionId), rows, turns,
        ctx: null, callerPluginId: 'happier.channels', cursorSeq: Number(request.cursor ?? 0), limit: 100,
        upstreamHasMore: false, publicationBlocked: false });
      ExternalShareableTranscriptPageV1Schema.parse(page);
      return { ok: true, result: { ok: true, sessionId: String(request.sessionId), projection: 'externalShareableV1', ...page } };
    }
    return await executor.execute(action, value, context);
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
          connectedServices: { v: 2, bindingsByServiceId: {} }, memoryEnabled: false } }] }
        : { kind: 'session', sessionId: 'session-journey-1', policy }), allowedPrincipalIds: ['sender-1'], allowBotSenders: false,
      inputMode: 'allAllowedMessages', inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off' } };
  const core = await createChannelsJourneyFixture({ provider, connection, binding, sessions: inventory, actions,
    resolveCurrentPluginMaterializationRef: () => channelMaterialization }).catch(async error => {
      await provider.dispose(); http.mockRestore(); writes.mockRestore();
      vi.unstubAllGlobals(); resetServerFeaturesClientForTests();
      throw error;
    });
  activeCore = core;
  if (!input.router) await core.state.put(createConversationSessionProjectionFrontierRow({ bindingId: binding.id,
    targetSessionId: 'session-journey-1', transcriptCursor: null, lastScannedSeq: 0, revision: 1, now: Date.now() }), { expectedRevision: 'absent' });
  function answer(text: string) {
    const user = rows.at(-1);
    if (!user) throw new Error('Answer requires an admitted input');
    const seq = rows.length + 1;
    rows.push({ id: `answer-${seq}`, seq, localId: null, createdAt: Date.now(), messageRole: 'agent', sidechainId: null,
      content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text } } } });
    turns.push(SessionTurnV1Schema.parse({ turnId: `turn-${seq}`, status: 'completed', startedAt: 1, updatedAt: 2,
      transcriptAnchors: { startSeqInclusive: Number(user.seq), endSeqInclusive: seq, userMessageSeqs: [Number(user.seq)], finalAssistantMessageSeq: seq } }));
  }
  function validateWrites() {
    for (const [collection, schema] of [[core.state, CHANNEL_STATE_COLLECTION.schema], [core.deliveries, CHANNEL_DELIVERIES_COLLECTION.schema]] as const) {
      const compiled = compilePluginJsonSchema(schema);
      for (const row of collection.rows.values()) expect(isValidPluginJsonSchemaValue(compiled, row.value), row.rowId).toBe(true);
    }
  }
  return { ...core, pending, delivered, admissions, sessions, creations, spawnRequests, answer, validateWrites, rpcRequests,
    async dispose() { await core.dispose(); await provider.dispose(); http.mockRestore(); writes.mockRestore();
      activeCore = undefined;
      vi.unstubAllGlobals(); resetServerFeaturesClientForTests(); } };
}

describe('registered Channels composed journeys through real CLI Session admission', () => {
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
      expect(fixture.admissions).toHaveLength(1);
      expect(fixture.admissions[0]?.sessionId).toBe(archived.id);
      expect(fixture.sessions.get(archived.id)?.archivedAt).toBeNull();
      fixture.answer('Bonjour, votre demande est reçue.');
      await fixture.outward();
      await fixture.outward();
      expect(fixture.delivered).toEqual([expect.objectContaining({ content: { text: 'Bonjour, votre demande est reçue.' },
        replyContext: expect.objectContaining({ replyToMessageId: 'inbound-1' }) })]);
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

  it('starts through the registered Action and ordinary custody, then admits the reply to its named Session', async () => {
    const fixture = await journey({ router: true });
    try {
      await fixture.poll();
      await fixture.invoke('conversation/start-v1', { routerBindingId: 'binding-1', audienceGroupId: 'brief', sessionId: 'session-journey-1',
        subject: 'Morning brief', content: { text: 'Votre brief', html: `<main>${'brief '.repeat(20_000)}</main>` } });
      await fixture.outward();
      expect(fixture.delivered).toHaveLength(1);
      expect(fixture.delivered[0]?.newThread).toEqual({ recipients: ['sender-1'], subject: 'Morning brief' });
      fixture.pending.push(observation('brief-reply', 'Merci, une question', true)); await fixture.poll();
      expect(fixture.admissions.map(request => request.sessionId)).toEqual(['session-journey-1']);
      expect(fixture.creations.size).toBe(0);
      fixture.validateWrites();
    } finally { await fixture.dispose(); }
  });
});
