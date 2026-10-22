import { spawn } from 'node:child_process';

import { resolvePnpmCommandInvocation } from '../../workspaces/execPnpmCommand.mjs';
import type { CommandSuiteEntry } from './runCommandSuite.ts';

export async function runPnpmCommand(command: CommandSuiteEntry, rootDir: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const invocation = resolvePnpmCommandInvocation([...command.args], { npmExecPath: process.env.npm_execpath });
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: rootDir,
      stdio: 'inherit',
      ...(env ? { env } : {}),
      ...(invocation.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (signal) rejectRun(Object.assign(new Error(`terminated with signal ${signal}`), { exitCode: code, signal }));
      else if (code !== 0) rejectRun(Object.assign(new Error(`exited with status ${code ?? 1}`), { exitCode: code, signal }));
      else resolveRun();
    });
  });
}
