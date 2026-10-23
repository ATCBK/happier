import { cmd, errorFrame, warn } from '@happier-dev/cli-common/output';

import { handleAuthCommand } from '@/cli/commands/auth';
import { showLogoutDeprecation, showLogoutHelp } from './auth/help';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleLogoutCliCommand(context: CommandContext): Promise<void> {
  if (context.args.includes('--help') || context.args.includes('-h')) { showLogoutHelp(); return; }
  showLogoutDeprecation();
  try {
    await handleAuthCommand(['logout']);
  } catch (error) {
    console.error(errorFrame('Sign-out failed', [error instanceof Error ? error.message : 'Unknown error']));
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
