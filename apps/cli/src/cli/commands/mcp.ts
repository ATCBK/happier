
import { printMcpUsage, printMcpServersUsage, printMcpServeUsage } from './mcp/help';
import type { CommandContext } from '@/cli/commandRegistry';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import type { EphemeralResolvedServerSelection } from '@/server/serverSelection';

import { resolveMcpCommandDeps, type McpCommandDeps } from './mcp/deps';
import { tryHandleMcpServerCliCommand } from '@/cli/actions/adapters/mcpServersArgv';
import { findCompiledActionCliCommand, listCompiledActionCliCommands } from '@/cli/actions/compiledCommands';
import { runCompiledActionCliCommand } from '@/cli/actions/executeCommand';
import { renderActionCliRootHelp } from '@/cli/actions/rootCommand';
import { fail } from '@happier-dev/cli-common/output';

function isHelpToken(value: string): boolean {
  const trimmed = String(value ?? '').trim();
  return trimmed === 'help' || trimmed === '--help' || trimmed === '-h';
}



function resolveCommandKind(args: readonly string[]): string {
  const group = args[0];
  const subcommand = args[1];
  if (group === 'serve' || group === 'start') return 'mcp_serve';
  if (group !== 'servers') return 'mcp_unknown';
  const sub = String(subcommand ?? '').trim();
  if (!sub) return 'mcp_servers_unknown';
  if (sub === 'list') return 'mcp_servers_list';
  if (sub === 'add') return 'mcp_servers_add';
  if (sub === 'detect') return 'mcp_servers_detect';
  if (sub === 'test') return 'mcp_servers_test';
  return `mcp_servers_${sub}`;
}

export async function handleMcpCommand(
  args: string[],
  deps?: Partial<McpCommandDeps>,
  explicitServerSelection?: EphemeralResolvedServerSelection,
): Promise<void> {
  const json = wantsJson(args);
  const group = String(args[0] ?? '').trim();
  const subcommand = String(args[1] ?? '').trim();
  const kind = resolveCommandKind(args);

  try {
    if (!group || isHelpToken(group)) {
      printMcpUsage();
      return;
    }

    if (group === 'serve' || group === 'start') {
      if (isHelpToken(subcommand)) {
        printMcpServeUsage();
        return;
      }
      const { runMcpServeCommand } = await import('./mcp/serve');
      await runMcpServeCommand(args, resolveMcpCommandDeps(deps), explicitServerSelection);
      return;
    }

    if (group !== 'servers') {
      throw new Error('Usage: happier mcp servers <command>');
    }

    if (!subcommand || isHelpToken(subcommand)) {
      printMcpServersUsage();
      return;
    }

    const argv = ['mcp', ...args];
    const actionExecutionDeps = deps?.readStoredCredentials ? { readCredentialsFn: deps.readStoredCredentials } : undefined;
    if (await tryHandleMcpServerCliCommand({ argv, actionExecutionDeps })) return;
    const command = findCompiledActionCliCommand(argv, listCompiledActionCliCommands());
    if (command) {
      await runCompiledActionCliCommand({ command, argv, deps: actionExecutionDeps });
      return;
    }

    throw Object.assign(new Error(`Unknown mcp servers subcommand: ${subcommand ?? ''}`), { code: 'unknown_subcommand' });
  } catch (error) {
    if (!json) throw error;
    const mapped = mapUnknownErrorToControlError(error);
    await printJsonEnvelope(
      {
        ok: false,
        kind,
        error: { code: mapped.code, ...(mapped.message ? { message: mapped.message } : {}) },
      },
      { exitCode: mapped.unexpected ? 2 : 1 },
    );
  }
}

export async function handleMcpCliCommand(context: CommandContext): Promise<void> {
  const args = context.args.slice(1);
  const json = wantsJson(args);
  const kind = resolveCommandKind(args);

  try {
    await handleMcpCommand(args, undefined, context.explicitServerSelection);
  } catch (error) {
    if (json) {
      const mapped = mapUnknownErrorToControlError(error);
      await printJsonEnvelope(
        {
          ok: false,
          kind,
          error: { code: mapped.code, ...(mapped.message ? { message: mapped.message } : {}) },
        },
        { exitCode: mapped.unexpected ? 2 : 1 },
      );
      return;
    }
    console.error(fail(error instanceof Error ? error.message : 'Unknown error'));
    if (process.env.DEBUG) console.error(error);
    process.exitCode = typeof process.exitCode === 'number' && process.exitCode > 1 ? process.exitCode : 1;
  }
}
