import type { SherpaNativeModule } from '@happier-dev/sherpa-native';

import { fileUriToNativePath } from '@/voice/modelPacks/nativePath';

import type { InstallerOverrides } from './types';

export type InstallerSherpaNative = Pick<SherpaNativeModule, 'release' | 'excludeFromBackup'>;

async function getSherpaNative(overrides: InstallerOverrides): Promise<InstallerSherpaNative | null> {
  if (overrides.sherpaNative !== undefined) return overrides.sherpaNative;
  try {
    const { getOptionalHappierSherpaNativeModule } = await import('@happier-dev/sherpa-native');
    return getOptionalHappierSherpaNativeModule();
  } catch {
    // Builds without the native speech module have no engines to unload and nothing to exclude.
    return null;
  }
}

/**
 * Native engines keep the pack's models loaded per assets dir. Unload them before the pack's files are
 * replaced or deleted so the next use loads the current build instead of a stale cached engine.
 */
export async function releaseModelPackEngines(overrides: InstallerOverrides, dirUri: string): Promise<void> {
  const native = await getSherpaNative(overrides);
  if (!native?.release) return;
  try {
    await native.release({ assetsDir: fileUriToNativePath(dirUri) });
  } catch (error) {
    console.warn('[modelPacks] Failed to release native speech engines', error instanceof Error ? error.name : 'unknown');
  }
}

// The backup flag persists on the directory, so each dir is marked once per process (per native module) instead
// of on every pack use. A failed attempt is forgotten so the next use retries it.
const excludedDirsByNative = new WeakMap<InstallerSherpaNative, Set<string>>();

async function excludeFromBackup(native: InstallerSherpaNative, dirUri: string): Promise<void> {
  if (!native.excludeFromBackup) return;
  let excluded = excludedDirsByNative.get(native);
  if (!excluded) {
    excluded = new Set();
    excludedDirsByNative.set(native, excluded);
  }
  if (excluded.has(dirUri)) return;
  excluded.add(dirUri);
  try {
    await native.excludeFromBackup({ path: fileUriToNativePath(dirUri) });
  } catch (error) {
    excluded.delete(dirUri);
    console.warn('[modelPacks] Failed to exclude model pack from backup', error instanceof Error ? error.name : 'unknown');
  }
}

/**
 * Packs are large and re-downloadable, so they stay out of device backups. Runs in the background: pack use
 * never waits on it, and a failure is only logged.
 */
export function excludeModelPackDirFromBackup(overrides: InstallerOverrides, dirUri: string): void {
  void getSherpaNative(overrides).then((native) => (native ? excludeFromBackup(native, dirUri) : undefined));
}
