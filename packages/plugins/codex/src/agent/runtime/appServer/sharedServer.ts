import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createSecureTempDirectorySync } from '@happier-dev/plugin-sdk/fs';
import type { LoggerService } from '@happier-dev/plugin-sdk';

import type { ExecService, PluginProcessHandle, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';

import { parseCodexCliStableVersion } from '../../cli/detect.js';
import {
  buildCodexAppServerArgs,
  buildCodexAppServerEnv,
  createCodexNativeAppServerClient,
  probeCodexRealtimeConversationFeature,
  type DisposableCodexAppServerClient,
} from './client.js';
import { readCodexAppServerStartupRpcTimeoutMs } from './client/timeout.js';
import { withCodexNativeStartupLock } from './nativeStartupLock.js';

type CodexAppServerEnv = Readonly<Record<string, string | undefined>>;
type AgentNativeLaunchQualifier = NonNullable<NonNullable<Parameters<ExecService['spawn']>[1]>['nativeLaunch']>;
const SHARED_CONTROL_MIN_MINOR_UNIX = 131;

type StartupFailureReason = 'process_exited' | 'process_observation_failed';
export type CodexSharedAppServerStartupFailure = Readonly<{
  phase: 'socket_wait';
  reason: StartupFailureReason;
  terminationKind?: PluginProcessResult['termination']['observed']['kind'];
  terminationRequestedBy?: PluginProcessResult['termination']['requestedBy']['kind'];
  nativeExitCode?: number;
  nativeSignal?: string;
  stderrPresent?: boolean;
  stderrTruncated?: boolean;
}>;

/** Re-admits only closed process facts after an error crosses a bundle/module boundary. */
export function readCodexSharedAppServerStartupFailure(value: unknown): CodexSharedAppServerStartupFailure | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.phase !== 'socket_wait'
    || (record.reason !== 'process_exited' && record.reason !== 'process_observation_failed')) return null;
  const terminationKind = record.terminationKind === 'exit'
    || record.terminationKind === 'signal' || record.terminationKind === 'failed'
    ? record.terminationKind : undefined;
  const terminationRequestedBy = record.terminationRequestedBy === 'none'
    || record.terminationRequestedBy === 'timeout' || record.terminationRequestedBy === 'abort'
    || record.terminationRequestedBy === 'dispose'
    ? record.terminationRequestedBy : undefined;
  const nativeExitCode = Number.isSafeInteger(record.nativeExitCode) ? record.nativeExitCode as number : undefined;
  const nativeSignal = typeof record.nativeSignal === 'string' && Object.hasOwn(constants.signals, record.nativeSignal)
    ? record.nativeSignal : undefined;
  return Object.freeze({
    phase: 'socket_wait', reason: record.reason,
    ...(terminationKind ? { terminationKind } : {}),
    ...(terminationRequestedBy ? { terminationRequestedBy } : {}),
    ...(nativeExitCode !== undefined ? { nativeExitCode } : {}),
    ...(nativeSignal ? { nativeSignal } : {}),
    ...(typeof record.stderrPresent === 'boolean' ? { stderrPresent: record.stderrPresent } : {}),
    ...(typeof record.stderrTruncated === 'boolean' ? { stderrTruncated: record.stderrTruncated } : {}),
  });
}

export class CodexSharedAppServerStartupError extends Error {
  readonly code = 'agent_startup_transport_failed';
  readonly startupFailure: CodexSharedAppServerStartupFailure;

  constructor(reason: StartupFailureReason, result?: PluginProcessResult) {
    super('Codex shared app-server did not become ready.');
    this.name = 'CodexSharedAppServerStartupError';
    const observed = result?.termination.observed;
    // Native output can contain credentials or configuration. Retain only
    // closed process facts, never stderr, diagnostic payloads or error prose.
    this.startupFailure = Object.freeze({
      phase: 'socket_wait', reason,
      ...(observed ? { terminationKind: observed.kind } : {}),
      ...(result ? { terminationRequestedBy: result.termination.requestedBy.kind,
        stderrPresent: result.stderr.byteLength > 0, stderrTruncated: result.stderrTruncated } : {}),
      ...(observed?.kind === 'exit' && Number.isSafeInteger(observed.exitCode) ? { nativeExitCode: observed.exitCode } : {}),
      ...(observed?.kind === 'signal' && Object.hasOwn(constants.signals, observed.signal) ? { nativeSignal: observed.signal } : {}),
    });
  }
}

type Dependencies = Readonly<{
  readCodexVersion: (exec: ExecService, env: CodexAppServerEnv, signal?: AbortSignal) => Promise<string>;
  createRuntimeDirectory: () => Promise<string>;
  waitForSocket: (socketPath: string, process: PluginProcessHandle, signal?: AbortSignal) => Promise<void>;
  removeRuntimeDirectory: (directory: string) => Promise<void>;
  createClient: typeof createCodexNativeAppServerClient;
  probeRealtime: typeof probeCodexRealtimeConversationFeature;
}>;

async function readCodexVersion(
  exec: ExecService,
  env: CodexAppServerEnv,
  signal?: AbortSignal,
): Promise<string> {
  const tool = await exec.systemTools.resolve({
    toolId: 'codex-cli',
    purpose: 'Check Codex shared local-control support',
    ...(signal ? { signal } : {}),
  });
  const result = await exec.run({
    executable: tool.executable,
    args: ['--version'],
    cwd: { root: 'workspace', relativePath: '' },
    env: buildCodexAppServerEnv(env),
    maxStdoutBytes: 4_096,
    maxStderrBytes: 4_096,
    timeoutMs: readCodexAppServerStartupRpcTimeoutMs(env),
  }, signal ? { signal } : undefined);
  return result.termination.requestedBy.kind === 'none'
    && result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0
    && !result.stdoutTruncated && !result.stderrTruncated
    ? new TextDecoder().decode(result.stdout) : '';
}

function supportsSharedControl(versionOutput: string, platform: NodeJS.Platform): boolean {
  // Codex 0.154 added protected Windows AF_UNIX sockets, but Node's IPC path
  // transport connects Windows named pipes only. Fail closed until the host
  // provides an AF_UNIX-capable bridge for the plugin transport.
  if (platform === 'win32') return false;
  const version = parseCodexCliStableVersion(versionOutput);
  return Boolean(version && (version.major > 0 || version.minor >= SHARED_CONTROL_MIN_MINOR_UNIX));
}

async function waitForSocket(
  socketPath: string,
  process: PluginProcessHandle,
  signal?: AbortSignal,
): Promise<void> {
  let result: PluginProcessResult | undefined;
  let observationFailed = false;
  void process.wait().then(value => { result = value; }, () => { observationFailed = true; });
  // A cold native home backfills its history before publishing the socket.
  // That work is not an initialize RPC and can outlast its request budget;
  // killing it leaves Codex's native backfill lease running on the next start.
  // The opening Session owns cancellation; the process owns terminal failure.
  while (true) {
    signal?.throwIfAborted();
    if (result) throw new CodexSharedAppServerStartupError('process_exited', result);
    if (observationFailed) throw new CodexSharedAppServerStartupError('process_observation_failed');
    try {
      await stat(socketPath);
      return;
    } catch {
      await delay(25, undefined, { signal });
    }
  }
}

function defaultDependencies(): Dependencies {
  let temporary: ReturnType<typeof createSecureTempDirectorySync> | undefined;
  return {
    readCodexVersion,
    createRuntimeDirectory: async () => {
      // Shared control is Unix-only. A caller's TMPDIR can exceed AF_UNIX's
      // pathname capacity; retain the SDK's private ownership/cleanup under
      // the short native Unix temp parent instead of changing child-process env.
      temporary = createSecureTempDirectorySync({ prefix: 'codex', tmpDir: '/tmp' });
      return temporary.path;
    },
    waitForSocket,
    removeRuntimeDirectory: async () => temporary?.cleanup(),
    createClient: createCodexNativeAppServerClient,
    probeRealtime: probeCodexRealtimeConversationFeature,
  };
}

export async function createCodexSharedAppServer(params: Readonly<{
  exec: ExecService;
  logger?: Pick<LoggerService, 'debug'>;
  nativeLaunch?: AgentNativeLaunchQualifier;
  processEnv: CodexAppServerEnv;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  dependencies?: Partial<Dependencies>;
}>): Promise<Readonly<{
  endpoint: string;
  createClient: (request: Readonly<{
    cwd: string;
    processEnv: CodexAppServerEnv;
    configOverrides: readonly string[];
    disableUserMcpServers: boolean;
    toolRestrictionRequired?: boolean;
    toolRestrictionAllowedMcpServerKeys?: readonly string[];
  }>) => Promise<DisposableCodexAppServerClient>;
  dispose: () => Promise<void>;
}> | null> {
  const dependencies = { ...defaultDependencies(), ...params.dependencies };
  const versionOutput = await dependencies.readCodexVersion(
    params.exec,
    params.processEnv,
    params.signal,
  ).catch(() => '');
  if (!supportsSharedControl(versionOutput, params.platform ?? process.platform)) return null;

  const runtimeDirectory = await dependencies.createRuntimeDirectory();
  // Leave the socket parent absent so Codex creates it with its cross-platform
  // private-directory policy (0700 on Unix, a user-only DACL on Windows).
  const socketPath = join(runtimeDirectory, 'private', 'app-server.sock');
  const endpoint = `unix://${socketPath}`;
  let serverProcess: PluginProcessHandle | null = null;
  let realtimeConversationAdvertised = false;
  let startPromise: Promise<void> | null = null;
  let initialClient: DisposableCodexAppServerClient | null = null;
  let disposed = false;

  const ensureStarted = async (request: Readonly<{
    cwd: string;
    processEnv: CodexAppServerEnv;
    configOverrides: readonly string[];
    disableUserMcpServers: boolean;
    toolRestrictionRequired?: boolean;
    toolRestrictionAllowedMcpServerKeys?: readonly string[];
  }>): Promise<void> => {
    startPromise ??= withCodexNativeStartupLock(async configOverrides => {
      try {
        const tool = await params.exec.systemTools.resolve({
          toolId: 'codex-cli',
          purpose: 'Launch the Codex shared app-server',
          ...(params.signal ? { signal: params.signal } : {}),
        });
        realtimeConversationAdvertised = await dependencies.probeRealtime({
          exec: params.exec,
          executable: tool.executable,
          env: request.processEnv,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        serverProcess = await params.exec.spawn({
          executable: tool.executable,
          args: buildCodexAppServerArgs({
            env: request.processEnv,
            configOverrides,
            disableUserMcpServers: request.disableUserMcpServers,
            enableRealtimeConversation: realtimeConversationAdvertised,
            listenUrl: endpoint,
          }),
          cwd: { root: 'workspace', relativePath: '' },
          env: buildCodexAppServerEnv(request.processEnv),
          maxStdoutBytes: 4_096,
          maxStderrBytes: 16_384,
        }, params.signal || params.nativeLaunch ? {
          ...(params.signal ? { signal: params.signal } : {}),
          ...(params.nativeLaunch ? { nativeLaunch: params.nativeLaunch } : {}),
        } : undefined);
        await dependencies.waitForSocket(
          socketPath,
          serverProcess,
          params.signal,
        );
        // A published socket is not native SQLite/skill initialization readiness.
        // Reuse this initialized connection for the first admitted runtime client.
        initialClient = await dependencies.createClient({
          exec: params.exec,
          cwd: request.cwd,
          processEnv: request.processEnv,
          toolRestrictionRequired: request.toolRestrictionRequired,
          toolRestrictionAllowedMcpServerKeys: request.toolRestrictionAllowedMcpServerKeys,
          signal: params.signal,
          transport: { kind: 'unixWebSocket', socketPath, realtimeConversationAdvertised },
        });
      } catch (error) {
        // Initialization failure must finish native shutdown before another
        // process is admitted to shared SQLite/skills startup resources.
        const failures: unknown[] = [error];
        await initialClient?.dispose().catch((cleanupError: unknown) => { failures.push(cleanupError); });
        initialClient = null;
        await serverProcess?.dispose().catch((cleanupError: unknown) => { failures.push(cleanupError); });
        serverProcess = null;
        if (failures.length > 1) {
          throw new AggregateError(failures, 'Codex shared app-server startup and cleanup failed.');
        }
        throw error;
      }
    }, params.signal, params.logger, { processEnv: request.processEnv, configOverrides: request.configOverrides, cwd: request.cwd, versionOutput });
    try {
      await startPromise;
    } catch (error) {
      await dependencies.removeRuntimeDirectory(runtimeDirectory);
      throw error;
    }
  };

  return {
    endpoint,
    createClient: async (request) => {
      await ensureStarted(request);
      if (initialClient) {
        const client = initialClient;
        initialClient = null;
        return client;
      }
      return await dependencies.createClient({
        exec: params.exec,
        cwd: request.cwd,
        processEnv: request.processEnv,
        toolRestrictionRequired: request.toolRestrictionRequired,
        toolRestrictionAllowedMcpServerKeys: request.toolRestrictionAllowedMcpServerKeys,
        signal: params.signal,
        transport: {
          kind: 'unixWebSocket',
          socketPath,
          realtimeConversationAdvertised,
        },
      });
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await initialClient?.dispose().catch(() => undefined);
      initialClient = null;
      await serverProcess?.dispose().catch(() => undefined);
      await dependencies.removeRuntimeDirectory(runtimeDirectory);
    },
  };
}
