import { spawnSync } from 'node:child_process';

import {
  resolveNpmCommandInvocation as resolveWorkspaceNpmCommandInvocation,
  resolvePnpmCommandInvocation as resolveWorkspacePnpmCommandInvocation,
} from '../../../../../scripts/workspaces/execPnpmCommand.mjs';

export type CommandInvocation = Readonly<{
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}>;

export function pnpmCommand(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

export function resolvePnpmCommandInvocation(
  args: readonly string[] = [],
  options: Readonly<{ platform?: NodeJS.Platform; npmExecPath?: string; comspec?: string }> = {},
): CommandInvocation {
  return resolveWorkspacePnpmCommandInvocation(args, options);
}

export function resolveNpmCommandInvocation(
  args: readonly string[] = [],
  options: Readonly<{ platform?: NodeJS.Platform; npmExecPath?: string; processExecPath?: string; comspec?: string }> = {},
): CommandInvocation {
  return resolveWorkspaceNpmCommandInvocation(args, options);
}

export function which(bin: string): string | null {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(cmd, [bin], { encoding: 'utf8' });
  if (res.error) return null;
  if (res.status === null) return null;
  if (res.status !== 0) return null;
  const out = (res.stdout || '').trim().split(/\r?\n/)[0];
  return out && out.length > 0 ? out : null;
}
