import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';
import { parseProcessOwnerTag } from '@/processes/ownerTag';
import type { ProcessCensusExecFile, ProcessCensusRow } from '@/processes/census/processCensus';
import type { createProcessTreeTerminator } from '@/processes/terminate/terminateProcessTree';
import { CUSTODY_TERMINATE_TIMEOUT_MS } from '@/subprocess/supervision/processCustody';

import type { ManagedChildProcess } from '@/subprocess/supervision/managedChildProcess';
import type { TerminationEvent } from '@/subprocess/supervision/types';

import {
  createWorkspaceSyncNativeProcessLaunchers,
} from './workspaceSyncNativeProcessLaunchers';

type SpawnCall = Readonly<{
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}>;

function createFakeChild(pid: number): Readonly<{
  child: ChildProcess;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  descriptor: PassThrough;
}> {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const descriptor = new PassThrough();
  const child = Object.assign(emitter, {
    pid,
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, descriptor, null],
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
  return { child, stdin, stdout, stderr, descriptor };
}

function createManaged(pid: number): ManagedChildProcess {
  const termination = new Promise<TerminationEvent>(() => undefined);
  return { pid, waitForTermination: async () => await termination };
}

function createWindowsStopBoundary(jobName: string, options: Readonly<{ censusUnavailable?: boolean; membersRemaining?: boolean }> = {}) {
  let live = true;
  let membersRemaining = options.membersRemaining ?? false;
  const terminateWindowsJob = vi.fn(async (_input: Readonly<{ jobName: string; timeoutMs: number }>) => {
    if (membersRemaining) return 'members-remaining' as const;
    live = false;
    return 'absent' as const;
  });
  // This is the native executable boundary: real census decoding, membership,
  // principal guards and termination orchestration remain in the shared owner.
  const execFile: ProcessCensusExecFile = async (_file, args) => {
    if (options.censusUnavailable) throw new Error('native census unavailable');
    const self: ProcessCensusRow = {
      pid: process.pid, ppid: null, start: { startTimeMs: 100 },
      principal: { kind: 'sid', value: 'self' }, name: 'self', memory: null, cpuTimeUs: null,
    };
    const names = args.filter(arg => arg.startsWith('--job=')).map(arg => arg.slice(6));
    const member: ProcessCensusRow = { ...self, pid: 5151, name: 'workspace-sync', jobs: [jobName] };
    return { stdout: JSON.stringify({
      v: 1, capturedAtMs: Date.now(), logicalCpus: 1, rows: [self, ...(live ? [member] : [])],
      jobObservations: names.map(name => live
        ? { name, state: 'live', pids: [5151] }
        : { name, state: 'absent' }),
    }) };
  };
  const boundary = {
    platform: 'win32', terminateWindowsJob,
    censusDependencies: { platform: 'win32', helperExecutablePath: '/verified/happier-process-custody.exe', execFile },
  } satisfies NonNullable<Parameters<typeof createProcessTreeTerminator>[0]>;
  return { boundary, terminateWindowsJob, get live() { return live; }, setMembersRemaining(value: boolean) { membersRemaining = value; } };
}

describe('workspaceSyncNativeProcessLaunchers', () => {
  it('refuses a Windows Job stop when fresh census cannot verify even an absent Job', async () => {
    const fake = createFakeChild(151);
    fake.stdin.resume();
    const native = createWindowsStopBoundary('Local\\happier-workspace-sync-unverified-test', { censusUnavailable: true });
    const dependencies = {
      platform: 'win32' as const,
      spawn: () => fake.child,
      resolveProcessCustodyRuntimeExecutable: () => '/verified/happier-process-custody.exe',
      createWindowsJobCustodyName: () => 'Local\\happier-workspace-sync-unverified-test',
      createProcessCustodyHandshakePath: () => 'C:\\Temp\\workspace-sync-unverified.json',
      waitForProcessCustodyHandshake: vi.fn(async () => ({ pid: 5151 })),
      processTreeSystemBoundary: native.boundary,
      logStderr: vi.fn(),
    };
    const launchers = createWorkspaceSyncNativeProcessLaunchers(dependencies);
    const launched = await launchers.spawnSidecar({
      executablePath: '/verified/happier-mutagen.exe',
      args: ['--daemon', '--broker-descriptor', '3'],
      inheritedBrokerDescriptor: Buffer.from('descriptor'),
    });

    await expect(launched.stop()).rejects.toMatchObject({ code: 'plugin_exec_termination_incomplete' });
  });

  it('retains a Windows Job with surviving members and retries its verified stop', async () => {
    const fake = createFakeChild(152);
    fake.stdin.resume();
    const native = createWindowsStopBoundary('Local\\happier-workspace-sync-retry-test', { membersRemaining: true });
    const launchers = createWorkspaceSyncNativeProcessLaunchers({
      platform: 'win32', spawn: () => fake.child,
      resolveProcessCustodyRuntimeExecutable: () => '/verified/happier-process-custody.exe',
      createWindowsJobCustodyName: () => 'Local\\happier-workspace-sync-retry-test',
      createProcessCustodyHandshakePath: () => 'C:\\Temp\\workspace-sync-retry.json',
      waitForProcessCustodyHandshake: vi.fn(async () => ({ pid: 5151 })),
      processTreeSystemBoundary: native.boundary,
      logStderr: vi.fn(),
    });
    const launched = await launchers.spawnSidecar({
      executablePath: '/verified/happier-mutagen.exe',
      args: ['--daemon', '--broker-descriptor', '3'], inheritedBrokerDescriptor: Buffer.from('descriptor'),
    });

    await expect(launched.stop()).rejects.toMatchObject({
      code: 'plugin_exec_termination_incomplete',
      result: { status: 'incomplete', outcomes: [expect.objectContaining({ pid: 5151, outcome: 'survived' })] },
    });
    expect(native.live).toBe(true);
    native.setMembersRemaining(false);
    await expect(launched.stop()).resolves.toBeUndefined();
    expect(native.live).toBe(false);
  });

  it('places the Windows sidecar in native Job Object custody before publishing its target pid', async () => {
    const fake = createFakeChild(141);
    const calls: SpawnCall[] = [];
    const descriptorChunks: Buffer[] = [];
    fake.stdin.on('data', (chunk: Buffer) => descriptorChunks.push(Buffer.from(chunk)));
    fake.descriptor.resume();
    const onSpawned = vi.fn();
    const native = createWindowsStopBoundary('Local\\happier-workspace-sync-sidecar-test');
    const launchers = createWorkspaceSyncNativeProcessLaunchers({
      platform: 'win32',
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return fake.child;
      },
      resolveProcessCustodyRuntimeExecutable: () => '/verified/happier-process-custody.exe',
      createWindowsJobCustodyName: () => 'Local\\happier-workspace-sync-sidecar-test',
      createProcessCustodyHandshakePath: () => 'C:\\Temp\\workspace-sync-sidecar-handshake.json',
      waitForProcessCustodyHandshake: vi.fn(async () => ({ pid: 4242 })),
      processTreeSystemBoundary: native.boundary,
      logStderr: vi.fn(),
    });
    const privateDescriptor = Buffer.from('{"secret":"windows-private-broker-secret"}', 'utf8');

    const launched = await launchers.spawnSidecar({
      executablePath: '/verified/happier-mutagen.exe',
      args: ['--daemon', '--data-directory', 'C:\\Happier\\sync', '--broker-descriptor', '3'],
      inheritedBrokerDescriptor: privateDescriptor,
      onSpawned,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: '/verified/happier-process-custody.exe',
      args: [
        'run',
        '--job=Local\\happier-workspace-sync-sidecar-test',
        '--handshake=C:\\Temp\\workspace-sync-sidecar-handshake.json',
        '--target-inherited-stdin-arg=--broker-descriptor',
        '--',
        '/verified/happier-mutagen.exe',
        '--daemon',
        '--data-directory',
        'C:\\Happier\\sync',
      ],
      options: {
        detached: false,
        shell: false,
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
      },
    });
    expect(onSpawned).toHaveBeenCalledWith(4242);
    expect(parseProcessOwnerTag(calls[0]?.options.env?.HAPPIER_PROCESS_OWNER)?.owner).toEqual({ kind: 'workspace_sync' });
    expect(launched.pid).toBe(4242);
    expect(Buffer.concat(descriptorChunks)).toEqual(privateDescriptor);
    expect(JSON.stringify(calls[0])).not.toContain('windows-private-broker-secret');

    await launched.stop();
    expect(native.live).toBe(false);
    expect(native.terminateWindowsJob).toHaveBeenCalledWith(expect.objectContaining({
      jobName: 'Local\\happier-workspace-sync-sidecar-test',
      timeoutMs: CUSTODY_TERMINATE_TIMEOUT_MS,
    }));
  });

  it('fails Windows sidecar launch before spawning when the native custody helper is unavailable', async () => {
    const spawn = vi.fn(() => {
      throw new Error('spawn must not be reached without custody');
    });
    const launchers = createWorkspaceSyncNativeProcessLaunchers({
      platform: 'win32',
      spawn,
      resolveProcessCustodyRuntimeExecutable: () => null,
    });

    await expect(launchers.spawnSidecar({
      executablePath: '/verified/happier-mutagen.exe',
      args: ['--daemon', '--broker-descriptor', '3'],
      inheritedBrokerDescriptor: Buffer.from('descriptor'),
    })).rejects.toThrow('custody helper');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('still attempts Windows sidecar stop when handshake-file cleanup fails', async () => {
    const fake = createFakeChild(147);
    const handshakeFailure = new Error('handshake cleanup failed');
    const native = createWindowsStopBoundary('Local\\happier-workspace-sync-sidecar-cleanup-test');
    const launchers = createWorkspaceSyncNativeProcessLaunchers({
      platform: 'win32',
      spawn: () => fake.child,
      resolveProcessCustodyRuntimeExecutable: () => '/verified/happier-process-custody.exe',
      createWindowsJobCustodyName: () => 'Local\\happier-workspace-sync-sidecar-cleanup-test',
      createProcessCustodyHandshakePath: () => 'C:\\Temp\\workspace-sync-sidecar-cleanup.json',
      waitForProcessCustodyHandshake: vi.fn(async () => null),
      removeProcessCustodyHandshakeFile: vi.fn(async () => { throw handshakeFailure; }),
      processTreeSystemBoundary: native.boundary,
      logStderr: vi.fn(),
    });

    const error = await launchers.spawnSidecar({
      executablePath: '/verified/happier-mutagen.exe',
      args: ['--daemon', '--broker-descriptor', '3'],
      inheritedBrokerDescriptor: Buffer.from('descriptor'),
    }).then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('custody could not be established') }),
      handshakeFailure,
    ]);
    expect(native.live).toBe(false);
  });

  it('runs the Windows rooted agent through the same pre-execution Job Object owner', async () => {
    const fake = createFakeChild(142);
    const calls: SpawnCall[] = [];
    const native = createWindowsStopBoundary('Local\\happier-workspace-sync-agent-test');
    const launchers = createWorkspaceSyncNativeProcessLaunchers({
      platform: 'win32',
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return fake.child;
      },
      resolveProcessCustodyRuntimeExecutable: () => '/verified/happier-process-custody.exe',
      createWindowsJobCustodyName: () => 'Local\\happier-workspace-sync-agent-test',
      createProcessCustodyHandshakePath: () => 'C:\\Temp\\workspace-sync-agent-handshake.json',
      waitForProcessCustodyHandshake: vi.fn(async () => ({ pid: 4343 })),
      processTreeSystemBoundary: native.boundary,
      logStderr: vi.fn(),
    });

    const agent = await launchers.launchLocalAgent({
      executablePath: '/verified/happier-mutagen-agent.exe',
      args: ['--root', 'C:\\workspaces\\owned', '--stdio'],
      dataDirectory: 'C:\\happier\\workspace-sync\\mutagen\\data',
    });
    const { stream } = agent;

    expect(calls[0]).toEqual({
      command: '/verified/happier-process-custody.exe',
      args: [
        'run',
        '--job=Local\\happier-workspace-sync-agent-test',
        '--handshake=C:\\Temp\\workspace-sync-agent-handshake.json',
        '--',
        '/verified/happier-mutagen-agent.exe',
        '--root',
        'C:\\workspaces\\owned',
        '--stdio',
      ],
      options: expect.objectContaining({
        detached: false,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: expect.objectContaining({ MUTAGEN_DATA_DIRECTORY: 'C:\\happier\\workspace-sync\\mutagen\\data' }),
      }),
    });

    stream.on('error', () => undefined);
    stream.destroy();
    await agent.stop();
    expect(native.live).toBe(false);
    expect(native.terminateWindowsJob).toHaveBeenCalledWith(expect.objectContaining({
      jobName: 'Local\\happier-workspace-sync-agent-test',
    }));
  });

  it('preserves the direct macOS sidecar launch and writes the private broker descriptor only to fd 3', async () => {
    const fake = createFakeChild(41);
    const calls: SpawnCall[] = [];
    const descriptorChunks: Buffer[] = [];
    fake.descriptor.on('data', (chunk: Buffer) => descriptorChunks.push(Buffer.from(chunk)));
    const terminateProcessTree = vi.fn(async () => undefined);
    const launchers = createWorkspaceSyncNativeProcessLaunchers({
      platform: 'darwin',
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return fake.child;
      },
      createManagedChildProcess: () => createManaged(41),
      terminateProcessTree,
      logStderr: vi.fn(),
    });
    const privateDescriptor = Buffer.from('{"secret":"private-broker-secret"}', 'utf8');
    const launchOrder: string[] = [];
    fake.descriptor.once('data', () => launchOrder.push('descriptor'));

    const launched = await launchers.spawnSidecar({
      executablePath: '/verified/bin/happier-mutagen',
      args: ['--daemon', '--broker-descriptor', '3'],
      inheritedBrokerDescriptor: privateDescriptor,
      onSpawned: (pid) => launchOrder.push(`pid:${pid}`),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: '/verified/bin/happier-mutagen',
      args: ['--daemon', '--broker-descriptor', '3'],
      options: {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
      },
    });
    expect(parseProcessOwnerTag(calls[0]?.options.env?.HAPPIER_PROCESS_OWNER)?.owner).toEqual({ kind: 'workspace_sync' });
    expect(JSON.stringify(calls[0])).not.toContain('private-broker-secret');
    expect(Buffer.concat(descriptorChunks)).toEqual(privateDescriptor);
    expect(fake.descriptor.writableEnded).toBe(true);
    expect(launched.pid).toBe(41);
    expect(launchOrder).toEqual(['pid:41', 'descriptor']);

    await Promise.all([launched.stop(), launched.stop()]);
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
  });

  it('coalesces an in-flight sidecar stop and retries after the stop rejects', async () => {
    const fake = createFakeChild(46);
    const cleanupFailure = new Error('process tree cleanup failed');
    let finishFirstStop!: () => void;
    const firstStopGate = new Promise<void>((resolve) => { finishFirstStop = resolve; });
    const terminateProcessTree = vi.fn()
      .mockImplementationOnce(async () => {
        await firstStopGate;
        throw cleanupFailure;
      })
      .mockResolvedValueOnce(undefined);
    const launchers = createWorkspaceSyncNativeProcessLaunchers({
      spawn: () => fake.child,
      createManagedChildProcess: () => createManaged(46),
      terminateProcessTree,
      logStderr: vi.fn(),
    });
    fake.descriptor.resume();
    const launched = await launchers.spawnSidecar({
      executablePath: '/verified/bin/happier-mutagen',
      args: ['--daemon', '--broker-descriptor', '3'],
      inheritedBrokerDescriptor: Buffer.from('descriptor'),
    });

    const first = launched.stop();
    const concurrent = launched.stop();
    finishFirstStop();
    await expect(Promise.all([first, concurrent])).rejects.toBe(cleanupFailure);
    await expect(launched.stop()).resolves.toBeUndefined();
    expect(terminateProcessTree).toHaveBeenCalledTimes(2);
  });

  it('fails the sidecar launch and retires the child when fd 3 is unavailable', async () => {
    const fake = createFakeChild(42);
    const childWithoutDescriptor = Object.assign(fake.child, {
      stdio: [fake.stdin, fake.stdout, fake.stderr, null, null],
    }) as ChildProcess;
    const terminateProcessTree = vi.fn(async () => undefined);
    const launchers = createWorkspaceSyncNativeProcessLaunchers({
      spawn: () => childWithoutDescriptor,
      createManagedChildProcess: () => createManaged(42),
      terminateProcessTree,
      logStderr: vi.fn(),
    });

    await expect(launchers.spawnSidecar({
      executablePath: '/verified/bin/happier-mutagen',
      args: [],
      inheritedBrokerDescriptor: Buffer.from('descriptor'),
    })).rejects.toThrow('descriptor');
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
  });

  it('retains a sidecar whose pre-return cleanup fails and retries it through the launcher owner', async () => {
    const fake = createFakeChild(148);
    const childWithoutDescriptor = Object.assign(fake.child, {
      stdio: [fake.stdin, fake.stdout, fake.stderr, null, null],
    }) as ChildProcess;
    const cleanupFailure = new Error('sidecar process cleanup failed');
    const terminateProcessTree = vi.fn()
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(undefined);
    const launchers = createWorkspaceSyncNativeProcessLaunchers({
      spawn: () => childWithoutDescriptor,
      createManagedChildProcess: () => createManaged(148),
      terminateProcessTree,
      logStderr: vi.fn(),
    });

    const error = await launchers.spawnSidecar({
      executablePath: '/verified/bin/happier-mutagen',
      args: [],
      inheritedBrokerDescriptor: Buffer.from('descriptor'),
    }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('descriptor') }),
      cleanupFailure,
    ]);
    await expect(launchers.stopRetainedNativeProcesses()).resolves.toBeUndefined();
    expect(terminateProcessTree).toHaveBeenCalledTimes(2);
  });

  it('surfaces persistent retained sidecar cleanup failure on every launcher shutdown attempt', async () => {
    const fake = createFakeChild(149);
    const childWithoutDescriptor = Object.assign(fake.child, {
      stdio: [fake.stdin, fake.stdout, fake.stderr, null, null],
    }) as ChildProcess;
    const cleanupFailure = new Error('persistent sidecar cleanup failure');
    const terminateProcessTree = vi.fn(async () => { throw cleanupFailure; });
    const launchers = createWorkspaceSyncNativeProcessLaunchers({
      spawn: () => childWithoutDescriptor,
      createManagedChildProcess: () => createManaged(149),
      terminateProcessTree,
      logStderr: vi.fn(),
    });

    await expect(launchers.spawnSidecar({
      executablePath: '/verified/bin/happier-mutagen',
      args: [],
      inheritedBrokerDescriptor: Buffer.from('descriptor'),
    })).rejects.toBeInstanceOf(AggregateError);
    await expect(launchers.stopRetainedNativeProcesses()).rejects.toBe(cleanupFailure);
    await expect(launchers.stopRetainedNativeProcesses()).rejects.toBe(cleanupFailure);
    expect(terminateProcessTree).toHaveBeenCalledTimes(3);
  });

  it('fails the sidecar launch and retires the child when the descriptor write fails', async () => {
    const fake = createFakeChild(45);
    const descriptorFailure = new Error('descriptor pipe closed');
    const failingDescriptor = new Writable({
      write: (_chunk, _encoding, callback) => callback(descriptorFailure),
    });
    const childWithFailingDescriptor = Object.assign(fake.child, {
      stdio: [fake.stdin, fake.stdout, fake.stderr, failingDescriptor, null],
    }) as ChildProcess;
    const terminateProcessTree = vi.fn(async () => undefined);
    const launchers = createWorkspaceSyncNativeProcessLaunchers({
      spawn: () => childWithFailingDescriptor,
      createManagedChildProcess: () => createManaged(45),
      terminateProcessTree,
      logStderr: vi.fn(),
    });

    await expect(launchers.spawnSidecar({
      executablePath: '/verified/bin/happier-mutagen',
      args: [],
      inheritedBrokerDescriptor: Buffer.from('descriptor'),
    })).rejects.toThrow('descriptor pipe closed');
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
  });

  it('returns a bidirectional agent duplex, preserves half-close, and retires on destruction', async () => {
    const fake = createFakeChild(43);
    const terminateProcessTree = vi.fn(async () => undefined);
    const logStderr = vi.fn();
    const launchers = createWorkspaceSyncNativeProcessLaunchers({
      spawn: () => fake.child,
      createManagedChildProcess: () => createManaged(43),
      terminateProcessTree,
      logStderr,
    });
    const childInput: Buffer[] = [];
    fake.stdin.on('data', (chunk: Buffer) => childInput.push(Buffer.from(chunk)));

    const agent = await launchers.launchLocalAgent({
      executablePath: '/verified/bin/happier-mutagen-agent',
      args: ['--root', '/workspace', '--stdio'],
      dataDirectory: '/daemon/workspace-sync/mutagen/data',
    });
    const { stream } = agent;
    const childOutput: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => childOutput.push(Buffer.from(chunk)));

    stream.write(Buffer.from('request-bytes'));
    fake.stdout.write(Buffer.from('response-bytes'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(Buffer.concat(childInput).toString('utf8')).toBe('request-bytes');
    expect(Buffer.concat(childOutput).toString('utf8')).toBe('response-bytes');

    const inputEnded = new Promise<void>((resolve) => fake.stdin.once('end', resolve));
    stream.end();
    await inputEnded;
    expect(terminateProcessTree).not.toHaveBeenCalled();
    fake.stdout.write(Buffer.from('after-half-close'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(Buffer.concat(childOutput).toString('utf8')).toBe('response-bytesafter-half-close');

    fake.stderr.write(Buffer.from('agent diagnostic with private-broker-secret'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(logStderr).toHaveBeenCalledWith(
      'workspace-sync-agent',
      Buffer.byteLength('agent diagnostic with private-broker-secret'),
    );
    expect(JSON.stringify(logStderr.mock.calls)).not.toContain('private-broker-secret');

    stream.destroy();
    await agent.stop();
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
  });

  it('retires an agent and removes its abort listener when aborted', async () => {
    const fake = createFakeChild(44);
    const terminateProcessTree = vi.fn(async () => undefined);
    const launchers = createWorkspaceSyncNativeProcessLaunchers({
      spawn: () => fake.child,
      createManagedChildProcess: () => createManaged(44),
      terminateProcessTree,
      logStderr: vi.fn(),
    });
    const controller = new AbortController();
    const agent = await launchers.launchLocalAgent({
      executablePath: '/verified/bin/happier-mutagen-agent',
      args: [],
      dataDirectory: '/daemon/workspace-sync/mutagen/data',
      signal: controller.signal,
    });
    const { stream } = agent;
    stream.on('error', () => undefined);

    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await agent.stop();

    expect(stream.destroyed).toBe(true);
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
  });

  it('retains a local agent whose launch cleanup fails and retries it through the launcher owner', async () => {
    const fake = createFakeChild(45);
    const childWithoutInput = Object.assign(fake.child, { stdin: null }) as ChildProcess;
    const cleanupFailure = new Error('agent process cleanup failed');
    const terminateProcessTree = vi.fn()
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(undefined);
    const launchers = createWorkspaceSyncNativeProcessLaunchers({
      spawn: () => childWithoutInput,
      createManagedChildProcess: () => createManaged(45),
      terminateProcessTree,
      logStderr: vi.fn(),
    });

    const error = await launchers.launchLocalAgent({
      executablePath: '/verified/bin/happier-mutagen-agent',
      args: [],
      dataDirectory: '/daemon/workspace-sync/mutagen/data',
    }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('stdio pipes') }),
      cleanupFailure,
    ]);
    await expect(launchers.stopRetainedNativeProcesses()).resolves.toBeUndefined();
    expect(terminateProcessTree).toHaveBeenCalledTimes(2);
  });
});
