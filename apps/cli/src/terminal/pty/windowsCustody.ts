import { randomUUID } from 'node:crypto';

import {
  createFiniteProcessCustodyInvocation,
  createProcessCustodyHandshakePath,
  createWindowsJobCustodyName,
  joinProcessCustodyJob,
  releaseProcessCustodyJobHandle,
  type ProcessCustodyExecFile,
  type ProcessCustodyJoinedJob,
  removeProcessCustodyHandshakeFile,
  resolveProcessCustodyRuntimeExecutable,
  waitForProcessCustodyHandshake,
} from '@/subprocess/supervision/processCustody';
import { parseProcessOwnerTag, PROCESS_OWNER_ENV_KEY } from '@/processes/ownerTag';
import { logger } from '@/ui/logger';

import type { PtyProvider } from './provider';

/** Interactive shells use their existing host as the non-inheritable Job holder. */
export function withWindowsInteractiveCustody(provider: PtyProvider, options: Readonly<{
  platform: NodeJS.Platform;
  holderPid?: number;
  resolveExecutable?: () => string | null;
  execFile?: ProcessCustodyExecFile;
}>): PtyProvider {
  if (options.platform !== 'win32') return provider;
  return { spawn(input) {
    const pty = provider.spawn(input);
    const ownerTag = input.options.env?.[PROCESS_OWNER_ENV_KEY];
    if (input.finiteProcess || pty.windowsJobCustody || parseProcessOwnerTag(ownerTag)?.kind !== 'terminal' || !ownerTag) return pty;
    let exited = false;
    let custody: ProcessCustodyJoinedJob | null = null;
    let released = false;
    const executablePath = (options.resolveExecutable ?? (() => resolveProcessCustodyRuntimeExecutable('win32')))();
    const release = () => {
      if (!exited || !custody || released) return;
      released = true;
      void releaseProcessCustodyJobHandle({ custody, executablePath, execFile: options.execFile }).then(ok => {
        if (!ok) logger.debug('[terminal-pty] Windows Job handle release unavailable');
      });
    };
    pty.onExit(() => { exited = true; release(); });
    void joinProcessCustodyJob({ pid: pty.pid, holderPid: options.holderPid ?? process.pid,
      ownerTag, platform: 'win32', executablePath, execFile: options.execFile }).then(result => {
      if (result.state !== 'joined') {
        logger.debug('[terminal-pty] Windows Job join unavailable');
        return;
      }
      custody = result;
      release();
    });
    return pty;
  } };
}

/** Adapt PTY launch to the incumbent native Job owner; interactive shells stay unchanged. */
export function withWindowsFiniteCustody(provider: PtyProvider, options: Readonly<{
  platform: NodeJS.Platform;
  resolveProcessCustodyRuntimeExecutable?: typeof resolveProcessCustodyRuntimeExecutable;
}>): PtyProvider {
  if (options.platform !== 'win32') return provider;
  return {
    spawn(input) {
      if (!input.finiteProcess) return provider.spawn(input);
      const executablePath = (options.resolveProcessCustodyRuntimeExecutable ?? resolveProcessCustodyRuntimeExecutable)('win32');
      if (!executablePath) throw new Error('terminal_spawn_failed');
      const custody = {
        executablePath,
        jobName: createWindowsJobCustodyName(randomUUID()),
        handshakePath: createProcessCustodyHandshakePath(),
      };
      const invocation = createFiniteProcessCustodyInvocation({ custody, command: input.file, args: input.args });
      // The selected backend may fall back to the direct Node relay. The helper
      // invocation is already contained; do not create a nested Job there.
      const pty = provider.spawn({ file: invocation.command, args: [...invocation.args], options: input.options });
      const established = waitForProcessCustodyHandshake(custody);
      pty.onExit(() => {
        // Preserve the establishment read even for a very short-lived target.
        // Retire only this invocation's owned marker after that read settles.
        void established.then(() => removeProcessCustodyHandshakeFile(custody.handshakePath));
      });
      return { ...pty, windowsJobCustody: { ...custody, established } };
    },
  };
}
