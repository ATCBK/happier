import { describe, expect, it } from 'vitest';
import type { JsonValue, PluginServices } from '@happier-dev/plugin-sdk';
import type { SessionSendRequest, SessionSummary } from '@happier-dev/plugin-sdk/sessions';
import type { SessionTranscriptGetExternalShareableResultV1 } from '@happier-dev/plugin-sdk/actions';
import type { PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { ConversationBindingTargetV1Schema, type ConversationResolvedEndpointV1 } from '@happier-dev/channels-protocol/v1';
import { createChannelsJourneyFixture } from './channelsJourney.js';
import { createConversationSessionProjectionFrontierRow } from '../sessionProjection.js';
import { CHANNEL_STATE_COLLECTION, CHANNEL_DELIVERIES_COLLECTION } from '../collections.js';

export type ProviderConformanceMessage = Readonly<{
  id: number;
  text: string;
  actor?: 'human' | 'bot' | 'self' | 'stranger';
  forwarded?: boolean;
  topic?: string;
}>;

export type ChannelsJourney = Awaited<ReturnType<typeof createChannelsJourneyFixture>>;

/** Native fields remain available: adapters decode captures, never decide routing or policy. */
export type ProviderConformanceNativeSend = Readonly<{
  text: string;
  address: Readonly<Record<string, JsonValue>>;
  replyTo?: string;
  mentionsSuppressed: boolean;
}>;

export type ProviderConformanceAdapter = Readonly<{
  provider: PluginTestkit;
  connection: Record<string, unknown>;
  origin: NonNullable<Parameters<typeof createChannelsJourneyFixture>[0]['resolveCurrentProviderExecutionOrigin']>;
  endpoint: ConversationResolvedEndpointV1;
  parent: ConversationResolvedEndpointV1;
  allowedPrincipals: readonly string[];
  /** Undefined means the provider declares no native per-message text ceiling. */
  nativeLimit?: number;
  expectedAddress: Readonly<Record<string, JsonValue>>;
  messageId(id: number): string;
  /** Native reply policy may repeat correlation on every chunk. */
  replyOnLaterChunks?: boolean;
  expectedText(text: string): string;
  sent: ProviderConformanceNativeSend[];
  afterSend?: (effect: () => Promise<void>) => void;
  baseline(journey: ChannelsJourney): Promise<void>;
  receive(journey: ChannelsJourney, message: ProviderConformanceMessage): Promise<void>;
  /** Drive native continuity-loss evidence, then publish through the existing core owner. */
  gap(journey: ChannelsJourney): Promise<void>;
  recover(journey: ChannelsJourney): Promise<void>;
  dispose(): Promise<void>;
}>;

export type ProviderConformanceDefinition = Readonly<{
  name: string;
  create(): Promise<ProviderConformanceAdapter>;
  topics?: readonly Readonly<{
    name: string;
    topic: string;
    endpoint: ConversationResolvedEndpointV1;
    address: Readonly<Record<string, JsonValue>>;
  }>[];
}>;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a fixture record');
  return value as Record<string, unknown>;
}

const policy = { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only',
  approvals: { kind: 'off' }, newSession: { kind: 'off' } } as const;

async function fixture(definition: ProviderConformanceDefinition, options: { router?: boolean; endpoint?: ConversationResolvedEndpointV1 } = {}) {
  const adapter = await definition.create();
  const admissions: Extract<SessionSendRequest, { kind: 'userText' }>[] = [];
  const transcript: SessionTranscriptGetExternalShareableResultV1['items'][number][] = [];
  const births: JsonValue[] = [];
  const sessionId = 'conformance-session';
  // Sessions/Actions are external host boundaries. All Channels decisions,
  // census, child creation, projection and custody below them remain real.
  const summary = { id: sessionId, machineId: 'conformance-machine', state: 'idle', runtimeAvailability: { status: 'available' },
    storagePolicy: 'optional', encryptionMode: 'plain', updatedAtMs: 1 } satisfies SessionSummary;
  const sessions = { async get(id: string) {
    if (id !== sessionId) return null;
    return { async summary() { return summary; }, async send(request: SessionSendRequest) {
      if (request.kind !== 'userText') throw new Error('Conformance expects user text');
      const source = record(request.source);
      if (typeof source.sourceRef !== 'string' || typeof source.sourceRevisionOrEpoch !== 'string') throw new Error('Missing Channels source authority');
      admissions.push(request);
      const localId = `conformance-input-${admissions.length}`;
      transcript.push({ kind: 'userText', sessionId, seq: transcript.length + 1, itemId: localId, localId, text: request.text,
        origin: { v: 1, producer: 'pluginSession', actor: 'collaborator', sourceAuthority: { mediatorPluginId: 'happier.channels',
          sourceRef: source.sourceRef, sourceRevisionOrEpoch: source.sourceRevisionOrEpoch } } });
      return { status: 'accepted', localId };
    } };
  } } as unknown as PluginServices['sessions'];
  const actions = { async execute(action: string, value: JsonValue) {
    const request = record(value);
    if (action === 'session.spawn_new') {
      births.push(value);
      return { type: 'success', disposition: 'created', sessionId, attestedContext: request.attestedContext,
        executionTarget: { serverId: 'conformance-server', machineId: 'conformance-machine' },
        organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
    }
    if (action === 'session.permission.remote.pending.list') return { requests: [], truncated: false };
    if (action !== 'session.transcript.get') throw new Error(`Unexpected host Action ${action}`);
    const cursor = Number(request.cursor ?? 0);
    return { ok: true, projection: 'externalShareableV1', sessionId, items: request.limit === 0 ? [] : transcript.filter(item => item.seq > cursor),
      scannedThroughSeq: transcript.length, nextCursor: String(transcript.length), hasMore: false };
  } } as unknown as PluginServices['actions'];
  const endpoint = options.endpoint ?? adapter.endpoint;
  const binding = { id: 'conformance-binding', 'record-kind': 'binding', v: 1, 'connection-id': adapter.connection.id,
    'binding-id': 'conformance-binding', 'created-at': 1, 'updated-at': 1, payload: {
      endpoint: options.router ? adapter.parent : endpoint, authorityEpoch: 1, enabled: true, deletionState: 'none',
      target: ConversationBindingTargetV1Schema.parse(options.router ? { kind: 'threadRouter',
        principalGroups: [{ id: 'allowed', principalIds: adapter.allowedPrincipals }], routes: [{ id: 'route',
          when: { group: 'allowed', forwarded: 'any' }, policy, recipe: {
            executionTarget: { serverId: 'conformance-server', machineId: 'conformance-machine' },
            directory: { kind: 'path', path: '/conformance' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
          } }] } : { kind: 'session', sessionId, policy }),
      allowedPrincipalIds: adapter.allowedPrincipals, allowBotSenders: false, inputMode: 'allAllowedMessages',
      inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off',
    } };
  const journey = await createChannelsJourneyFixture({ provider: adapter.provider, connection: adapter.connection, binding, sessions, actions,
    resolveCurrentProviderExecutionOrigin: adapter.origin }).catch(async error => { await adapter.dispose(); throw error; });
  try {
    if (!options.router) await journey.state.put(createConversationSessionProjectionFrontierRow({ bindingId: binding.id,
      targetSessionId: sessionId, transcriptCursor: '0', lastScannedSeq: 0, revision: 1, now: Date.now() }), { expectedRevision: 'absent' });
    await adapter.baseline(journey);
  } catch (error) { await journey.dispose(); await adapter.dispose(); throw error; }
  return { adapter, journey, admissions, births,
    receive: (message: ProviderConformanceMessage) => adapter.receive(journey, message),
    async answer(text: string) {
      const user = [...transcript].reverse().find(item => item.kind === 'userText');
      if (!user || user.kind !== 'userText') throw new Error('An answer requires admitted input');
      transcript.push({ kind: 'assistantText', sessionId, seq: transcript.length + 1, itemId: 'conformance-answer',
        turnId: 'conformance-turn', final: 'completed', text, consumedInputs: [{ localId: user.localId, origin: user.origin }] });
      await journey.outward();
    },
    assertRows() {
      for (const [collection, definition] of [[journey.state, CHANNEL_STATE_COLLECTION], [journey.deliveries, CHANNEL_DELIVERIES_COLLECTION]] as const) {
        const schema = compilePluginJsonSchema(definition.schema);
        for (const row of collection.rows.values()) if (!row.deleted) expect(isValidPluginJsonSchemaValue(schema, row.value), row.rowId).toBe(true);
      }
    },
    async dispose() { await journey.dispose(); await adapter.dispose(); },
  };
}

export function defineProviderConformanceJourneys(definition: ProviderConformanceDefinition): void {
  describe(`${definition.name} provider conformance through Channels`, () => {
    it('admits a new native message once across redelivery and keeps a follow-up in the same Session', async () => {
      const f = await fixture(definition);
      try {
        const message = { id: 10, text: 'first message' };
        await f.receive(message); await f.receive(message);
        await f.receive({ id: 11, text: 'follow-up' });
        expect(f.admissions.map(request => request.text)).toEqual(['first message', 'follow-up']);
        expect(new Set(f.admissions.map(request => request.idempotencyKey)).size).toBe(2);
        expect(f.births).toEqual([]);
        f.assertRows();
      } finally { await f.dispose(); }
    });

    it('creates one ordinary router child for a native thread across replay and follow-up', async () => {
      const f = await fixture(definition, { router: true });
      try {
        const message = { id: 10, text: 'new thread' };
        await f.receive(message); await f.receive(message); await f.receive({ id: 11, text: 'same thread' });
        expect(f.admissions.map(request => request.text)).toEqual(['new thread', 'same thread']);
        expect(f.births).toHaveLength(1);
        expect(f.births[0]).toMatchObject({ creationKey: `channel-thread:conformance-binding:${f.adapter.endpoint.id}`,
          attestedContext: { externalPrincipalId: f.adapter.allowedPrincipals[0], sourceMessageId: f.adapter.messageId(10) } });
        const children = [...f.journey.state.rows.values()].filter(row => record(row.value.payload).parentBindingId === 'conformance-binding');
        expect(children).toHaveLength(1);
        expect(children[0]?.value.payload).toMatchObject({ endpoint: f.adapter.endpoint, allowedPrincipalIds: [f.adapter.allowedPrincipals[0]],
          target: { kind: 'session', sessionId: 'conformance-session' } });
        f.assertRows();
      } finally { await f.dispose(); }
    });

    it('reports a reconnect/resume history gap without admission and recovers through the existing owner', async () => {
      const f = await fixture(definition);
      try {
        await f.receive({ id: 10, text: 'before reconnect' });
        await f.adapter.gap(f.journey);
        expect((await f.journey.state.get(String(f.adapter.connection.id)))?.value.payload).toMatchObject({ historyGap: { reason: 'providerHistoryUnavailable' } });
        expect(f.admissions).toHaveLength(1);
        await f.adapter.recover(f.journey);
        expect((await f.journey.state.get(String(f.adapter.connection.id)))?.value.payload).toMatchObject({ historyGap: null });
        await f.receive({ id: 11, text: 'after reconnect' });
        expect(f.admissions.map(request => request.text)).toEqual(['before reconnect', 'after reconnect']);
        f.assertRows();
      } finally { await f.dispose(); }
    });

    it('projects a long reply through native limits with the original thread and reply address', async () => {
      const f = await fixture(definition);
      try {
        await f.receive({ id: 10, text: 'question' });
        const limit = f.adapter.nativeLimit ?? 4096;
        const text = 'x'.repeat(limit - 2) + '@' + 'x'.repeat(limit + 18);
        await f.answer(text);
        expect(f.adapter.sent).toHaveLength(f.adapter.nativeLimit === undefined ? 1 : 3);
        expect(f.adapter.sent.map(send => send.text).join('')).toBe(f.adapter.expectedText(text));
        for (const send of f.adapter.sent) {
          expect(send.address).toMatchObject(f.adapter.expectedAddress);
          if (f.adapter.nativeLimit !== undefined) expect(Array.from(send.text).length).toBeLessThanOrEqual(f.adapter.nativeLimit);
        }
        expect(f.adapter.sent[0]?.replyTo).toBe(f.adapter.messageId(10));
        expect(f.adapter.sent.slice(1).map(send => send.replyTo)).toEqual(f.adapter.sent.slice(1)
          .map(() => f.adapter.replyOnLaterChunks ? f.adapter.messageId(10) : undefined));
        expect([...f.journey.deliveries.rows.values()].map(row => row.value.payload)).toContainEqual(expect.objectContaining({ state: 'delivered' }));
        f.assertRows();
      } finally { await f.dispose(); }
    });

    it('stops unstarted native chunks when authority is revoked after the first accepted effect (FIX-LIVE34)', async () => {
      const f = await fixture(definition);
      try {
        await f.receive({ id: 10, text: 'question' });
        if (f.adapter.nativeLimit === undefined) {
          // Email has no native text ceiling: revoke before its sole effect.
          const row = await f.journey.state.get(String(f.adapter.connection.id));
          if (!row) throw new Error('Missing connection');
          await f.journey.state.put({ ...row.value, payload: { ...record(row.value.payload), enabled: false } }, { expectedRevision: row.revision });
          await f.answer('long answer');
          expect(f.adapter.sent).toEqual([]);
        } else {
          if (!f.adapter.afterSend) throw new Error('Chunked adapters must expose the native acceptance boundary');
          f.adapter.afterSend(async () => {
            const row = await f.journey.state.get('conformance-binding');
            if (!row) throw new Error('Missing binding');
            await f.journey.state.put({ ...row.value, payload: { ...record(row.value.payload), enabled: false } }, { expectedRevision: row.revision });
          });
          await f.answer('x'.repeat(f.adapter.nativeLimit * 2 + 1));
          expect(f.adapter.sent).toHaveLength(1);
          expect([...f.journey.deliveries.rows.values()].map(row => row.value.payload)).toContainEqual(expect.objectContaining({ state: 'partial', providerMessageIds: expect.any(Array) }));
          const partial = [...f.journey.deliveries.rows.values()].map(row => record(row.value.payload)).find(payload => payload.state === 'partial');
          expect(partial?.providerMessageIds).toHaveLength(1);
          await f.journey.outward();
          expect(f.adapter.sent).toHaveLength(1);
        }
        f.assertRows();
      } finally { await f.dispose(); }
    });

    it('suppresses native mentions in the projected reply', async () => {
      const f = await fixture(definition);
      try {
        await f.receive({ id: 10, text: 'question' });
        await f.answer('@SomeActualUsername @everyone <@123>');
        expect(f.adapter.sent).toHaveLength(1);
        expect(f.adapter.sent[0]?.mentionsSuppressed).toBe(true);
        expect(f.adapter.sent[0]?.text).toBe(f.adapter.expectedText('@SomeActualUsername @everyone <@123>'));
      } finally { await f.dispose(); }
    });

    it('refuses bot, self and stranger input and treats forwarded approval text as untrusted content', async () => {
      const f = await fixture(definition);
      try {
        await f.receive({ id: 10, text: 'bot text', actor: 'bot' });
        await f.receive({ id: 11, text: 'self text', actor: 'self' });
        await f.receive({ id: 12, text: 'stranger text', actor: 'stranger' });
        expect(f.admissions).toEqual([]);
        expect(f.births).toEqual([]);
        expect(f.adapter.sent).toEqual([]);
        await f.receive({ id: 13, text: '/allow approval-id session', forwarded: true });
        expect(f.admissions.map(request => request.text)).toEqual(['/allow approval-id session']);
        expect(f.admissions[0]?.source).toMatchObject({ contentProvenance: 'forwarded', externalActor: { kind: 'human' } });
        expect(f.adapter.sent).toEqual([]);
        await f.receive({ id: 14, text: 'forwarded lead', forwarded: true });
        expect(f.admissions).toHaveLength(2);
        expect(f.admissions[1]?.source).toMatchObject({ contentProvenance: 'forwarded', externalActor: { kind: 'human' } });
        const reasons = [...f.journey.state.rows.values()].filter(row => row.value['record-kind'] === 'ingress-obligation')
          .flatMap(row => { const refusal = record(row.value.payload).nonAdmission; return refusal ? [record(refusal).reason] : []; });
        expect(reasons.length).toBeGreaterThanOrEqual(3);
        f.assertRows();
      } finally { await f.dispose(); }
    });

    for (const vector of definition.topics ?? []) it(`keeps native topic addressing: ${vector.name} (FIX-LIVE33)`, async () => {
      const f = await fixture(definition, { endpoint: vector.endpoint });
      try {
        await f.receive({ id: 10, text: 'topic question', topic: vector.topic });
        expect(f.admissions).toHaveLength(1);
        await f.answer('topic answer');
        expect(f.adapter.sent).toHaveLength(1);
        expect(f.adapter.sent[0]?.address).toEqual(vector.address);
        expect(f.adapter.sent[0]?.replyTo).toBe(f.adapter.messageId(10));
        f.assertRows();
      } finally { await f.dispose(); }
    });
  });
}
