import { describe, expect, it, vi } from 'vitest';
import type { ProcessCustodyExecFile } from '@/subprocess/supervision/processCustody';
import { createWindowsJobCustodyName } from '@/subprocess/supervision/processCustody';
import type { PtyExitEvent, PtyProcess } from './provider';
import { withWindowsInteractiveCustody } from './windowsCustody';

describe('interactive Windows Job handle lifetime', () => {
  it('releases a host-held handle once when exit races the one-shot join', async () => {
    let exit: ((event: PtyExitEvent) => void) | undefined;
    const terminal: PtyProcess = { pid: 42, write: () => {}, resize: () => {}, kill: () => {},
      onData: () => ({ dispose: () => {} }), onExit: (listener) => { exit = listener; return { dispose: () => {} }; } };
    const tag = 'v1.0123456789ab.terminal.interactive';
    let resolveJoin: ((value: { stdout: string; stderr: string }) => void) | undefined;
    // Native command execution is the system boundary; keep both custody adapters real.
    const seen: string[][] = [];
    const execFile: ProcessCustodyExecFile = vi.fn(async (_file, args) => {
      seen.push([...args]);
      if (args[0] === 'job-join') return new Promise<{ stdout: string; stderr: string }>((resolve) => { resolveJoin = resolve; });
      return { stdout: '{"v":1,"state":"released"}', stderr: '' };
    });
    const provider = withWindowsInteractiveCustody({ spawn: () => terminal }, {
      platform: 'win32', holderPid: 43, resolveExecutable: () => 'custody', execFile,
    });
    expect(provider.spawn({ file: 'shell', args: [], options: { env: { HAPPIER_PROCESS_OWNER: tag } } })).toBe(terminal);
    exit?.({ exitCode: 0 });
    resolveJoin?.({ stdout: JSON.stringify({ v: 1, state: 'joined', job: createWindowsJobCustodyName(tag), pid: 42,
      holderPid: 43, holderStartTimeMs: 1234, holderHandle: '100' }), stderr: '' });
    await vi.waitFor(() => expect(seen.some(args => args[0] === 'job-release')).toBe(true));
    exit?.({ exitCode: 0 });
    await Promise.resolve();
    expect(seen.filter(args => args[0] === 'job-release')).toHaveLength(1);
    expect(seen.find(args => args[0] === 'job-release')).toContain('--holder-start-time-ms=1234');
  });
});
