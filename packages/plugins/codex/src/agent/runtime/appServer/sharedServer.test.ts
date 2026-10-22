import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';

import { createCodexSharedAppServer } from './sharedServer.js';

type AgentNativeLaunchQualifier = NonNullable<NonNullable<Parameters<ExecService['spawn']>[1]>['nativeLaunch']>;

const osBoundary = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, userInfo: () => ({ ...os.userInfo(), homedir: osBoundary.home }) };
});

describe('createCodexSharedAppServer', () => {
  beforeEach(async () => { osBoundary.home = await mkdtemp(join(tmpdir(), 'codex-startup-home-')); });
  afterEach(async () => { await rm(osBoundary.home, { recursive: true, force: true }); });
  it.skipIf(process.platform === 'win32').each(['ready', 'abort', 'exit'] as const)(
    'observes native startup %s without imposing the RPC budget on backfill', async outcome => {
    const directory = await mkdtemp(join('/tmp', 'codex-backfill-'));
    const http = createServer();
    const sockets = new WebSocketServer({ server: http });
    sockets.on('connection', socket => socket.on('message', data => {
      const message = JSON.parse(String(data)) as { id?: number; method?: string };
      if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: {} }));
    }));
    const nativeResult: PluginProcessResult = {
      termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'dispose', reason: 'caller' } },
      stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
    };
    let settleExit: ((result: PluginProcessResult) => void) | undefined;
    const exited = new Promise<PluginProcessResult>(resolve => { settleExit = resolve; });
    let clockOffset = 0;
    const realNow = Date.now.bind(Date);
    const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
    const controller = new AbortController();
    const dispose = vi.fn(async () => {
      for (const socket of sockets.clients) socket.terminate();
      if (http.listening) await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      settleExit?.(nativeResult);
    });
    const exec = {
      systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' } }) },
      run: async (request: Parameters<ExecService['run']>[0]) => ({
        ...nativeResult,
        termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode(request.args?.includes('--version') ? 'codex-cli 0.162.1' : ''),
      }),
      spawn: async (request: Parameters<ExecService['spawn']>[0]) => {
        const args = request.args ?? [];
        const socketPath = args[args.indexOf('--listen') + 1]!.slice('unix://'.length);
        await mkdir(dirname(socketPath), { recursive: true });
        setTimeout(() => {
          if (outcome === 'exit') settleExit?.({ ...nativeResult,
            termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } },
          });
          else {
            // Simulate a native history backfill outlasting the RPC budget.
            clockOffset += 120_000;
            if (outcome === 'abort') controller.abort();
            else http.listen(socketPath);
          }
        }, 10);
        return { write: async () => undefined, closeStdin: async () => undefined,
          onOutput: () => ({ dispose: () => undefined }), wait: () => exited, dispose };
      },
    } as unknown as ExecService; // Only the native process boundary is substituted.
    let server: Awaited<ReturnType<typeof createCodexSharedAppServer>> = null;
    try {
        server = await createCodexSharedAppServer({
          exec, processEnv: {}, platform: 'linux', signal: controller.signal,
        });
        if (!server) throw new Error('Expected supported shared control');
        const opening = server.createClient({ cwd: directory, processEnv: {}, configOverrides: [], disableUserMcpServers: false });
        if (outcome === 'abort') {
          await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
          expect(dispose).toHaveBeenCalledTimes(1);
        } else if (outcome === 'exit') {
          await expect(opening).rejects.toMatchObject({ code: 'agent_startup_transport_failed',
            startupFailure: { reason: 'process_exited', nativeExitCode: 1 },
          });
        } else {
          const client = await opening;
          await client.dispose();
        }
    } finally {
      now.mockRestore();
      await server?.dispose();
      sockets.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32').each([
    ['serializes native socket startup until the first real initialize completes', false, false],
    ['keeps failed native socket startup exclusive through process shutdown', true, false],
    ['preserves native initialization failure alongside failed process cleanup', true, true],
  ] as const)('%s', async (_name, firstInitializeFails, firstCleanupFails) => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-shared-startup-'));
    const guard = join(directory, 'native-startup');
    const sqliteHome = join(directory, 'sqlite');
    const processEnv = { CODEX_HOME: join(directory, 'auth'), CODEX_SQLITE_HOME: sqliteHome };
    const nativeStartupLock = join(userInfo().homedir, '.happier-codex-native-startup.lock');
    const cleanupWasExclusive: boolean[] = [];
    let spawnCount = 0;
    let releaseInitialization: () => void = () => undefined;
    const initializationReady = new Promise<void>(resolve => { releaseInitialization = resolve; });
    const nativeLaunch = Object.freeze({}) as AgentNativeLaunchQualifier;
    const spawnOptions: Parameters<ExecService['spawn']>[1][] = [];
    const probeOptions: Parameters<ExecService['run']>[1][] = [];
    const result = (stdout = ''): PluginProcessResult => ({
      termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
      stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(),
      stdoutTruncated: false, stderrTruncated: false,
    });
    // Exec is the OS/host process boundary. The actual socket and real plugin
    // client perform the handshake; no provider orchestration is replaced.
    const exec = {
      systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' } }) },
      run: async (request: Parameters<ExecService['run']>[0], options: Parameters<ExecService['run']>[1]) => {
        probeOptions.push(options);
        return result(request.args?.includes('--version') ? 'codex-cli 0.162.1' : 'realtime_conversation under development false');
      },
      spawn: async (request: Parameters<ExecService['spawn']>[0], options: Parameters<ExecService['spawn']>[1]) => {
        spawnOptions.push(options);
        const shouldFailInitialize = firstInitializeFails && spawnCount++ === 0;
        const startupOwner = readFileSync(nativeStartupLock, 'utf8');
        await mkdir(guard);
        const args = request.args ?? [];
        if (process.platform === 'linux') expect(args).toContain(`sqlite_home=${JSON.stringify(sqliteHome)}`);
        const endpoint = args[args.indexOf('--listen') + 1];
        if (!endpoint?.startsWith('unix://')) throw new Error('Expected native Unix endpoint');
        const socketPath = endpoint.slice('unix://'.length);
        await mkdir(dirname(socketPath), { recursive: true });
        const http = createServer();
        const sockets = new WebSocketServer({ server: http });
        sockets.on('connection', socket => socket.on('message', async data => {
          const message = JSON.parse(String(data)) as { id?: number; method?: string };
          if (message.method === 'initialize') {
            await initializationReady;
            if (shouldFailInitialize) {
              socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: 'fixture initialize failed' } }));
              return;
            }
            await rm(guard, { recursive: true });
            socket.send(JSON.stringify({ id: message.id, result: {} }));
          } else if (message.id !== undefined) {
            socket.send(JSON.stringify({ id: message.id, result: { pong: true } }));
          }
        }));
        await new Promise<void>(resolve => http.listen(socketPath, resolve));
        let settleExit: ((exit: PluginProcessResult) => void) | undefined;
        const exited = new Promise<PluginProcessResult>(resolve => { settleExit = resolve; });
        return {
          pid: process.pid, write: async () => undefined, closeStdin: async () => undefined,
          onOutput: () => ({ dispose: () => undefined }), wait: async () => await exited,
          dispose: async () => {
            if (shouldFailInitialize) {
              let observedOwner: string | null = null;
              try { observedOwner = readFileSync(nativeStartupLock, 'utf8'); } catch { /* An absent owner means unlocked cleanup. */ }
              cleanupWasExclusive.push(observedOwner === startupOwner);
            }
            for (const socket of sockets.clients) socket.terminate();
            await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
            sockets.close();
            await rm(guard, { recursive: true, force: true });
            settleExit?.(result());
            if (shouldFailInitialize && firstCleanupFails) throw new Error('fixture native disposal failed');
          },
        };
      },
    } as unknown as ExecService; // A deliberately narrow fixture for the host-owned process boundary.
    const servers: NonNullable<Awaited<ReturnType<typeof createCodexSharedAppServer>>>[] = [];
    const clients: Awaited<ReturnType<(typeof servers)[number]['createClient']>>[] = [];
    const debug = vi.fn();
    const opening = Promise.allSettled([0, 1].map(async index => {
        const server = await createCodexSharedAppServer({
          exec, processEnv, platform: 'linux', nativeLaunch, logger: { debug },
          dependencies: {
            createRuntimeDirectory: async () => await mkdtemp(join('/tmp', `c-${index}-`)),
            removeRuntimeDirectory: async path => await rm(path, { recursive: true, force: true }),
          },
        });
        if (!server) throw new Error('Expected supported shared control');
        servers.push(server);
        const client = await server.createClient({ cwd: directory, processEnv, configOverrides: [], disableUserMcpServers: false });
        clients.push(client);
        return await client.request('test/ping');
    }));
    try {
      await vi.waitFor(() => expect(debug).toHaveBeenCalledTimes(1));
      releaseInitialization();
      const outcomes = await opening;
      expect(outcomes).toEqual(expect.arrayContaining([
        firstInitializeFails ? { status: 'rejected', reason: firstCleanupFails
          ? expect.objectContaining({ name: 'AggregateError', errors: [expect.objectContaining({ code: -32000 }), expect.objectContaining({ message: 'fixture native disposal failed' })] })
          : expect.any(Error) } : { status: 'fulfilled', value: { pong: true } },
        { status: 'fulfilled', value: { pong: true } },
      ]));
      if (firstInitializeFails) expect(cleanupWasExclusive[0]).toBe(true);
      expect(spawnOptions).toEqual([{ nativeLaunch }, { nativeLaunch }]);
      expect(probeOptions.every(options => options === undefined)).toBe(true);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug).toHaveBeenCalledWith(expect.any(String), {
        pid: process.pid, heldForMs: expect.any(Number), waitedForMs: expect.any(Number),
      });
    } finally {
      releaseInitialization();
      await opening;
      await Promise.all(clients.map(client => client.dispose()));
      await Promise.all(servers.map(server => server.dispose()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the canonical app-server startup budget for the shared-control version probe', async () => {
    const run = vi.fn(async () => ({
      stdout: new TextEncoder().encode('codex-cli 0.131.0'),
      stderr: new Uint8Array(),
      exitCode: 0,
    }));
    const server = await createCodexSharedAppServer({
      exec: {
        systemTools: { resolve: vi.fn(async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' } })) },
        run,
      } as never,
      processEnv: {},
      platform: 'linux',
      dependencies: {
        createRuntimeDirectory: async () => '/tmp/happier-codex-version-probe',
        removeRuntimeDirectory: async () => undefined,
      },
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      args: ['--version'],
      timeoutMs: 60_000,
    }), undefined);
    await server?.dispose();
  });

  it('starts one private socket server and connects Happier clients over its WebSocket transport', async () => {
    const processHandle = { dispose: vi.fn(async () => undefined) };
    const spawn = vi.fn(async () => processHandle);
    const createClient = vi.fn(async (params: unknown) => ({ params }));
    const removeRuntimeDirectory = vi.fn(async () => undefined);
    const waitForSocket = vi.fn(async () => undefined);
    const server = await createCodexSharedAppServer({
      exec: {
        systemTools: { resolve: vi.fn(async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' } })) },
        spawn,
      } as never,
      processEnv: { HOME: '/home/test' },
      platform: 'linux',
      dependencies: {
        readCodexVersion: async () => 'codex-cli 0.131.0',
        createRuntimeDirectory: async () => '/tmp/happier-codex-private',
        waitForSocket,
        removeRuntimeDirectory,
        createClient: createClient as never,
        probeRealtime: async () => true,
      },
    });

    expect(server?.endpoint).toBe('unix:///tmp/happier-codex-private/private/app-server.sock');
    await server?.createClient({
      cwd: '/repo',
      processEnv: {
        HOME: '/home/test',
        HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '90000',
      },
      configOverrides: ['model="gpt-5"'],
      disableUserMcpServers: false,
    });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        'app-server', '--listen', 'unix:///tmp/happier-codex-private/private/app-server.sock',
        '--enable', 'realtime_conversation',
        '-c', 'model="gpt-5"',
      ],
    }), undefined);
    expect(waitForSocket).toHaveBeenCalledWith(
      '/tmp/happier-codex-private/private/app-server.sock',
      processHandle,
      undefined,
    );
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      transport: {
        kind: 'unixWebSocket',
        socketPath: '/tmp/happier-codex-private/private/app-server.sock',
        realtimeConversationAdvertised: true,
      },
    }));
    await server?.dispose();
    expect(processHandle.dispose).toHaveBeenCalledTimes(1);
    expect(removeRuntimeDirectory).toHaveBeenCalledWith('/tmp/happier-codex-private');
  });

  it.each([
    ['linux', 'codex-cli 0.130.0', false],
    ['win32', 'codex-cli 0.153.0', false],
    ['win32', 'codex-cli 0.154.0', false],
    ['win32', 'codex-cli 0.999.0', false],
  ] as const)('uses the first safe shared app-server release on %s: %s', async (platform, version, expected) => {
    const spawn = vi.fn();
    const server = await createCodexSharedAppServer({
      exec: { systemTools: { resolve: vi.fn() }, spawn } as never,
      processEnv: {},
      platform,
      dependencies: {
        readCodexVersion: async () => version,
        createRuntimeDirectory: async () => '/tmp/happier-codex-version-gate',
        removeRuntimeDirectory: async () => undefined,
      },
    });
    expect(Boolean(server)).toBe(expected);
    expect(spawn).not.toHaveBeenCalled();
    await server?.dispose();
  });
});
