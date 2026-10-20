import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionMigration } from '@happier-dev/plugin-sdk/collections';
import { PluginMachineExecutionOriginV1Schema, getPluginMachineExecutionRouting } from '@happier-dev/plugin-sdk/actions';
import { arePluginMachineExecutionOriginsEqual } from '@happier-dev/plugin-sdk';
import { ConversationProviderConnectionStopInputV1Schema, conversationConnectionWebhookSourceInstanceIdV1 } from '@happier-dev/channels-protocol/v1';

/** Canonical Data contribution identifiers; never publish camelCase aliases. */
export const CHANNEL_STATE_COLLECTION_ID = 'channel-state';
export const CHANNEL_DELIVERIES_COLLECTION_ID = 'channel-deliveries';
export const CHANNEL_STATE_MIGRATIONS_ARTIFACT_ID = 'channel-state-migrations';

export const CHANNEL_STATE_FIELD = {
  id: 'id',
  recordKind: 'record-kind',
  version: 'v',
  connectionId: 'connection-id',
  bindingId: 'binding-id',
  terminal: 'terminal',
  attention: 'attention',
  dueAt: 'due-at',
  createdAt: 'created-at',
  updatedAt: 'updated-at',
} as const;

export const CHANNEL_STATE_RECORD_KIND = {
  connection: 'connection',
  binding: 'binding',
  connectionIdentityKey: 'connection-identity-key',
  connectionReservation: 'connection-reservation',
  ingressObligation: 'ingress-obligation',
  ingressCensus: 'ingress-census',
  checkpoint: 'checkpoint',
  projectionFrontier: 'projection-frontier',
  sessionRotation: 'session-rotation',
} as const;

function isChannelStateJsonRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Pure target-artifact migration for DATA-EU7. Generic Data owns all source
 * reads, target staging, index readiness, and the authoritative cutover; this
 * callback transforms only the logical census shape it owns.
 */
export function migrateChannelStateV1ToV2(
  value: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  if (value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.ingressCensus) {
    return value;
  }
  const payload = value.payload;
  if (!isChannelStateJsonRecord(payload)) {
    throw new Error('A V1 ingress census must contain an object payload.');
  }
  return {
    ...value,
    [CHANNEL_STATE_FIELD.attention]: false,
    payload: { ...payload, conflict: null, compacted: null },
  };
}

function removeProviderSelectionGeneration(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> {
  if (!isChannelStateJsonRecord(value)) {
    throw new Error('A V2 provider contribution selection must be an object.');
  }
  const { immutableGenerationId: _retired, ...stableSelection } = value;
  return stableSelection;
}

/**
 * Contracts Channels persistence to stable contribution identity. Generation
 * is executable currentness owned by the host snapshot and must not strand an
 * otherwise-current connection after slot replacement or daemon restart.
 */
export function migrateChannelStateV2ToV3(
  value: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  const payload = value.payload;
  if (!isChannelStateJsonRecord(payload)) return value;
  if (value[CHANNEL_STATE_FIELD.recordKind] === CHANNEL_STATE_RECORD_KIND.connection) {
    const pendingOldTransportStop = payload.pendingOldTransportStop;
    return {
      ...value,
      payload: {
        ...payload,
        providerContributionSelection: removeProviderSelectionGeneration(
          payload.providerContributionSelection,
        ),
        ...(isChannelStateJsonRecord(pendingOldTransportStop)
          ? {
            pendingOldTransportStop: {
              ...pendingOldTransportStop,
              providerContributionSelection: removeProviderSelectionGeneration(
                pendingOldTransportStop.providerContributionSelection,
              ),
            },
          }
          : {}),
      },
    };
  }
  if (value[CHANNEL_STATE_FIELD.recordKind] === CHANNEL_STATE_RECORD_KIND.ingressObligation) {
    const target = payload.target;
    if (!isChannelStateJsonRecord(target) || target.kind !== 'event') return value;
    return {
      ...value,
      payload: {
        ...payload,
        target: {
          ...target,
          providerContributionSelection: removeProviderSelectionGeneration(
            target.providerContributionSelection,
          ),
        },
      },
    };
  }
  return value;
}

function migrateChannelDeliveriesV2ToV3(
  value: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  const payload = value.payload;
  if (!isChannelStateJsonRecord(payload) || typeof payload.content !== 'string') return value;
  return { ...value, payload: { ...payload, content: { text: payload.content } } };
}

/** Forward-only V7 custody contraction; generic Data owns admission and cutover. */
export function migrateChannelStateV7ToV8(value: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  const payload = value.payload;
  if (!isChannelStateJsonRecord(payload)) return value;
  function placement(origin: JsonValue | undefined, providerPluginId: JsonValue | undefined) {
    const parsed = PluginMachineExecutionOriginV1Schema.parse(origin);
    const routing = getPluginMachineExecutionRouting(parsed);
    if (routing.pluginId !== providerPluginId) throw new Error('V7 Channels origin disagrees with its provider plugin.');
    return { serverIdentityId: routing.serverIdentityId, machineId: routing.machineId };
  }
  if (value[CHANNEL_STATE_FIELD.recordKind] === CHANNEL_STATE_RECORD_KIND.ingressObligation) {
    const target = payload.target;
    if (!isChannelStateJsonRecord(target) || target.kind !== 'event') return value;
    return { ...value, payload: { ...payload, target: { ...target, executionOrigin: placement(target.executionOrigin, target.providerPluginId) } } };
  }
  if (value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.connection) return value;
  const transportOrigin = placement(payload.transportOrigin, payload.providerPluginId);
  const pending = payload.pendingOldTransportStop;
  if (pending === null) return { ...value, payload: { ...payload, transportOrigin } };
  if (!isChannelStateJsonRecord(pending) || !isChannelStateJsonRecord(pending.predecessorCheckpointedPollInvocation)) {
    throw new Error('V7 Channels connection has malformed predecessor custody.');
  }
  const oldPlacement = placement(pending.transportOrigin, payload.providerPluginId);
  const predecessorPlacement = placement(pending.predecessorCheckpointedPollInvocation.transportOrigin, payload.providerPluginId);
  if (!arePluginMachineExecutionOriginsEqual(
    PluginMachineExecutionOriginV1Schema.parse(pending.transportOrigin),
    PluginMachineExecutionOriginV1Schema.parse(pending.predecessorCheckpointedPollInvocation.transportOrigin),
  )) {
    throw new Error('V7 Channels predecessor invocation disagrees with old transport custody.');
  }
  if (pending.predecessorTransportKind === 'durablePush' && pending.endpointRetarget === 'pending') {
    const stop = ConversationProviderConnectionStopInputV1Schema.parse(pending.stopRequest);
    const transport = payload.transport;
    const origin = PluginMachineExecutionOriginV1Schema.parse(payload.transportOrigin);
    const predecessor = pending.predecessorCheckpointedPollInvocation;
    if (stop.reason !== 'transfer' || typeof pending.acceptedPossibleLoss !== 'boolean' || payload.deletionState !== 'none'
      || stop.connectionId !== value.id || value[CHANNEL_STATE_FIELD.connectionId] !== value.id
      || typeof predecessor.authorityEpoch !== 'number' || !Number.isSafeInteger(predecessor.authorityEpoch)
      || predecessor.authorityEpoch < 1 || predecessor.authorityEpoch >= Number.MAX_SAFE_INTEGER
      || predecessor.authorityEpoch + 1 !== stop.authorityEpoch
      || typeof predecessor.connectionRevision !== 'number' || !Number.isSafeInteger(predecessor.connectionRevision) || predecessor.connectionRevision < 1
      || typeof payload.authorityEpoch !== 'number' || !Number.isSafeInteger(payload.authorityEpoch)
      || (pending.acceptedPossibleLoss ? payload.authorityEpoch <= stop.authorityEpoch : stop.authorityEpoch !== payload.authorityEpoch)
      || !isChannelStateJsonRecord(transport) || transport.kind !== 'durablePush'
      || !isChannelStateJsonRecord(transport.webhookContributionRef) || transport.webhookContributionRef.pluginId !== payload.providerPluginId
      || transport.webhookSourceInstanceId !== conversationConnectionWebhookSourceInstanceIdV1(stop.connectionId)
      || !('materializationRef' in origin)) throw new Error('V7 Channels endpoint-retarget custody is incoherent.');
    return { ...value, payload: { ...payload, transportOrigin, pendingOldTransportStop: {
      kind: 'endpointRetarget', webhookEndpointId: transport.webhookEndpointId!, webhookContributionRef: transport.webhookContributionRef!,
      webhookSourceInstanceId: transport.webhookSourceInstanceId!, targetMaterialization: origin.materializationRef,
      transferAuthorityEpoch: payload.authorityEpoch,
    } } };
  }
  return { ...value, payload: { ...payload, transportOrigin, pendingOldTransportStop: {
    ...pending, transportOrigin: oldPlacement,
    predecessorCheckpointedPollInvocation: { ...pending.predecessorCheckpointedPollInvocation, transportOrigin: predecessorPlacement },
  } } };
}

export const CHANNEL_COLLECTION_MIGRATIONS = {
  [CHANNEL_STATE_COLLECTION_ID]: [{
    id: 'channel-state-v1-to-v2',
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    migrate: migrateChannelStateV1ToV2,
  }, {
    id: 'channel-state-v2-to-v3',
    fromSchemaVersion: 2,
    toSchemaVersion: 3,
    migrate: migrateChannelStateV2ToV3,
  }, {
    id: 'channel-state-v3-to-v4',
    fromSchemaVersion: 3,
    toSchemaVersion: 4,
    // Retained v3 declarations embedded the old contribution identity schema.
    // Reuse its migration; preserve materialized transport authority verbatim.
    // Candidate validation refuses source-custody origins instead of inventing authority.
    migrate: migrateChannelStateV2ToV3,
  }, {
    id: 'channel-state-v4-to-v5',
    fromSchemaVersion: 4,
    toSchemaVersion: 5,
    // Router targets, attachment descriptors and optional poll/binding facts
    // expand the retained state schema; existing logical rows need no rewrite.
    migrate: (value) => value,
  }, {
    id: 'channel-state-v5-to-v6',
    fromSchemaVersion: 5,
    toSchemaVersion: 6,
    // Freshness bounds widened inside the strict record union. Data cannot
    // prove same-version allOf/oneOf widening; every retained row stays valid.
    migrate: (value) => value,
  }, {
    id: 'channel-state-v6-to-v7',
    fromSchemaVersion: 6,
    toSchemaVersion: 7,
    // Exact source custody joins the canonical execution-origin union. The
    // strict retained materialized rows need no rewrite or invented authority.
    migrate: (value) => value,
  }, {
    id: 'channel-state-v7-to-v8',
    fromSchemaVersion: 7,
    toSchemaVersion: 8,
    migrate: migrateChannelStateV7ToV8,
  }, {
    id: 'channel-state-v8-to-v9',
    fromSchemaVersion: 8,
    toSchemaVersion: 9,
    migrate: (value, context) => {
      if (value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.connection) return value;
      if (!isChannelStateJsonRecord(value.payload)) throw new Error('V8 Channels connection has malformed payload.');
      return { ...value, payload: { ...value.payload, configurationRevision: context.currentRevision } };
    },
  }],
  [CHANNEL_DELIVERIES_COLLECTION_ID]: [{
    id: 'channel-deliveries-v1-to-v2',
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    migrate: (value) => value,
  }, {
    id: 'channel-deliveries-v2-to-v3',
    fromSchemaVersion: 2,
    toSchemaVersion: 3,
    // Retained text becomes the canonical content object. Compacted nulls,
    // structured content, custody identity and provider evidence stay intact.
    migrate: migrateChannelDeliveriesV2ToV3,
  }],
} satisfies Readonly<Record<string, readonly PluginAccountCollectionMigration[]>>;
