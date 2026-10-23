import { join } from 'node:path';

/** Canonical Home-local paths shared by configuration and information pages. */
export function resolveCliHomeStoragePaths(happyHomeDir: string) {
  return {
    logsDir: join(happyHomeDir, 'logs'),
    settingsFile: join(happyHomeDir, 'settings.json'),
    serversDir: join(happyHomeDir, 'servers'),
  };
}
