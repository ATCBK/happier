import { spawn } from 'node:child_process';
import { classifySpawnFailure, spawnFailureMessage, type SpawnFailure, type SpawnFailureLimitsReader } from '@/processes/spawnFailure/classifySpawnFailure';
import type { CancelStartupLaunch } from '../../spawn/startupLaunchCancellation';
import { createExactWindowsProcessCancellation } from './windowsProcessCustody';
import {
  buildPowerShellStartProcessInvocation,
  parsePowerShellStartProcessIdentity,
} from './visibleConsoleSpawn';

type VisibleWindowsConsoleLaunchResult =
  | Readonly<{
      ok: true;
      pid: number;
      processStartTimeMs: number;
      cancel: CancelStartupLaunch;
    }>
  | Readonly<{ ok: false; errorMessage: string; spawnFailure?: SpawnFailure }>;

export async function startHappySessionInVisibleWindowsConsole(params: {
  filePath: string;
  args: string[];
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
  readSpawnFailureLimits?: SpawnFailureLimitsReader;
}): Promise<VisibleWindowsConsoleLaunchResult> {
  const invocation = buildPowerShellStartProcessInvocation({
    filePath: params.filePath,
    args: params.args,
    workingDirectory: params.workingDirectory,
  });

  return await new Promise((resolve) => {
    let settled = false;
    const safeResolve = (result: VisibleWindowsConsoleLaunchResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try { child = spawn(invocation.command, invocation.args, {
      cwd: params.workingDirectory,
      env: params.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }); } catch (error) {
      const spawnFailure = classifySpawnFailure(error, { syscall: 'spawn', limits: params.readSpawnFailureLimits?.() });
      safeResolve({ ok: false, spawnFailure, errorMessage: spawnFailureMessage(spawnFailure, 'Failed to spawn PowerShell') });
      return;
    }
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout = (
        stdout
        + (Buffer.isBuffer(data)
          ? data.toString('utf8')
          : String(data))
      ).slice(-16_384);
    });
    child.stderr?.on('data', (data) => {
      stderr = (
        stderr
        + (Buffer.isBuffer(data)
          ? data.toString('utf8')
          : String(data))
      ).slice(-16_384);
    });

    child.once('error', (error) => {
      const spawnFailure = classifySpawnFailure(error, { syscall: 'spawn', limits: params.readSpawnFailureLimits?.() });
      safeResolve({
        ok: false,
        spawnFailure,
        errorMessage: spawnFailureMessage(spawnFailure,
          error instanceof Error
            ? error.message
            : 'Failed to spawn PowerShell'),
      });
    });

    child.once('close', (code) => {
      if (code !== 0) {
        safeResolve({
          ok: false,
          errorMessage:
            `PowerShell exit ${
              typeof code === 'number' ? code : 'unknown'
            }. ${stderr.trim() || stdout.trim()}`.trim(),
        });
        return;
      }

      const identity = parsePowerShellStartProcessIdentity(stdout);
      if (!identity) {
        safeResolve({
          ok: false,
          errorMessage:
            `Failed to parse exact Agent identity from PowerShell output: ${stdout.trim()}`,
        });
        return;
      }
      safeResolve({
        ok: true,
        ...identity,
        cancel: createExactWindowsProcessCancellation(identity),
      });
    });
  });
}
