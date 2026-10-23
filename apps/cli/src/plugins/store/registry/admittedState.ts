import type { PluginStorePaths } from '../paths';
import type { PluginStateFileV1 } from '../state';
import type { PluginRegistryCommitRecord } from './commitRecord';
import type { PluginInstallationStateRevision } from './generationStore';
import { readAdmittedPluginRegistryCommitRecord } from './commitRecordFile';
import { readAdmittedInstallationStateRevision } from './installationStateRevisionFile';

/** Read-only declarations: never use this result for activation or invocation. */
export async function readAdmittedPluginRegistryState(paths: PluginStorePaths): Promise<Readonly<{
  commit: PluginRegistryCommitRecord;
  revision: PluginInstallationStateRevision;
  catalog: PluginStateFileV1;
}> | null> {
  const commit = await readAdmittedPluginRegistryCommitRecord(paths);
  if (!commit) return null;
  const revision = await readAdmittedInstallationStateRevision({ paths, reference: commit.installationState, commit });
  const catalog = revision.runtimeCatalog;
  if (!catalog) {
    throw new Error('Current plugin registry revision has no canonical runtime catalog');
  }
  return { commit, revision, catalog };
}
