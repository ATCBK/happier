import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { listManagedAcpInstalls, removeManagedAcpInstall } from './managedAgentInstalls';

/** A complete observation of this daemon's Account is the only orphan-removal authority. */
export async function sweepRemovedAgentInstalls(input: Readonly<{
  accountId: string;
  catalog: AcpCatalogSnapshotV1;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  isCurrent(): boolean | Promise<boolean>;
  isDefinitionInUse(definitionId: string): boolean | Promise<boolean>;
}>): Promise<void> {
  if (input.catalog.status !== 'ready' || !await input.isCurrent()) return;
  const definitions = new Map(input.catalog.record.definitions.filter(definition => definition.launch.kind !== 'command')
    .map(definition => [definition.id, definition.launch.kind === 'command' ? undefined : definition.launch.version]));
  for (const install of await listManagedAcpInstalls({ env: input.env, accountId: input.accountId })) {
    input.signal?.throwIfAborted();
    if (!await input.isCurrent()) return;
    if (definitions.get(install.definitionId) === install.version) continue;
    await removeManagedAcpInstall({ accountId: input.accountId, definitionId: install.definitionId, version: install.version, env: input.env,
      signal: input.signal, isDefinitionInUse: async definitionId =>
        !await input.isCurrent() || await input.isDefinitionInUse(definitionId) });
  }
}
