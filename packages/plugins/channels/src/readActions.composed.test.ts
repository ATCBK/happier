import { describe, expect, it } from 'vitest';
import type { JsonValue, PluginServices } from '@happier-dev/plugin-sdk';
import { CHANNELS_PLUGIN, PLUGIN_MANIFEST } from './manifest.js';
import { CHANNEL_STATE_COLLECTION, CHANNEL_DELIVERIES_COLLECTION } from './collections.js';
import { MemoryCollection } from './testkit/memoryCollection.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';
import { ConversationBindingV1Schema, ConversationDeliveryReadResultV1Schema, ConversationNormalizedIngressV1Schema,
  CONVERSATION_OBSERVATION_TRANSPORT_KINDS_V1, CONVERSATION_OBSERVATION_ADDRESSING_EVIDENCE_V1,
  CONVERSATION_MESSAGE_CONTENT_PROVENANCE_V1 } from '@happier-dev/channels-protocol/v1';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { createConversationOutwardDeliveryCollectionStore } from './outwardDelivery.js';

function connection(connectionId: string) {
  return createCurrentConversationConnectionFixture({ connectionId, authority: {
    providerPluginId: 'test.channel.read', providerContributionSelection: { contributionId: 'fixture' },
    providerSetupInput: {}, credentialRef: null, providerConnectionKey: 'mailbox', providerConfig: {},
    routingIdentityKey: 'r'.repeat(43), integrationPrincipal: { id: 'bot' }, authorityEpoch: 1,
    transportOrigin: { serverIdentityId: 'srv_plugin_testkit', materializationRef: {
      pluginId: 'test.channel.read', machineId: 'machine-1', materializationId: 'read-provider',
    } },
  } });
}

async function readerKit() {
  const { createPluginTestkit } = await import('@happier-dev/plugin-sdk/testing');
  const state = new MemoryCollection<Record<string, JsonValue>>();
  const deliveries = new MemoryCollection<Record<string, JsonValue>>();
  await state.put(connection('connection-1'), { expectedRevision: 'absent' });
  // Account Collections are the persistence boundary; all projection,
  // registration, input admission and strict result validation remain real.
  const storage = { account: { collection(definition: { id: string }) {
    if (definition.id === CHANNEL_STATE_COLLECTION.id) return state;
    if (definition.id === CHANNEL_DELIVERIES_COLLECTION.id) return deliveries;
    throw new Error('Unexpected Collection');
  } } } as unknown as PluginServices['storage'];
  const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: CHANNELS_PLUGIN, services: { storage } });
  return { kit, state, deliveries };
}

describe('registered Channels Account read Actions', () => {
  it('pages router children and content-free ingress attention with exact recovery revisions', async () => {
    const { kit, state } = await readerKit();
    try {
      for (const id of ['child-a', 'child-b']) {
        const { v, id: bindingId, connectionId, createdAt, updatedAt, ...payload } = ConversationBindingV1Schema.parse({
          v: 1, id, connectionId: 'connection-1', parentBindingId: 'router-1',
          endpoint: { kind: 'thread', audience: 'shared', id: `private-${id}`, parentId: 'mailbox' },
          target: { kind: 'session', sessionId: `session-${id}`, policy: { deliveryMode: 'repliesOnly',
            permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
          allowedPrincipalIds: ['private@example.test'], allowBotSenders: false, inputMode: 'allAllowedMessages',
          inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1,
          enabled: true, deletionState: 'none', createdAt: 1, updatedAt: 1,
        });
        await state.put({ id: bindingId, 'record-kind': 'binding', v, 'connection-id': connectionId,
          'binding-id': bindingId, 'created-at': createdAt, 'updated-at': updatedAt, payload }, { expectedRevision: 'absent' });
      }
      const first = await kit.invokeAction('binding/list-v1', { parentBindingId: 'router-1', limit: 1 }, { surface: 'agent' });
      expect(first).toMatchObject({ bindings: [{ bindingId: 'child-a', parentBindingId: 'router-1', revision: 1 }], nextCursor: expect.any(String) });
      const cursor = (first as { nextCursor: string }).nextCursor;
      expect(await kit.invokeAction('binding/list-v1', { parentBindingId: 'another-router', limit: 1 }, { surface: 'agent' }))
        .toMatchObject({ bindings: [], nextCursor: cursor });
      expect(await kit.invokeAction('binding/list-v1', { parentBindingId: 'router-1', limit: 1, cursor }, { surface: 'mcp' }))
        .toMatchObject({ bindings: [{ bindingId: 'child-b', revision: 1 }] });
      expect(JSON.stringify(first)).not.toMatch(/private@example|private-child/);
      const censusId = 'c'.repeat(43);
      const normalizedIngress = ConversationNormalizedIngressV1Schema.parse({ kind: 'fullText', observation: {
        v: 1, occurrenceId: 'private-occurrence', occurredAt: 100,
        transport: { kind: CONVERSATION_OBSERVATION_TRANSPORT_KINDS_V1[0] },
        endpoint: { kind: 'direct', audience: 'direct', id: 'private-mailbox' },
        actor: { kind: 'human', principalId: 'private@example.test', isIntegrationSelf: false },
        message: { id: 'private-message', providerTimestamp: 100, contentProvenance: CONVERSATION_MESSAGE_CONTENT_PROVENANCE_V1[0],
          addressingEvidence: CONVERSATION_OBSERVATION_ADDRESSING_EVIDENCE_V1[0], text: 'private-body' },
      } });
      const census = { id: censusId, 'record-kind': 'ingress-census', v: 1, 'connection-id': 'connection-1',
        'created-at': 100, 'updated-at': 101, attention: true,
        payload: { normalizedIngress, compacted: null, phase: 'prepared', connectionAuthorityEpoch: 1,
          maximumObservationAgeMs: 60_000, checkpointCoveredAt: null, eventCandidate: null,
          conflict: { kind: 'occurrenceEvidenceMismatch' }, matchedBindings: [] } };
      expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema), census)).toBe(true);
      await state.put(census, { expectedRevision: 'absent' });
      const ingress = await kit.invokeAction('ingress/attention-v1', { limit: 1 }, { surface: 'agent' });
      expect(ingress)
        .toMatchObject({ obligations: [{ kind: 'occurrenceConflict', censusId, connectionId: 'connection-1', revision: 1 }] });
      expect(JSON.stringify(ingress)).not.toMatch(/private-body|private@example|private-mailbox/);
    } finally { await kit.dispose(); }
  });

  it('reads real custody transitions and recovery facts without exposing the delivery body or key', async () => {
    const { kit, state, deliveries } = await readerKit();
    try {
      const store = createConversationOutwardDeliveryCollectionStore({ stateCollection: state,
        deliveriesCollection: deliveries as unknown as Parameters<typeof createConversationOutwardDeliveryCollectionStore>[0]['deliveriesCollection'],
        signal: new AbortController().signal, now: () => 100 });
      const accepted = await store.ensure({ connectionId: 'connection-1', bindingId: 'binding-1',
        routeAuthority: { connectionAuthorityEpoch: 1, bindingRevision: 1, bindingAuthorityEpoch: 1 },
        source: { kind: 'controlResponse', controlId: 'control-1', controlKind: 'newSession' },
        endpoint: { kind: 'direct', audience: 'direct', id: 'private-endpoint' },
        content: { text: 'private-body' }, deliveryKey: 'private-delivery-key', mentionPolicy: 'suppress', linkPreviewPolicy: 'suppress',
      });
      if (accepted.kind !== 'created') throw new Error(`Expected custody, got ${accepted.kind}`);
      const custodyId = accepted.record.custodyId;
      const pending = ConversationDeliveryReadResultV1Schema.parse(await kit.invokeAction('delivery/read-v1', { custodyId }, { surface: 'mcp' }));
      expect(pending).toMatchObject({ kind: 'ready', delivery: { custodyId, revision: 1, state: 'ready', lastOutcome: 'pending' } });
      const updated = await store.compareAndSwap({ custodyId, expectedRevision: 1,
        custody: { state: 'outcomeUnknown', attemptCount: 1, providerMessageIds: [] } });
      expect(updated.kind).toBe('updated');
      const attention = await kit.invokeAction('delivery/attention-v1', { connectionId: 'connection-1', limit: 1 }, { surface: 'agent' });
      expect(attention).toMatchObject({ rows: [{ custodyId, revision: 2, state: 'outcomeUnknown' }] });
      const unknown = await kit.invokeAction('delivery/read-v1', { custodyId }, { surface: 'agent' });
      expect(unknown).toMatchObject({ kind: 'ready', delivery: { revision: 2, lastOutcome: 'unknown', projection: { attention: true } } });
      expect(JSON.stringify([pending, attention, unknown])).not.toMatch(/private-body|private-delivery-key|private-endpoint/);
      await store.compareAndSwap({ custodyId, expectedRevision: 2,
        custody: { state: 'delivered', attemptCount: 1, providerMessageIds: ['private-native-id'] } });
      expect(await kit.invokeAction('delivery/read-v1', { custodyId }, { surface: 'mcp' }))
        .toMatchObject({ kind: 'ready', delivery: { revision: 3, lastOutcome: 'delivered' } });
    } finally { await kit.dispose(); }
  });
  it('reads an exact custody id through the safe delivery registration', async () => {
    const { kit } = await readerKit();
    try {
      await expect(kit.invokeAction('delivery/read-v1', { custodyId: 'd'.repeat(43) }, { surface: 'agent' }))
        .resolves.toEqual({ kind: 'notFound' });
    } finally { await kit.dispose(); }
  });

  it('enumerates current connection revisions through the same safe projection as the UI', async () => {
    const { kit, state } = await readerKit();
    try {
      await state.put(connection('connection-2'), { expectedRevision: 'absent' });
      const first = await kit.invokeAction('connection/list-v1', { limit: 1 }, { surface: 'mcp' });
      expect(first).toMatchObject({ connections: [{ connectionId: 'connection-1', revision: 1 }], nextCursor: expect.any(String) });
      const page = first as { nextCursor: string };
      expect(await kit.invokeAction('connection/list-v1', { limit: 1, cursor: page.nextCursor }, { surface: 'mcp' }))
        .toMatchObject({ connections: [{ connectionId: 'connection-2', revision: 1 }] });
      expect(JSON.stringify(first)).not.toMatch(/providerConfig|credentialRef|routingIdentityKey/);
    } finally { await kit.dispose(); }
  });
});
