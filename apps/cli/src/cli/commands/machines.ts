import { showHelp } from './machinesHelp';
import chalk from 'chalk';
import { renderHelpPage } from '@happier-dev/cli-common/output';

import type { CommandContext } from '@/cli/commandRegistry';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';
import { argvBeforeOptionTerminator } from '@/cli/commands/shared/argvFlags';

const USAGE = 'Usage: happier machines <subcommand> [options] [--json]';


/**
 * The `machines` root: help and the unknown-subcommand diagnostic.
 *
 * `machines list` is a compiled `machines.list` command. Dispatch resolves it
 * before this handler runs, so there is no argument grammar, credential read or
 * Action-adjacent helper left here.
 */
export async function handleMachinesCommand(args: string[], signal?: AbortSignal): Promise<void> {
  void signal;
  const optionArgs = argvBeforeOptionTerminator(args);
  const subcommand = optionArgs[0];
  if (
    !subcommand
    || subcommand === 'help'
    || optionArgs.includes('--help')
    || optionArgs.includes('-h')
  ) { await showHelp(); return; }

  const mapped = mapUnknownErrorToControlError(
    Object.assign(new Error(`Unknown machines subcommand: ${subcommand}\n${USAGE}`), {
      code: 'unknown_subcommand',
    }),
  );
  if (wantsJson(args)) {
    await printJsonEnvelope(
      { ok: false, kind: 'machines_list', error: { code: mapped.code, ...(mapped.message ? { message: mapped.message } : {}) } },
      { exitCode: 1 },
    );
    return;
  }
  console.error(chalk.red('Error:'), mapped.message ?? mapped.code);
  await showHelp();
  process.exitCode = 1;
}

export async function handleMachinesCliCommand(context: CommandContext): Promise<void> {
  await handleMachinesCommand(context.args.slice(1), context.signal);
}
