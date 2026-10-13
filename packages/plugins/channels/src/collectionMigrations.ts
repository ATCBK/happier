import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionMigration } from '@happier-dev/plugin-sdk/collections';

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
