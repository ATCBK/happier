import { join } from 'node:path';
import type { PluginStorePaths } from './paths';

export function resolvePluginStorePathLayout(happyHomeDir: string): PluginStorePaths {
  const rootDir = join(happyHomeDir, 'plugins', 'plugins');
  const stateDir = join(rootDir, 'state');
  return Object.freeze({
    happyHomeDir,
    rootDir,
    stateDir,
    registryCurrentFilePath: join(stateDir, 'plugin-registry-current.v1.json'),
    registryCommitLockFilePath: join(stateDir, 'plugin-registry-commit.v1.lock'),
    stateRevisionsDir: join(rootDir, 'state-revisions'),
    generationsDir: join(rootDir, 'generations'),
    npmRegistryProfilesFilePath: join(stateDir, 'npm-registry-profiles.v1.json'),
    installedDir: join(rootDir, 'installed'),
    cacheDir: join(rootDir, 'cache'),
    logsDir: join(rootDir, 'logs'),
    locksDir: join(rootDir, 'locks'),
    storageDir: join(rootDir, 'storage'),
    secretsDir: join(rootDir, 'secrets'),
    settingsDir: join(rootDir, 'settings'),
  });
}

