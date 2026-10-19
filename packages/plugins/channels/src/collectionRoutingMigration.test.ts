import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHANNEL_COLLECTION_MIGRATIONS, migrateChannelStateV7ToV8 } from './collectionMigrations.js';
import { CHANNEL_STATE_COLLECTION } from './collections.js';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';

const retained = JSON.parse(readFileSync(new URL('./testkit/fixtures/channelStateV7.json', import.meta.url), 'utf8'));
const retainedV8 = JSON.parse(readFileSync(new URL('./testkit/fixtures/channelStateV8.json', import.meta.url), 'utf8'));
const predecessor = { serverIdentityId: 'srv_v7fixture', materializationRef: {
  pluginId: 'happier.channel.example', machineId: 'machine-predecessor', materializationId: 'old-materialization',
} };
function retainedPendingConnection() {
  return { ...retained.connection, payload: { ...retained.connection.payload, pendingOldTransportStop: {
    predecessorCheckpointedPollInvocation: { connectionRevision: 7, authorityEpoch: 7, transportOrigin: predecessor },
    transportOrigin: predecessor, providerContributionSelection: { contributionId: 'provider' },
    stopRequest: { v: 1, connectionId: retained.connection.id, providerConnectionKey: 'retained-mailbox',
      providerConfigVersion: 1, providerConfig: { mailbox: 'Old inbox' }, credentialRef: null, authorityEpoch: 8, reason: 'transfer' },
    predecessorTransportKind: 'checkpointedPull', endpointRetarget: 'notRequired', overlapSafety: 'safe', acceptedPossibleLoss: false,
  } } };
}

describe('Channels retained V8 configuration revision migration', () => {
  it('seeds the logical configuration revision from the host physical revision without changing custody or cursors', async () => {
    expect(retainedV8.collection.schemaVersion).toBe(8);
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(retainedV8.collection.schema), retainedV8.connection)).toBe(true);
    const edge = CHANNEL_COLLECTION_MIGRATIONS['channel-state'].find(step => step.fromSchemaVersion === 8);
    expect(edge).toMatchObject({ toSchemaVersion: 9 });
    if (edge === undefined) throw new Error('Missing V8→V9 migration');
    const migrated = await edge.migrate(retainedV8.connection, { currentRevision: 14 });
    expect(migrated).toEqual({ ...retainedV8.connection, payload: { ...retainedV8.connection.payload, configurationRevision: 14 } });
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema), migrated)).toBe(true);
    expect(await edge.migrate(retainedV8.checkpoint, { currentRevision: 22 })).toEqual(retainedV8.checkpoint);
  });
});

describe('Channels retained V7 routing migration', () => {
  it('preserves the pinned retained connection while contracting its origin to placement', async () => {
    expect(retained.collection.schemaVersion).toBe(7);
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(retained.collection.schema), retained.connection)).toBe(true);
    const edge = CHANNEL_COLLECTION_MIGRATIONS['channel-state'].find(step => step.fromSchemaVersion === 7);
    expect(edge).toMatchObject({ toSchemaVersion: 8 });
    const migrated = await edge!.migrate(retained.connection, { currentRevision: 14 });
    expect(migrated).toEqual({ ...retained.connection, payload: { ...retained.connection.payload,
      transportOrigin: { serverIdentityId: 'srv_v7fixture', machineId: 'machine-v7' },
    } });
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(retainedV8.collection.schema), migrated)).toBe(true);
  });
  it('preserves real predecessor stop and checkpoint invocation facts', () => {
    const source = retainedPendingConnection();
    const migrated = migrateChannelStateV7ToV8(source);
    const old = source.payload.pendingOldTransportStop;
    expect(migrated).toEqual({ ...source, payload: { ...source.payload,
      transportOrigin: { serverIdentityId: 'srv_v7fixture', machineId: 'machine-v7' },
      pendingOldTransportStop: { ...old, transportOrigin: { serverIdentityId: 'srv_v7fixture', machineId: 'machine-predecessor' },
        predecessorCheckpointedPollInvocation: { ...old.predecessorCheckpointedPollInvocation,
          transportOrigin: { serverIdentityId: 'srv_v7fixture', machineId: 'machine-predecessor' } } },
    } });
  });
  it('contracts frozen Event retry placement while preserving its immutable input and the checkpoint cursor', () => {
    const source = retained.eventObligation;
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(retained.collection.schema), source)).toBe(true);
    const migrated = migrateChannelStateV7ToV8(source);
    expect(migrated).toEqual({ ...source, payload: { ...source.payload, target: { ...source.payload.target,
      executionOrigin: { serverIdentityId: 'srv_v7fixture', machineId: 'machine-v7' },
    } } });
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(retainedV8.collection.schema), migrated)).toBe(true);
    expect(migrateChannelStateV7ToV8(retained.checkpoint)).toEqual(retained.checkpoint);
  });
  it('rejects a mismatched full predecessor custody even when its placement agrees', () => {
    const source = retainedPendingConnection();
    source.payload.pendingOldTransportStop.predecessorCheckpointedPollInvocation.transportOrigin = {
      ...predecessor, materializationRef: { ...predecessor.materializationRef, materializationId: 'different-custody' },
    };
    expect(() => migrateChannelStateV7ToV8(source)).toThrow();
  });
  it('rejects an origin naming a different provider before erasing that identity', () => {
    const source = { ...retained.connection, payload: { ...retained.connection.payload,
      transportOrigin: { ...predecessor, materializationRef: { ...predecessor.materializationRef, pluginId: 'another.plugin' } },
    } };
    expect(() => migrateChannelStateV7ToV8(source)).toThrow();
  });
  it.each([false, true])('contracts endpoint custody without losing repair intent (legacy accepted marker: %s)', (accepted) => {
    const vector = retained.retainedEndpointVectors;
    const { kind: _transportKind, ...endpoint } = vector.transport;
    const source = { ...retained.connection, payload: { ...retained.connection.payload,
      authorityEpoch: accepted ? vector.acceptedCurrentAuthorityEpoch : 8,
      replayContinuity: 'none',
      transport: vector.transport,
      pendingOldTransportStop: { ...vector.pendingOldTransportStop, acceptedPossibleLoss: accepted },
    } };
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(retained.collection.schema), source)).toBe(true);
    const migrated = migrateChannelStateV7ToV8(source);
    expect(migrated).toEqual({ ...source, payload: { ...source.payload,
      transportOrigin: { serverIdentityId: 'srv_v7fixture', machineId: 'machine-v7' },
      pendingOldTransportStop: { kind: 'endpointRetarget', ...endpoint,
        targetMaterialization: source.payload.transportOrigin.materializationRef,
        transferAuthorityEpoch: source.payload.authorityEpoch,
      },
    } });
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(retainedV8.collection.schema), migrated)).toBe(true);
  });
});
