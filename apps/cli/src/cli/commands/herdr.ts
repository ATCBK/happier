import { createHerdrClient } from '@/integrations/herdr/client';
import { HERDR_USAGE } from './herdrHelp';
import { runHerdrForeground } from '@/integrations/herdr/foreground';
import { HERDR_ACTION_TIMEOUT_MS, HERDR_STARTUP_TIMEOUT_MS, resolveHerdrRuntimeBinary } from '@/integrations/herdr/runtimeBinary';

import type { CommandContext } from '../commandRegistry';

export async function handleHerdrCliCommand(context: CommandContext): Promise<void> {
  const args = context.args.slice(1);
  if (args.length > 0 && !(args.length === 1 && (args[0] === '--help' || args[0] === '-h'))) {
    throw new Error(HERDR_USAGE);
  }
  if (args.length === 1) {
    console.log(HERDR_USAGE);
    return;
  }
  if (process.env.HERDR_ENV === '1') {
    console.log('Already inside Herdr. Use its workspace and pane controls here.');
    return;
  }
  const binary = await resolveHerdrRuntimeBinary({
    actionTimeoutMs: HERDR_ACTION_TIMEOUT_MS,
  });
  if (!binary) throw new Error('A supported Herdr installation is required.');
  const client = createHerdrClient({ binary, sessionName: 'default',
    actionTimeoutMs: HERDR_ACTION_TIMEOUT_MS, startupTimeoutMs: HERDR_STARTUP_TIMEOUT_MS });
  const socketPath = await client.ensureServer();
  const exitCode = await runHerdrForeground({ binary, args: [], socketPath });
  if (exitCode !== 0) process.exitCode = exitCode;
}
