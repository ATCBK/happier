import { accessSync, constants, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Installed npm metadata owns its executable name; a missing/ambiguous bin is unavailable. */
export function resolveManagedPackageBin(params: Readonly<{
  workspaceDir: string; packageName: string; version: string; bin?: string;
}>): string | null {
  try {
    const metadata: unknown = JSON.parse(readFileSync(join(params.workspaceDir, 'node_modules', params.packageName, 'package.json'), 'utf8'));
    if (!metadata || typeof metadata !== 'object' || !('name' in metadata) || metadata.name !== params.packageName
      || !('version' in metadata) || metadata.version !== params.version || !('bin' in metadata)) return null;
    const bins = typeof metadata.bin === 'string'
      ? { [params.packageName.split('/').at(-1)!]: metadata.bin }
      : metadata.bin && typeof metadata.bin === 'object' && !Array.isArray(metadata.bin) ? metadata.bin : null;
    if (!bins) return null;
    const candidates = Object.entries(bins).filter(([, path]) => typeof path === 'string' && path.length > 0).map(([name]) => name);
    const bin = params.bin ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!bin || !candidates.includes(bin) || bin === '.' || bin === '..' || /[\\/]/.test(bin)) return null;
    accessSync(join(params.workspaceDir, 'node_modules', '.bin', process.platform === 'win32' ? `${bin}.cmd` : bin), process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return bin;
  } catch { return null; }
}
