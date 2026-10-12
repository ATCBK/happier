import type { TerminalGuardResource, TerminalPtySessionManager } from '@/terminal/pty/sessions';

/** Close only the captured PTY; the incumbent owner records nohup survivors. */
export async function terminalClose(input: Readonly<{
  terminals: TerminalPtySessionManager; terminal: TerminalGuardResource; signal: AbortSignal;
  verifyCurrent(): Promise<boolean>;
}>): Promise<boolean> {
  if (input.signal.aborted) return false;
  const result = await input.terminals.closeGuardIdle({ terminalId: input.terminal.terminalId,
    expectedLastActivityAtMs: input.terminal.lastActivityAtMs, signal: input.signal, verifyCurrent: input.verifyCurrent });
  return result.ok;
}
