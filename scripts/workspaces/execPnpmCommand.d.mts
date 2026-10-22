import type { ExecFileSyncOptions, execFileSync } from 'node:child_process';

export type PnpmCommandInvocation = Readonly<{
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}>;

export type PnpmCommandInvocationOptions = Readonly<{
  npmExecPath?: string | null;
  platform?: NodeJS.Platform;
  processExecPath?: string;
  comspec?: string | null;
  preferPath?: boolean;
}>;

export function buildWindowsCmdShimInvocation(
  command: string,
  args: readonly string[],
  options?: Readonly<{ comspec?: string | null }>,
): PnpmCommandInvocation;

export function resolvePnpmInvocation(
  npmExecPath?: string | null,
  options?: PnpmCommandInvocationOptions,
): PnpmCommandInvocation;

export function resolvePnpmCommandInvocation(
  args?: readonly string[],
  options?: PnpmCommandInvocationOptions,
): PnpmCommandInvocation;

export function resolveNpmCommandInvocation(
  args?: readonly string[],
  options?: PnpmCommandInvocationOptions,
): PnpmCommandInvocation;

export function execPnpm(
  args: readonly string[],
  options?: ExecFileSyncOptions & PnpmCommandInvocationOptions & {
    execFileSync?: typeof execFileSync;
  },
): ReturnType<typeof execFileSync>;
