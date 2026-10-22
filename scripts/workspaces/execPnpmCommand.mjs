import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildWindowsCmdShimInvocation } from '../../packages/cli-common/windowsCommandInvocation.mjs';

export { buildWindowsCmdShimInvocation } from '../../packages/cli-common/windowsCommandInvocation.mjs';

export function resolvePnpmInvocation(npmExecPath = process.env.npm_execpath, options = {}) {
  const normalizedNpmExecPath = String(npmExecPath ?? '').trim();
  const platform = options.platform ?? process.platform;
  const processExecPath = options.processExecPath ?? process.execPath;
  const pnpmCommand = platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

  if (options.preferPath === true) {
    return {
      command: pnpmCommand,
      args: [],
    };
  }

  if (!normalizedNpmExecPath) {
    return { command: pnpmCommand, args: [] };
  }

  const isNpmCliPath = /(^|[\\/])npm-cli\.js$/i.test(normalizedNpmExecPath);
  if (isNpmCliPath) {
    return { command: pnpmCommand, args: [] };
  }

  // pnpm 12 is native; npm_execpath is not necessarily JavaScript.
  return /\.[cm]?js$/i.test(normalizedNpmExecPath)
    ? { command: processExecPath, args: [normalizedNpmExecPath] }
    : { command: normalizedNpmExecPath, args: [] };
}

export function resolvePnpmCommandInvocation(args = [], options = {}) {
  const platform = options.platform ?? process.platform;
  const invocation = resolvePnpmInvocation(options.npmExecPath, {
    platform,
    processExecPath: options.processExecPath,
    preferPath: options.preferPath,
  });
  const commandArgs = [...invocation.args, ...args];

  if (platform === 'win32' && /\.(cmd|bat)$/i.test(invocation.command)) {
    return buildWindowsCmdShimInvocation(invocation.command, commandArgs, { comspec: options.comspec });
  }

  return { command: invocation.command, args: commandArgs };
}

export function resolveNpmCommandInvocation(args = [], options = {}) {
  const platform = options.platform ?? process.platform;
  const npmExecPath = String(options.npmExecPath ?? '').trim();
  const processExecPath = String(options.processExecPath ?? process.execPath).trim();
  const npmCommand = platform === 'win32' ? 'npm.cmd' : 'npm';

  if (npmExecPath && /(^|[\\/])npm-cli\.js$/i.test(npmExecPath)) {
    return {
      command: processExecPath,
      args: [npmExecPath, ...args],
    };
  }

  if (platform === 'win32') {
    return buildWindowsCmdShimInvocation(npmCommand, args, { comspec: options.comspec });
  }

  return {
    command: npmCommand,
    args: [...args],
  };
}

export function execPnpm(args, options = {}) {
  const execFileSync = options.execFileSync ?? defaultExecFileSync;
  const {
    execFileSync: _execFileSync,
    npmExecPath,
    platform: _platform,
    comspec,
    processExecPath: _processExecPath,
    preferPath,
    ...childOptions
  } = options;
  const invocation = resolvePnpmCommandInvocation(args, {
    npmExecPath,
    platform: options.platform,
    processExecPath: options.processExecPath,
    preferPath,
    comspec,
  });

  return execFileSync(invocation.command, invocation.args, {
    ...childOptions,
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    execPnpm(process.argv.slice(2), { stdio: 'inherit' });
  } catch (error) {
    process.exitCode = Number.isInteger(error.status) ? error.status : 1;
    if (!Number.isInteger(error.status)) console.error('[pnpm] unable to execute the repository package manager');
  }
}
