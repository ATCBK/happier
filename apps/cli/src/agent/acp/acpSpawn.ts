import type { SpawnOptions } from 'node:child_process';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

export type AcpSpawnSpec = {
  command: string;
  args: string[];
  options: SpawnOptions;
};

export function buildAcpSpawnSpec(params: {
  command: string;
  args: readonly unknown[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** The host Exec owner supplied the complete process tuple. */
  hostFinalizedLaunch?: true;
  windowsVerbatimArguments?: boolean;
}): AcpSpawnSpec {
  const args = (params.args ?? []).map((a) => String(a));
  const invocation = !params.hostFinalizedLaunch ? resolveWindowsCommandInvocation({
    command: params.command,
    args,
    env: params.env,
    resolveCommandOnPath: true,
  }) : { command: params.command, args, windowsVerbatimArguments: params.windowsVerbatimArguments };

  return {
    command: invocation.command,
    args: invocation.args,
    options: {
      cwd: params.cwd,
      env: params.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(process.platform === 'win32'
        ? { windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments }
        : null),
    },
  };
}
