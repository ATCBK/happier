import { accessSync, constants, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { withWorkspaceBundleLock } from '../../../workspaceBundleLock.mjs';
import { execFileWithDeadline, ExecFileTerminationError } from '../../process/index.js';
import { buildManagedUvEnvironment, ensureManagedUvCommand } from '../managedUv.js';
import { readManagedAcpInstallNamespace } from '../managedAcpInstallIdentity.js';
import { resolveAgentCliManagedInstallRootForRuntime } from '../resolution.js';
import { normalizePypiProjectName } from '../pypiWheelAsset/resolve.js';
import type { AgentInstallProgressCallback } from '../installProgress.js';

export type ManagedUvAgentSpec = Readonly<{ id: string; definitionId: string; title: string; package: string; version: string; command?: string }>;
export type ManagedUvAgentMetadata = Readonly<{ definitionId: string; title: string; kind: 'uv'; version: string; package: string; command: string }>;

function executableName(command: string): string {
  return `${command}${process.platform === 'win32' && !command.endsWith('.exe') ? '.exe' : ''}`;
}

export function buildManagedUvAgentEnvironment(spec: Pick<ManagedUvAgentSpec, 'id'>, env: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const current = join(resolveAgentCliManagedInstallRootForRuntime(spec, { processEnv: env }), 'current');
  return { ...buildManagedUvEnvironment(env), UV_PYTHON_INSTALL_DIR: join(current, 'python'), UV_TOOL_DIR: join(current, 'tools'), UV_TOOL_BIN_DIR: join(current, 'bin') };
}

export async function readManagedUvAgentMetadata(spec: Pick<ManagedUvAgentSpec, 'id'>, env: NodeJS.ProcessEnv): Promise<ManagedUvAgentMetadata | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(resolveAgentCliManagedInstallRootForRuntime(spec, { processEnv: env }), 'current', 'uv.json'), 'utf8'));
    if (!value || typeof value !== 'object'
      || !('kind' in value) || value.kind !== 'uv'
      || !('definitionId' in value) || typeof value.definitionId !== 'string'
      || !('title' in value) || typeof value.title !== 'string'
      || !('version' in value) || typeof value.version !== 'string'
      || !('package' in value) || typeof value.package !== 'string'
      || !('command' in value) || typeof value.command !== 'string' || !value.command
      || /[\\/]/.test(value.command) || basename(value.command) !== value.command
      || !readManagedAcpInstallNamespace(spec.id, value.definitionId, value.version)) return null;
    return { definitionId: value.definitionId, title: value.title, kind: 'uv', version: value.version, package: value.package, command: value.command };
  } catch (error) {
    if (error instanceof SyntaxError || error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function executable(path: string): boolean {
  try { if (!statSync(path).isFile()) return false; accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return true; }
  catch { return false; }
}

export async function resolveManagedUvAgentCommand(spec: ManagedUvAgentSpec, env: NodeJS.ProcessEnv): Promise<string | null> {
  const metadata = await readManagedUvAgentMetadata(spec, env);
  if (!metadata || metadata.package !== spec.package || metadata.version !== spec.version || metadata.definitionId !== spec.definitionId) return null;
  const command = spec.command ? executableName(spec.command) : metadata.command;
  if (/[\\/]/.test(command) || command !== metadata.command) return null;
  const path = join(buildManagedUvAgentEnvironment(spec, env).UV_TOOL_BIN_DIR!, command);
  return executable(path) ? path : null;
}

export async function installManagedUvAgent(params: Readonly<{
  spec: ManagedUvAgentSpec; env: NodeJS.ProcessEnv; signal?: AbortSignal; onProgress?: AgentInstallProgressCallback;
  runCommand?: typeof execFileWithDeadline;
}>): Promise<void> {
  const { spec, env, signal } = params;
  signal?.throwIfAborted();
  if (!readManagedAcpInstallNamespace(spec.id, spec.definitionId, spec.version)) throw new Error('Invalid managed uv Agent identity');
  const uv = await ensureManagedUvCommand(env, {}, { signal, onProgress: params.onProgress });
  if (!uv) throw new Error('Managed uv is unavailable');
  const root = resolveAgentCliManagedInstallRootForRuntime(spec, { processEnv: env });
  await withWorkspaceBundleLock(async () => {
    if (await resolveManagedUvAgentCommand(spec, env)) return;
    // uv virtual environments embed absolute interpreter paths. Install at the
    // final version-qualified location instead of renaming a staged venv.
    const childEnv = { ...env, ...buildManagedUvAgentEnvironment(spec, env) };
    await mkdir(childEnv.UV_TOOL_DIR!, { recursive: true });
    await mkdir(childEnv.UV_TOOL_BIN_DIR!, { recursive: true });
    try {
      await (params.runCommand ?? execFileWithDeadline)(uv, ['tool', 'install', `${spec.package}==${spec.version}`], { env: childEnv, signal, encoding: 'utf8', windowsHide: true });
      const entries = (await readdir(childEnv.UV_TOOL_BIN_DIR!)).filter(name => executable(join(childEnv.UV_TOOL_BIN_DIR!, name)));
      // Like uvx, prefer the package's named executable when it exports several
      // tools. A sole differently named executable needs no authored override.
      const named = executableName(spec.command ?? spec.package);
      const packageName = executableName(normalizePypiProjectName(spec.package));
      const command = spec.command || entries.includes(named) ? named : entries.includes(packageName) ? packageName
        : entries.length === 1 ? entries[0] : undefined;
      if (!command || /[\\/]/.test(command) || !entries.includes(command)) throw new Error('Installed uv Agent has no unambiguous executable');
      const metadata: ManagedUvAgentMetadata = { definitionId: spec.definitionId, title: spec.title, kind: 'uv', package: spec.package, version: spec.version, command };
      await writeFile(join(root, 'current', 'uv.json'), JSON.stringify(metadata), { mode: 0o600 });
    } catch (error) {
      // The CLI supplies its existing process-tree termination owner. A failed
      // containment retains bytes; ordinary settled failures remain retryable.
      if (!(error instanceof ExecFileTerminationError)) await rm(join(root, 'current'), { recursive: true, force: true });
      throw error;
    }
  }, { signal, lockPath: join(root, '.lock', 'bootstrap.lock'), errorLabel: 'managed uv Agent install lock' });
}

/** Called only by the existing managed ACP removal owner after its live-use guard. */
export async function uninstallManagedUvAgent(spec: Pick<ManagedUvAgentSpec, 'id'>, env: NodeJS.ProcessEnv, signal?: AbortSignal,
  runCommand: typeof execFileWithDeadline = execFileWithDeadline): Promise<void> {
  const metadata = await readManagedUvAgentMetadata(spec, env);
  if (!metadata) throw new Error('No managed uv Agent receipt');
  const uv = await ensureManagedUvCommand(env, {}, { signal });
  if (!uv) throw new Error('Managed uv is unavailable');
  await runCommand(uv, ['tool', 'uninstall', metadata.package], {
    env: { ...env, ...buildManagedUvAgentEnvironment(spec, env) }, signal, encoding: 'utf8', windowsHide: true,
  });
}
