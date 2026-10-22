import { userInfo } from 'node:os';
import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { withExclusiveFileLock, writeAtomicTextFile } from '@happier-dev/plugin-sdk/fs';
import type { LoggerService } from '@happier-dev/plugin-sdk';
import { resolveCodexHome } from '../../mcp/configServers.js';
import { parseCodexCliStableVersion } from '../../cli/detect.js';

type StartupConfiguration = Readonly<{
  processEnv: Readonly<Record<string, string | undefined>>;
  versionOutput?: string;
  readVersion?: () => Promise<string>;
  configOverrides?: readonly string[];
  cwd?: string;
}>;

async function mayExist(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

async function resolveStartupRoot(configuration: StartupConfiguration, sqliteHome: string): Promise<string | null> {
  // Pin the explicit materializer projection instead of reimplementing native
  // config precedence. Native 0.162.1 managed requirements can override even -c.
  // Cloud requirements depend on disk/keyring auth; unresolved starts retain
  // the predecessor OS-user lock, without publishing a warm marker.
  if (process.platform !== 'linux') return null;
  const home = resolveCodexHome(configuration.processEnv);
  // Any uninspected config layer could select keyring auth, enabling a cloud
  // exact requirement even without auth.json. Do not guess its effective value.
  const configPaths = [join(home, 'config.toml'), '/etc/codex/config.toml'];
  for (let cwd = resolve(configuration.cwd ?? process.cwd());;) {
    configPaths.push(join(cwd, '.codex', 'config.toml'));
    const parent = dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  if (configuration.configOverrides?.some(value => /^\s*cli_auth_credentials_store\s*=/u.test(value))) return null;
  if ((await Promise.all([
    '/etc/codex/requirements.toml', '/etc/codex/managed_config.toml',
    join(home, 'auth.json'), join(home, 'cloud-config-bundle-cache.json'),
    ...configPaths,
  ].map(mayExist))).some(Boolean)) return null;
  await mkdir(sqliteHome, { recursive: true });
  return await realpath(sqliteHome);
}

async function isWarm(root: string, markerPath: string, version: string): Promise<boolean> {
  if (await readFile(markerPath, 'utf8').catch(() => null) !== `${version}\n`) return false;
  const files = await readdir(root);
  for (const file of files) {
    if (!/^state_\d+\.sqlite$/u.test(file)) continue;
    const fileState = await stat(join(root, file)).catch(() => null);
    if (fileState?.isFile() && fileState.size > 0) return true;
  }
  return false;
}

/** Exclude first initialization/migration, leaving warm starts independent. */
export async function withCodexNativeStartupLock<TResult>(
  initialize: (configOverrides: readonly string[]) => Promise<TResult>,
  signal?: AbortSignal,
  logger?: Pick<LoggerService, 'debug'>,
  configuration?: StartupConfiguration,
): Promise<TResult> {
  signal?.throwIfAborted();
  const projectedRoot = configuration?.processEnv.CODEX_SQLITE_HOME;
  const requestedRoot = projectedRoot && isAbsolute(projectedRoot)
    && !configuration?.configOverrides?.some(value => /^\s*sqlite_home\s*=/u.test(value))
    ? projectedRoot : null;
  const candidateRoot = configuration && requestedRoot ? await resolveStartupRoot(configuration, requestedRoot) : null;
  const versionOutput = candidateRoot && configuration
    ? configuration.versionOutput ?? await configuration.readVersion?.() ?? '' : '';
  const version = parseCodexCliStableVersion(versionOutput)?.value;
  const root = version ? candidateRoot : null;
  const launchRoot = root ?? requestedRoot;
  const overrides = [
    ...(configuration?.configOverrides ?? []),
    ...(launchRoot ? [`sqlite_home=${JSON.stringify(launchRoot)}`] : []),
  ];
  // Unresolved starts may open any of these roots. Share their predecessor
  // lock for first initialization/version changes; warm resolved starts skip it.
  const lockPath = join(userInfo().homedir, '.happier-codex-native-startup.lock');
  const markerPath = join(root ?? userInfo().homedir, '.happier-codex-native-startup.version');
  if (root && version && await isWarm(root, markerPath, version)) {
    signal?.throwIfAborted();
    return await initialize(overrides);
  }
  return await withExclusiveFileLock({
    lockPath,
    timeoutMs: Number.POSITIVE_INFINITY,
    ...(signal ? { signal } : {}),
    ...(logger ? { onWait: info => logger.debug('Codex native startup is waiting for another start', info) } : {}),
  }, async () => {
    const result = await initialize(overrides);
    if (root && version) {
      // Readiness is the native completion boundary. A failed start never
      // publishes; marker IO failure merely makes the next start lock again.
      await writeAtomicTextFile({ path: markerPath, contents: `${version}\n`, mode: 0o600 })
        .catch(() => {
          try { logger?.debug('Codex native startup version could not be recorded'); }
          catch { /* Diagnostics must not turn a ready native client into a failed start. */ }
        });
    }
    return result;
  });
}
