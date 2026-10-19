import { createTerminalLaunchSpec, type TerminalLaunchSpec } from '@/terminal/host/launchSpec';
import { stripUnsetEnvironmentVariables } from '@/utils/processEnv/buildScopedProcessEnv';

export async function createHerdrLaunchSpec(input: Readonly<{
  workingDirectory: string;
  spawnArgv: readonly string[];
  spawnEnv: Readonly<Record<string, string>>;
  unsetEnvKeys?: readonly string[];
  windowsVerbatimArguments?: boolean;
}>): Promise<TerminalLaunchSpec> {
  return await createTerminalLaunchSpec({
    ...input,
    spawnEnv: stripUnsetEnvironmentVariables(input.spawnEnv, [...(input.unsetEnvKeys ?? []), 'HERDR_ENV']),
    envPassthroughKeys: [
      'TERM', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
      // Herdr adds these after applying pane environment. Only the managed Happier
      // runner consumes pane identity, then suppresses native Agent hooks at startup.
      'HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_BIN_PATH',
      'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID',
    ],
  });
}
