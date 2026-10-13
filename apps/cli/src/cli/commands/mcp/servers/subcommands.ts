import type { McpCommandDeps } from '../deps';

import { cmdMcpServersAdd } from './add';
import { cmdMcpServersDetect } from './detect';
import { cmdMcpServersList } from './list';

export async function runMcpServersSubcommand(
  subcommand: string,
  argv: string[],
  deps: McpCommandDeps,
  opts: Readonly<{ json: boolean }>,
): Promise<boolean> {
  const trimmed = String(subcommand ?? '').trim();
  if (!trimmed) return false;

  if (trimmed === 'list') {
    await cmdMcpServersList(argv, deps, opts);
    return true;
  }
  if (trimmed === 'add') {
    await cmdMcpServersAdd(argv, deps, opts);
    return true;
  }
  if (trimmed === 'detect') {
    await cmdMcpServersDetect(argv, deps, opts);
    return true;
  }
  if (trimmed === 'test') {
    const { tryHandleMcpServerCliCommand } = await import('@/cli/actions/adapters/mcpServersArgv');
    await tryHandleMcpServerCliCommand({ argv: ['mcp', ...argv] });
    return true;
  }

  return false;
}

