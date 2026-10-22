import { describe, expect, it } from 'vitest';
import type { JsonValue, PluginServices } from '@happier-dev/plugin-sdk';
import { CHANNELS_PLUGIN, PLUGIN_MANIFEST } from './manifest.js';
import { CHANNEL_STATE_COLLECTION, CHANNEL_DELIVERIES_COLLECTION } from './collections.js';
import { MemoryCollection } from './testkit/memoryCollection.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';
import { ConversationBindingV1Schema, ConversationDeliveryAttentionResultV1Schema, ConversationDeliveryReadResultV1Schema, ConversationNormalizedIngressV1Schema,
  CONVERSATION_OBSERVATION_TRANSPORT_KINDS_V1, CONVERSATION_OBSERVATION_ADDRESSING_EVIDENCE_V1,
  CONVERSATION_MESSAGE_CONTENT_PROVENANCE_V1 } from '@happier-dev/channels-protocol/v1';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { createConversationOutwardDeliveryCollectionStore } from './outwardDelivery.js';
import { getActionSpec } from '@happier-dev/plugin-sdk/actions';

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
  it('recommends the Account reconnect Action for an expired saved credential without returning provider setup', async () => {
    const { kit, state } = await readerKit();
    try {
      const current = connection('connection-1');
      const account = { service: { pluginId: 'test.channel.read', localId: 'account' }, accountId: 'account-1' };
      await state.put({ ...current, payload: { ...current.payload, credentialRef: account,
        providerReadiness: { code: 'providerCredentialInvalid' } } }, { expectedRevision: 1 });
      const result = await kit.invokeAction('connection/list-v1', {}, { surface: 'mcp' });
      expect(result).toMatchObject({ connections: [{ recommendedRecovery: {
        action: 'connectedServices.authentication.beginReconnect', input: { account, machineId: 'machine-1' },
      } }] });
      expect(JSON.stringify(result)).not.toMatch(/providerSetupInput|providerConfig|routingIdentityKey/);
      const reconnect = getActionSpec('connectedServices.authentication.beginReconnect');
      expect(reconnect.id).toBe('connectedServices.authentication.beginReconnect');
    } finally { await kit.dispose(); }
  });
  it.each<Readonly<{ name: string; payload: Readonly<Record<string, JsonValue>>; action: string; input: JsonValue }>>([
    { name: 'paused', payload: { enabled: false }, action: 'connection/update-v1', input: { connectionId: 'connection-1', expectedRevision: 1, enabled: true, maximumObservationAgeMs: 60_000 } },
    { name: 'permission loss', payload: { providerReadiness: { code: 'providerPermissionMissing' } }, action: 'connection/retest-v1', input: { connectionId: 'connection-1', expectedRevision: 1, authorityEpoch: 1 } },
    { name: 'expired credential', payload: { providerReadiness: { code: 'providerCredentialInvalid' } }, action: 'connection/retest-v1', input: { connectionId: 'connection-1', expectedRevision: 1, authorityEpoch: 1 } },
    { name: 'blocked poll', payload: { pollFailure: { phase: 'blocked', attemptCount: 1, retryNotBeforeMs: null, evidence: { kind: 'provider', reason: 'permissionMissing' } } }, action: 'connection/poll-retry-v1', input: { connectionId: 'connection-1', expectedRevision: 1, authorityEpoch: 1 } },
    { name: 'history gap', payload: { historyGap: { reportedAt: 100, reason: 'providerHistoryUnavailable' } }, action: 'stream/baseline-accept-v1', input: { connectionId: 'connection-1', expectedRevision: 1 } },
    { name: 'provider configuration loss', payload: { providerReadiness: { code: 'providerConfigurationInvalid' } }, action: 'connection/retest-v1', input: { connectionId: 'connection-1', expectedRevision: 1, authorityEpoch: 1 } },
  ])('recommends one registered recovery Action for $name from the canonical read', async ({ payload, action, input }) => {
    const { kit, state } = await readerKit();
    try {
      const current = connection('connection-1');
      await state.put({ ...current, payload: { ...current.payload, ...payload } }, { expectedRevision: 1 });
      const result = await kit.invokeAction('connection/list-v1', {}, { surface: 'agent' });
      expect(result).toMatchObject({ connections: [{ recommendedRecovery: {
        action: { pluginId: 'happier.channels', localId: action }, input,
      } }] });
      const declaration = PLUGIN_MANIFEST.contributes?.actions?.find(row => row.id === action);
      expect(declaration?.surfaces).toEqual(expect.arrayContaining(['ui', 'agent', 'mcp']));
      if (!declaration?.inputSchema) throw new Error('Recovery Action must declare its input contract');
      expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(declaration.inputSchema), input)).toBe(true);
      if (action === 'connection/update-v1' || action === 'connection/poll-retry-v1') {
        expect(await kit.invokeAction(action, input, { surface: 'agent' })).toMatchObject({
          kind: action === 'connection/update-v1' ? 'updated' : 'retryScheduled',
        });
      }
    } finally { await kit.dispose(); }
  });

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
      expect(first).toMatchObject({ bindings: [{ bindingId: 'child-a', parentBindingId: 'router-1', revision: 1,
        target: { kind: 'session', sessionId: 'session-child-a' } }], nextCursor: expect.any(String) });
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
      expect(await kit.invokeAction('connection/list-v1', {}, { surface: 'agent' })).toMatchObject({ connections: [{
        recommendedRecovery: { action: { pluginId: 'happier.channels', localId: 'connection/poll-retry-v1' },
          input: { connectionId: 'connection-1', expectedRevision: 1, authorityEpoch: 1 }, reason: 'occurrenceEvidenceMismatch' },
      }] });
      const ingress = await kit.invokeAction('ingress/attention-v1', { limit: 1 }, { surface: 'agent' });
      expect(ingress)
        .toMatchObject({ obligations: [{ kind: 'occurrenceConflict', censusId, connectionId: 'connection-1', revision: 1 }] });
      expect(ingress).toMatchObject({ obligations: [{ recommendedRecovery: {
        action: { pluginId: 'happier.channels', localId: 'connection/list-v1' }, input: {},
      } }] });
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
      expect(attention).toMatchObject({ rows: [{ custodyId, bindingId: 'binding-1', revision: 2, state: 'outcomeUnknown', acceptedPartCount: 0 }] });
      const unknown = await kit.invokeAction('delivery/read-v1', { custodyId }, { surface: 'agent' });
      expect(unknown).toMatchObject({ kind: 'ready', delivery: { revision: 2, lastOutcome: 'unknown', projection: { attention: true } } });
      expect(unknown).toMatchObject({ kind: 'ready', delivery: { recommendedRecovery: {
        action: { pluginId: 'happier.channels', localId: 'delivery/resolve-v1' },
        input: { custodyId, expectedRevision: 2 }, unavailableReason: 'ownerDecisionRequired',
      } } });
      const partial = await store.compareAndSwap({ custodyId, expectedRevision: 2,
        custody: { state: 'partial', attemptCount: 1, providerMessageIds: ['accepted-first-chunk'], failedChunk: 1 } });
      expect(partial.kind).toBe('updated');
      const partialRead = await kit.invokeAction('delivery/read-v1', { custodyId }, { surface: 'agent' });
      const partialAttention = await kit.invokeAction('delivery/attention-v1', { connectionId: 'connection-1' }, { surface: 'agent' });
      expect(partialAttention).toMatchObject({ rows: [{ custodyId, bindingId: 'binding-1', revision: 3, state: 'partial', acceptedPartCount: 1, failedChunk: 1 }] });
      expect(partialRead).toMatchObject({ kind: 'ready', delivery: { recommendedRecovery: {
        action: { pluginId: 'happier.channels', localId: 'delivery/resolve-v1' },
        input: { custodyId, expectedRevision: 3 }, reason: 'partial', unavailableReason: 'ownerDecisionRequired',
      } } });
      // The installed external provider above owns several conversations on the
      // same connection; connection-only feedback must not borrow either one.
      const { bindingId: _bindingId, routeAuthority: _routeAuthority, ...connectionObligation } = accepted.record.obligation;
      const additionalCustodyIds: string[] = [];
      for (const bindingId of ['binding-2', undefined]) {
        const created = await store.ensure({ ...connectionObligation,
          ...(bindingId === undefined ? { routeAuthority: { connectionAuthorityEpoch: 1 } }
            : { bindingId, routeAuthority: { connectionAuthorityEpoch: 1, bindingRevision: 1, bindingAuthorityEpoch: 1 } }),
          deliveryKey: `private-delivery-key-${bindingId ?? 'connection'}`,
          content: { text: 'private-body' },
          source: { kind: 'controlResponse', controlId: `control-${bindingId ?? 'connection'}`, controlKind: 'recovery' },
        });
        if (created.kind !== 'created') throw new Error('Expected additional custody');
        additionalCustodyIds.push(created.record.custodyId);
        expect((await store.compareAndSwap({ custodyId: created.record.custodyId, expectedRevision: 1,
          custody: { state: 'outcomeUnknown', attemptCount: 1, providerMessageIds: [] } })).kind).toBe('updated');
      }
      const groupedAttention = await kit.invokeAction('delivery/attention-v1', { connectionId: 'connection-1' }, { surface: 'mcp' });
      expect(groupedAttention).toMatchObject({ rows: expect.arrayContaining([
        expect.objectContaining({ custodyId, bindingId: 'binding-1' }),
        expect.objectContaining({ custodyId: additionalCustodyIds[0], bindingId: 'binding-2' }),
      ]) });
      const parsedAttention = ConversationDeliveryAttentionResultV1Schema.parse(groupedAttention);
      expect(parsedAttention.rows).toHaveLength(3);
      expect(parsedAttention.rows.find(row => row.custodyId === additionalCustodyIds[1])).not.toHaveProperty('bindingId');
      expect(JSON.stringify([pending, attention, unknown, partialAttention, groupedAttention])).not.toMatch(/private-body|private-delivery-key|private-endpoint|accepted-first-chunk/);
      await store.compareAndSwap({ custodyId, expectedRevision: 3,
        custody: { state: 'delivered', attemptCount: 1, providerMessageIds: ['private-native-id'] } });
      expect(await kit.invokeAction('delivery/read-v1', { custodyId }, { surface: 'mcp' }))
        .toMatchObject({ kind: 'ready', delivery: { revision: 4, lastOutcome: 'delivered' } });
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
