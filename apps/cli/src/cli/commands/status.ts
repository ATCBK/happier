import type { CommandContext } from '@/cli/commandRegistry';
import { STATUS_USAGE } from './statusHelp';
import { handleServiceRepairCliCommand } from './service/repair/handleServiceRepairCliCommand';

export async function handleStatusCliCommand(context: CommandContext): Promise<void> {
  if (context.args.includes('--help') || context.args.includes('-h')) { console.log(STATUS_USAGE); return; }
  if (context.args.includes('--yes')) {
    throw new Error('happier status is read-only. Use `happier doctor repair --yes` to apply repairs.');
  }

  await handleServiceRepairCliCommand({
    argv: ['repair', '--report-only', ...context.args.slice(1)],
    commandPath: 'happier status',
  });
}
