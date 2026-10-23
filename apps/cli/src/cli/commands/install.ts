import { readInstallableProviderRows, usage } from './installHelp';
import chalk from 'chalk';

import { createStepPrinter, fail } from '@happier-dev/cli-common/output';

import type { CommandContext } from '@/cli/commandRegistry';
import { hasFlag } from '@/cli/commands/shared/argvFlags';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { describeAgentCliInstallMode, runAgentCliInstallStep } from '@/packagedRuntime/managedTools/agentCliInstallStep';
import type {
  invokeAgentCliInstall as invokeProviderCliInstallDefault,
} from '@/packagedRuntime/managedTools/invokeAgentCliInstall';
import type { runDoctorCommand as runDoctorCommandDefault } from '@/ui/doctor';


type InstallCliDeps = Readonly<{
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => never | void;
  runDoctorCommand: typeof runDoctorCommandDefault;
  invokeAgentCliInstall: typeof invokeProviderCliInstallDefault;
  runPluginsCommand?: (context: CommandContext) => Promise<void>;
}>;

async function runDoctorCommandLazy(): Promise<void> {
  const { runDoctorCommand } = await import('@/ui/doctor');
  await runDoctorCommand();
}

async function invokeProviderCliInstallLazy(
  ...args: Parameters<typeof invokeProviderCliInstallDefault>
): Promise<Awaited<ReturnType<typeof invokeProviderCliInstallDefault>>> {
  const { invokeAgentCliInstall } = await import('@/packagedRuntime/managedTools/invokeAgentCliInstall');
  return await invokeAgentCliInstall(...args);
}

async function runPluginsCommandLazy(context: CommandContext): Promise<void> {
  const { handlePluginsCliCommand } = await import('@/cli/commands/plugins');
  await handlePluginsCliCommand(context);
}

function parseProviderInstallFlags(args: readonly string[]): Readonly<{ dryRun: boolean; skipIfInstalled: boolean }> {
  return {
    dryRun: hasFlag(args, '--dry-run'),
    skipIfInstalled: !hasFlag(args, '--force'),
  };
}

export async function runInstallCliCommand(
  context: CommandContext,
  deps: InstallCliDeps = {
    log: console.log,
    error: console.error,
    exit: (code: number) => {
      process.exitCode = code;
    },
    runDoctorCommand: runDoctorCommandLazy,
    invokeAgentCliInstall: invokeProviderCliInstallLazy,
    runPluginsCommand: runPluginsCommandLazy,
  },
): Promise<void> {
  try {
    const subcommand = context.args[1] ?? 'help';
    const needsRegistry = subcommand === 'help' || subcommand === '--help' || subcommand === '-h' || subcommand === 'provider';
    const mergedRegistry = needsRegistry
      ? await resolveMergedContributionRegistry({ happyHomeDir: resolvePluginStorePaths().happyHomeDir })
      : null;
    const installableProviderRows = mergedRegistry ? readInstallableProviderRows(mergedRegistry) : [];
    if (subcommand === 'doctor') {
      await deps.runDoctorCommand();
      return;
    }
    if (subcommand === 'plugin') {
      // `happier install plugin ...` shipped before plugin lifecycle commands
      // moved under their one canonical owner. Keep that released spelling as
      // a pure argv redirect: it owns no parsing, preparation, approval, or
      // mutation behavior of its own.
      const legacyArgs = context.args.slice(2);
      const pluginsArgs = legacyArgs[0] === 'update'
        ? ['plugins', 'update', ...legacyArgs.slice(1)]
        : ['plugins', 'install', ...legacyArgs];
      await (deps.runPluginsCommand ?? runPluginsCommandLazy)({ ...context, args: pluginsArgs });
      return;
    }
    if (subcommand === 'provider') {
      const agentIdRaw = context.args[2]?.trim() ?? '';
      if (!agentIdRaw) {
        deps.error(fail('Missing provider id.'));
        deps.log(usage(installableProviderRows));
        deps.exit(1);
        return;
      }
      if (agentIdRaw === 'help' || agentIdRaw === '--help' || agentIdRaw === '-h') {
        deps.log(usage(installableProviderRows));
        return;
      }
      const flags = parseProviderInstallFlags(context.args.slice(3));
      if (!flags.dryRun) {
        const { handleAgentsCommand } = await import('@/cli/commands/agents');
        await handleAgentsCommand(['install', ...context.args.slice(2)], { signal: context.signal });
        return;
      }
      const providerRow = installableProviderRows.find((row) => row.id === agentIdRaw);
      if (!providerRow) {
        deps.error(fail(`Unknown provider id: ${agentIdRaw}`));
        deps.log(usage(installableProviderRows));
        deps.exit(1);
        return;
      }

      // A dry run installs nothing, so it prints its plan instead of an install step.
      const steps = createStepPrinter({ enabled: !flags.dryRun });
      const result = await runAgentCliInstallStep(steps, providerRow.title, () => deps.invokeAgentCliInstall({
        agentId: agentIdRaw,
        runtimeSpec: providerRow.runtimeSpec,
        params: flags,
        env: process.env,
        nodePlatform: process.platform,
      }));
      if (!result.ok) {
        deps.error(fail(result.errorMessage));
        if (result.logPath) {
          deps.log(`Install log: ${result.logPath}`);
        }
        deps.exit(1);
        return;
      }
      if (flags.dryRun) {
        deps.log(`Dry run: would install ${result.plan.title} via ${describeAgentCliInstallMode(result.plan.installMode)}.`);
        if (result.logPath) {
          deps.log(`Install log: ${result.logPath}`);
        }
        return;
      }
      if (result.logPath) {
        deps.log(`Install log: ${result.logPath}`);
      }
      return;
    }
    if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      deps.log(usage(installableProviderRows));
      return;
    }
    deps.error(fail(`Unknown install subcommand: ${subcommand}`));
    deps.log(usage(installableProviderRows));
    deps.exit(1);
  } catch (error) {
    deps.error(fail(error instanceof Error ? error.message : 'Unknown error'));
    if (process.env.DEBUG) {
      deps.error(error);
    }
    if (error && typeof error === 'object' && 'logPath' in error && typeof error.logPath === 'string') {
      deps.log(`Install log: ${error.logPath}`);
    }
    deps.exit(1);
    return;
  }
}

export async function handleInstallCliCommand(context: CommandContext): Promise<void> {
  await runInstallCliCommand(context);
}
