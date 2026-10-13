import { startBackgroundRuntimeInstallableUpdate } from '@/packagedRuntime/installables/startBackgroundUpdate';
import type { createRegistryUpdateCheck } from './registryUpdateTracker';

/** Reuses the installables interval and persisted key; no registry timer. */
export function startBackgroundRegistryUpdateCheck(checker: Pick<ReturnType<typeof createRegistryUpdateCheck>, 'runBackgroundAutoUpdateCheck'>): Promise<void> {
  return startBackgroundRuntimeInstallableUpdate({ installableKey: 'registry-items', adapter: checker });
}
