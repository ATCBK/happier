import { renderPublishedActionCliRootHelp as renderActionCliRootHelp } from '@/cli/actions/publishedHelp';
import { printPublishedActionCliHelp } from '@/cli/actions/publishedHelp';

export async function printMcpFamilyHelp(args: readonly string[]): Promise<void> {
  const canonicalArgs = ['mcp', ...args.slice(1)];
  if (await printPublishedActionCliHelp(canonicalArgs, { exactOnly: true })) return;
  if (args[1] === 'serve' || args[1] === 'start') { printMcpServeUsage(); return; }
  if (args[1] === 'servers') { printMcpServersUsage(); return; }
  printMcpUsage();
}

export function printMcpServeUsage(): void {
  console.log('happier mcp serve [--session <session-id>]');
  console.log('happier --server <saved-home> mcp serve [--session <session-id>]  # pin one Home for this process');
}

export function printMcpUsage(): void {
  printMcpServeUsage();
  console.log(renderActionCliRootHelp('mcp'));
}

export function printMcpServersUsage(): void {
  console.log(renderActionCliRootHelp('mcp', ['mcp', 'servers']));
}

