import { isDeepStrictEqual } from 'node:util';
import { registryUpstreamEqualV1, type RegistryUpstreamV1 } from '@happier-dev/protocol/registries';
import type { CliAcpCatalogStore } from '../acpCatalogStore';
import { requireReadyAcpCatalog } from '../configured/resolveBackend';
import type { RegistryUpdateTrackerV1 } from '@/registries/updates/registryUpdateTracker';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

/** Observations use the existing Account catalog CAS and never advance a launch pin. */
export function createAgentRegistryUpdateTracker(input: Readonly<{
  store: Pick<CliAcpCatalogStore, 'readCatalog' | 'updateCatalog'>;
}>): RegistryUpdateTrackerV1 {
  const current = async () => requireReadyAcpCatalog(await input.store.readCatalog());
  return {
    kind: 'agent',
    async list() {
      return (await current()).record.definitions.flatMap(definition => definition.origin?.kind === 'registry' ? [{
        key: definition.id, provenance: definition.origin.provenance,
        ...(definition.origin.upstream ? { upstream: definition.origin.upstream } : {}),
      }] : []);
    },
    async record(changes) {
      for (const change of changes) {
        const snapshot = await current();
        const shouldRecord = (origin: (typeof snapshot.record.definitions)[number]['origin'], upstream: RegistryUpstreamV1) =>
          origin?.kind === 'registry' && (!change.provenance || isDeepStrictEqual(origin.provenance, change.provenance))
          && !registryUpstreamEqualV1(origin.upstream, upstream);
        if (!shouldRecord(snapshot.record.definitions.find(definition => definition.id === change.key)?.origin, change.upstream)) continue;
        const result = await input.store.updateCatalog(raw => {
          const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: raw && typeof raw === 'object' ? Reflect.get(raw, 'backends') : undefined });
          const definition = record.definitions.find(entry => entry.id === change.key);
          if (!definition?.origin || !shouldRecord(definition.origin, change.upstream)) return raw;
          return { v: 2, backends: record.definitions.map(entry => entry.id === change.key
            ? { ...entry, origin: { ...definition.origin, upstream: change.upstream } } : entry) };
        }, { expectedRevision: snapshot.revision, ...(snapshot.revision === 'absent' ? { sourceSettingsVersion: snapshot.sourceSettingsVersion } : {}) });
        if (result.status === 'updated' || result.status === 'unchanged') continue;
        if (result.status === 'conflict') {
          const definition = (await current()).record.definitions.find(entry => entry.id === change.key);
          if (!shouldRecord(definition?.origin, change.upstream)) continue;
        }
        throw Object.assign(new Error('Agent registry observation was not recorded'), { code: `agent_registry_update_${result.status}` });
      }
    },
  };
}
