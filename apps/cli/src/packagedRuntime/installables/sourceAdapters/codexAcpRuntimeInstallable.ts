import { compareVersions } from '@happier-dev/cli-common/update';
import type { CapabilityId, InstallableDependencyDescriptor, InstallableKey } from '@happier-dev/protocol';
import { resolveManagedDependencyCommand, validateManagedDependencyCommand, type ManagedDependencyCommand } from '@happier-dev/cli-common/agents';
import { readRuntimeInstallableDescriptor } from '@/packagedRuntime/installables/descriptors';

import {
  getCodexAcpDepStatus,
  resolveExistingCodexAcpManagedBinPath,
} from '@/capabilities/deps/codexAcp';
import { logger } from '@/ui/logger';
import type {
  RuntimeInstallableAdapter,
  RuntimeInstallableLaunchCommandResolution,
  RuntimeInstallableLaunchResolution,
} from '@/packagedRuntime/installables/registry';

type DetectDeps = Readonly<{
  resolveCodexAcpSpawn: () => ManagedDependencyCommand;
  validateCodexAcpSpawnAvailability: (spec: ManagedDependencyCommand, opts?: Readonly<{ env?: NodeJS.ProcessEnv }>) => ReturnType<typeof validateManagedDependencyCommand>;
  resolveExistingCodexAcpManagedBinPath: typeof resolveExistingCodexAcpManagedBinPath;
}>;

type BackgroundUpdateDeps = Readonly<{
  getCodexAcpDepStatus: typeof getCodexAcpDepStatus;
  installOrUpgrade: RuntimeInstallableAdapter['installOrUpgrade'];
}>;

function launchHelpers(descriptor?: InstallableDependencyDescriptor) {
  const current = descriptor ?? readRuntimeInstallableDescriptor('codex-acp');
  const declaration = current?.source.kind === 'github_release_binary' && current.source.launch?.kind === 'codexAcp' ? current.source.launch : undefined;
  const binaryName = current?.binary.commands[0];
  if (!current || !declaration || !binaryName) throw new Error('Codex ACP launch declaration is unavailable');
  return {
    resolveSpawnSpec: (env: NodeJS.ProcessEnv, resolveExistingManagedBinPath: typeof resolveExistingCodexAcpManagedBinPath) => resolveManagedDependencyCommand({
      binaryName, displayName: current.display.name, declaration, env, resolveExistingManagedBinPath,
    }),
    validateAvailability: (spec: ManagedDependencyCommand, opts?: Readonly<{ env?: NodeJS.ProcessEnv }>) => validateManagedDependencyCommand(spec, binaryName, opts),
  };
}

function hasExplicitCodexAcpOverride(env: NodeJS.ProcessEnv, descriptor?: InstallableDependencyDescriptor): boolean {
  const current = descriptor ?? readRuntimeInstallableDescriptor('codex-acp');
  const declaration = current?.source.kind === 'github_release_binary' && current.source.launch?.kind === 'codexAcp' ? current.source.launch : undefined;
  const key = declaration?.overrideEnvironmentKey;
  return key !== undefined && typeof env[key] === 'string' && env[key]!.trim().length > 0;
}

export async function detectCodexAcpLaunchResolution(
  params: Readonly<{ env?: NodeJS.ProcessEnv }> = {},
  depsOverrides: Partial<DetectDeps> = {},
  descriptor?: InstallableDependencyDescriptor,
): Promise<RuntimeInstallableLaunchResolution> {
  const env = params.env ?? process.env;
  const resolveManagedBin =
    depsOverrides.resolveExistingCodexAcpManagedBinPath ?? resolveExistingCodexAcpManagedBinPath;
  const deps: DetectDeps = {
    resolveCodexAcpSpawn:
      depsOverrides.resolveCodexAcpSpawn ?? (() => launchHelpers(descriptor).resolveSpawnSpec(env, resolveManagedBin)),
    validateCodexAcpSpawnAvailability:
      depsOverrides.validateCodexAcpSpawnAvailability
      ?? ((spec, opts) => launchHelpers(descriptor).validateAvailability(spec, opts)),
    resolveExistingCodexAcpManagedBinPath: resolveManagedBin,
  };

  try {
    const resolved = deps.resolveCodexAcpSpawn();
    const availability = deps.validateCodexAcpSpawnAvailability(resolved, { env });
    const managedPath = deps.resolveExistingCodexAcpManagedBinPath(env);
    return {
      availability,
      canAutoInstall: !hasExplicitCodexAcpOverride(env, descriptor) && resolved.command === 'codex-acp' && !availability.ok,
      canBackgroundAutoUpdate: availability.ok && managedPath !== null && resolved.command === managedPath,
    };
  } catch (error) {
    return {
      availability: {
        ok: false,
        errorMessage: error instanceof Error ? error.message : 'Codex ACP could not be resolved',
      },
      canAutoInstall: false,
      canBackgroundAutoUpdate: false,
    };
  }
}

export async function resolveCodexAcpLaunchCommand(
  params: Readonly<{
    env?: NodeJS.ProcessEnv;
    sourcePreference?: 'system-first' | 'managed-first';
  }> = {},
  depsOverrides: Partial<DetectDeps> = {},
  descriptor?: InstallableDependencyDescriptor,
): Promise<RuntimeInstallableLaunchCommandResolution> {
  const env = params.env ?? process.env;
  const resolveManagedBin =
    depsOverrides.resolveExistingCodexAcpManagedBinPath ?? resolveExistingCodexAcpManagedBinPath;
  const validateAvailability =
    depsOverrides.validateCodexAcpSpawnAvailability
    ?? ((spec: ManagedDependencyCommand, opts?: Readonly<{ env?: NodeJS.ProcessEnv }>) => launchHelpers(descriptor).validateAvailability(spec, opts));
  const preferSystem = params.sourcePreference !== 'managed-first';
  try {
    const explicitOverride = hasExplicitCodexAcpOverride(env, descriptor);
    const managedPath = resolveManagedBin(env);
    const systemAvailable = validateAvailability({ command: 'codex-acp', args: [] }, { env }).ok;
    const resolveExistingManagedBinPath = preferSystem && systemAvailable ? () => null : resolveManagedBin;
    const resolved = depsOverrides.resolveCodexAcpSpawn
      ? depsOverrides.resolveCodexAcpSpawn()
      : launchHelpers(descriptor).resolveSpawnSpec(env, resolveExistingManagedBinPath);
    const availability = validateAvailability(resolved, { env });
    if (!availability.ok) {
      return {
        ok: false,
        errorMessage: availability.errorMessage,
        canAutoInstall: !explicitOverride && resolved.command === 'codex-acp',
      };
    }

    return {
      ok: true,
      command: resolved.command,
      args: resolved.args,
      source: explicitOverride
        ? 'user_config'
        : managedPath && resolved.command === managedPath
          ? 'managed'
          : resolved.command === 'codex-acp'
            ? 'system'
            : 'unknown',
    };
  } catch (error) {
    return {
      ok: false,
      errorMessage: error instanceof Error ? error.message : 'Codex ACP could not be resolved',
      canAutoInstall: false,
    };
  }
}

export async function runCodexAcpBackgroundAutoUpdateCheck(
  deps: BackgroundUpdateDeps,
): Promise<void> {
  const status = await deps.getCodexAcpDepStatus({ includeLatestVersion: true, onlyIfInstalled: true });
  if (status.installed !== true) return;

  const installedVersion = status.installedVersion;
  const latestVersion = status.latestVersionCheck?.ok ? status.latestVersionCheck.latestVersion : null;
  if (!installedVersion || !latestVersion) return;
  if (compareVersions(latestVersion, installedVersion) <= 0) return;

  const installResult = await deps.installOrUpgrade();
  if (!installResult.ok) {
    logger.warn(
      `[codex-acp] background upgrade failed: ${installResult.errorMessage}${
        installResult.logPath ? ` (install log: ${installResult.logPath})` : ''
      }`,
    );
  }
}

export function createCodexAcpRuntimeInstallableAdapter(
  descriptor: InstallableDependencyDescriptor,
  hostAdapter: RuntimeInstallableAdapter,
): RuntimeInstallableAdapter {
  return {
    ...hostAdapter,
    key: descriptor.key as InstallableKey,
    capabilityId: descriptor.capabilityId as Extract<CapabilityId, `dep.${string}`>,
    detectCapabilityStatus: (params) => getCodexAcpDepStatus({ ...params, descriptor }),
    detectLaunchResolution: (params) => detectCodexAcpLaunchResolution(params, {}, descriptor),
    resolveLaunchCommand: (params) => resolveCodexAcpLaunchCommand(params, {}, descriptor),
    installOrUpgrade: hostAdapter.installOrUpgrade,
    runBackgroundAutoUpdateCheck: () => runCodexAcpBackgroundAutoUpdateCheck({
      getCodexAcpDepStatus: (params) => getCodexAcpDepStatus({ ...params, descriptor }),
      installOrUpgrade: hostAdapter.installOrUpgrade,
    }),
  };
}
