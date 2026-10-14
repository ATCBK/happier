import { basename, delimiter } from 'node:path';
import { resolveJavaScriptRuntimePathEntries } from '@happier-dev/cli-common/agents';

import { buildManagedPnpmEnvironment, ensureManagedPnpmCommand } from '@/packagedRuntime/managedTools/pnpm/managedPnpm';
import { buildManagedUvEnvironment, ensureManagedUvCommand } from '@/packagedRuntime/managedTools/uv/managedUv';
import { ensureJavaScriptRuntimeExecutable } from '@/packagedRuntime/js/ensureJavaScriptRuntimeExecutable';
import { isBun } from '@/utils/runtime';
import { mergeProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';

export type NormalizedPackageRunnerInvocation = Readonly<{
  command: string;
  args: string[];
  cwdPolicy: 'neutral' | 'workspace';
  env?: Readonly<Record<string, string>>;
}>;

const PACKAGE_RUNNER_COMMANDS = new Set(['node', 'node.exe', 'npx', 'npx.cmd', 'npm', 'npm.cmd', 'pnpm', 'pnpm.cmd', 'yarn', 'yarn.cmd', 'yarnpkg', 'yarnpkg.cmd', 'bunx', 'bunx.cmd', 'uv', 'uv.exe', 'uvx', 'uvx.exe']);

export function isPackageRunnerCommand(command: string): boolean {
  return PACKAGE_RUNNER_COMMANDS.has(basename(command).toLowerCase());
}

function normalizeNpxLikeArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '-y' || arg === '--yes' || arg === '--prefer-offline') {
      continue;
    }
    if (arg.startsWith('--package=') || arg.startsWith('-p=')) {
      out.push(arg);
      continue;
    }
    if ((arg === '-p' || arg === '--package') && index + 1 < args.length) {
      out.push(arg, args[index + 1]!);
      index += 1;
      continue;
    }
    if (arg === '--') continue;
    out.push(arg);
  }
  return out;
}

function normalizeExecArgs(args: readonly string[]): string[] {
  return args.filter((arg) => arg !== '--');
}

function hasPackageFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === '-p' || arg === '--package' || arg.startsWith('--package=') || arg.startsWith('-p='));
}

export async function normalizePackageRunnerInvocation(params: Readonly<{
  command: string;
  args: readonly string[];
  processEnv?: NodeJS.ProcessEnv;
  launchEnv?: Readonly<Record<string, string>>;
}>): Promise<NormalizedPackageRunnerInvocation | null> {
  const processEnv = params.processEnv ?? process.env;
  const normalized = basename(params.command).toLowerCase();
  const args = [...params.args];

  if (normalized === 'uvx' || normalized === 'uvx.exe' || normalized === 'uv' || normalized === 'uv.exe') {
    if ((normalized === 'uv' || normalized === 'uv.exe') && (args[0] !== 'tool' || args[1] !== 'run')) return null;
    const command = await ensureManagedUvCommand(processEnv);
    if (!command) return null;
    return { command, args: normalized === 'uvx' || normalized === 'uvx.exe' ? ['tool', 'run', ...args] : args,
      cwdPolicy: 'neutral', env: buildManagedUvEnvironment(processEnv) };
  }

  if (normalized === 'node' || normalized === 'node.exe') {
    const command = await ensureJavaScriptRuntimeExecutable({ isBunRuntime: isBun(), processEnv });
    return command ? { command, args, cwdPolicy: 'workspace' } : null;
  }

  const resolvePnpmInvocation = async (args: string[], cwdPolicy: 'neutral' | 'workspace'): Promise<NormalizedPackageRunnerInvocation | null> => {
    const command = await ensureManagedPnpmCommand(processEnv);
    if (!command) return null;
    const runtimeCommand = await ensureJavaScriptRuntimeExecutable({ isBunRuntime: isBun(), processEnv });
    if (!runtimeCommand) return null;
    const packageEnv = buildManagedPnpmEnvironment(processEnv);
    const launchEnv = mergeProcessEnv({ baseEnv: processEnv, explicitEnv: params.launchEnv });
    const pathKey = Object.keys(launchEnv).find(key => process.platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH');
    const runtimePaths = resolveJavaScriptRuntimePathEntries({ processEnv, runtimeCommand });
    return { command, args, cwdPolicy, env: {
      PATH: [...runtimePaths, pathKey ? launchEnv[pathKey] ?? '' : ''].filter(Boolean).join(delimiter),
      PNPM_HOME: packageEnv.PNPM_HOME!,
      npm_config_store_dir: packageEnv.npm_config_store_dir!,
      XDG_CACHE_HOME: packageEnv.XDG_CACHE_HOME!,
    } };
  };

  if (normalized === 'npx' || normalized === 'npx.cmd' || normalized === 'bunx' || normalized === 'bunx.cmd') {
    return resolvePnpmInvocation(['dlx', ...normalizeNpxLikeArgs(args)], 'neutral');
  }

  if (normalized === 'npm' || normalized === 'npm.cmd') {
    const subcommand = args[0] ?? '';
    if (subcommand === 'run') {
      return resolvePnpmInvocation(args, 'workspace');
    }
    if (subcommand === 'exec') {
      const execArgs = args.slice(1);
      if (hasPackageFlag(execArgs)) {
        return resolvePnpmInvocation(['dlx', ...normalizeNpxLikeArgs(execArgs)], 'neutral');
      }
      return resolvePnpmInvocation(['exec', ...normalizeExecArgs(execArgs)], 'workspace');
    }
    return null;
  }

  if (normalized === 'yarn' || normalized === 'yarn.cmd' || normalized === 'yarnpkg' || normalized === 'yarnpkg.cmd') {
    if (args[0] === 'dlx') {
      return resolvePnpmInvocation(['dlx', ...args.slice(1)], 'neutral');
    }
    return null;
  }

  if (normalized === 'pnpm' || normalized === 'pnpm.cmd') {
    const subcommand = args[0] ?? '';
    return resolvePnpmInvocation(args, subcommand === 'run' || subcommand === 'exec' ? 'workspace' : 'neutral');
  }

  return null;
}
