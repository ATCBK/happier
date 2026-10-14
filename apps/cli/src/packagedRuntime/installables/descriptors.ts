import type { InstallableKey, InstallablesRegistry, InstallableDependencyDescriptor } from '@happier-dev/protocol';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { resolveExecutableManagedDependenciesRegistry } from '@/plugins/projection/registry/managedDependencyExecutables';


export function readRuntimeInstallablesRegistry(): InstallablesRegistry {
  return resolveExecutableManagedDependenciesRegistry(readCurrentContributionRegistry().managedDependencies ?? []);
}

export function readRuntimeInstallableDescriptor(key: InstallableKey): InstallableDependencyDescriptor | null {
  return readRuntimeInstallablesRegistry().descriptorsByKey[key]?.descriptor ?? null;
}
