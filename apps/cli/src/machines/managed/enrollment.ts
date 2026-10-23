import { isDeepStrictEqual } from 'node:util';
import { readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import {
  createRemoteNativeBootstrapMachineTaskKind,
  normalizeRemoteReleaseArch, normalizeRemoteReleaseOs, resolveRemoteInstalledFirstPartyBinaryPath, SystemTaskExecutionError,
} from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { buildRemoteHappierInvocationCommand, createHappierJsonExecutorFromTextRunner, installRemoteFirstPartyComponentPayload, resolveLocalHappierCommandTimeoutMs, type InteractiveSystemTaskEventInput, type InteractiveSystemTaskKind } from '@happier-dev/cli-common/systemTasks';
import { ManagedEnrollmentCorrelationV1Schema, type ManagedEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedBootstrapCarrierV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { SavedSecretRefV1 } from '@happier-dev/protocol';
import { ManagedMachineControllerError } from './controllerErrors';
import { REMOTE_HOME_ENROLLMENT_POLL_INTERVAL_MS, TERMINAL_AUTH_POLL_INTERVAL_MS, type HomeOperationRetry } from '@/api/client/retryHomeOperation';
import { deliverManagedNativeFile } from './nativeFileDelivery';

export type ManagedNativeBootstrapIO = Readonly<{
  /** Buffered stdout/stderr/status is sufficient; output observers are optional. */
  exec(input: Readonly<{ command: string; input?: string; signal?: AbortSignal; timeoutMs?: number | null; onStdoutChunk?: (text: string) => void;
    processConfig?: Readonly<{ environment: Readonly<{ HOME: string; HAPPIER_HOME_DIR: string }> }> }>): Promise<Readonly<{ status: number; stdout: string; stderr: string }>>;
  putFile(input: Readonly<{ path: string; bytes: Uint8Array; signal?: AbortSignal }>): Promise<void>;
}>;
export type ManagedMachineEnrollmentDependencies = Readonly<{
  readCurrentManagedRow(): Promise<ManagedMachineV1>;
  onEnrollmentLifetime?(lifetime: HomeOperationRetry): void;
  native?: ManagedNativeBootstrapIO;
  materializeBootstrapCredential?(reference: Extract<SavedSecretRefV1, { kind: 'shared_resource' }>): Promise<Readonly<{ path: string; dispose(): Promise<void> }>>;
}>;

/** Host custody binds the existing binary task to one retained resource. */
export async function runManagedMachineEnrollment(input: Readonly<{
  correlation: ManagedEnrollmentCorrelationV1;
  target: ResolvedHomeTarget;
  carrier: unknown;
  signal?: AbortSignal;
  channel?: 'stable' | 'preview' | 'dev';
  onEvent?: (event: InteractiveSystemTaskEventInput) => void;
  onTask?: (task: Readonly<{ taskId: string; kind: 'remote.ssh.bootstrapMachine.v1' }>) => void | Promise<void>;
  /** The task's current unanswered question, then `null` once it is answered, so the waiting surface can ask it. */
  onPrompt?: (prompt: Readonly<{ kind: string; message: string }> | null) => void;
}>, deps: ManagedMachineEnrollmentDependencies): Promise<Readonly<{ machineId: string }>> {
  const correlation = ManagedEnrollmentCorrelationV1Schema.parse(input.correlation);
  const carrier = ManagedBootstrapCarrierV1Schema.parse(input.carrier);
  const onEnrollmentDeadline = (deadlineMs: number) => deps.onEnrollmentLifetime?.({ deadlineMs,
    pollIntervalMs: carrier.kind === 'native' ? TERMINAL_AUTH_POLL_INTERVAL_MS : REMOTE_HOME_ENROLLMENT_POLL_INTERVAL_MS,
    signal: input.signal });
  if (input.target.homeServerIdentityId !== correlation.homeId || !input.target.descriptor) {
    throw new SystemTaskExecutionError('home_identity_mismatch', 'Managed enrollment requires its admitted Home descriptor.');
  }
  const assertCurrent = async () => {
    input.signal?.throwIfAborted();
    const row = await deps.readCurrentManagedRow();
    if (row.id !== correlation.managedId || row.homeId !== correlation.homeId
      || row.intentRevision !== correlation.expectedIntentRevision || row.creationState !== 'active' || row.archivedAt !== undefined
      || !isDeepStrictEqual(row.controller, correlation.controller)) {
      throw new SystemTaskExecutionError('enrollment_retired', 'Managed enrollment admission is no longer current.');
    }
    if (row.allocation !== 'bound' || !isDeepStrictEqual(row.resource, correlation.resource)) {
      throw new SystemTaskExecutionError('resource_mismatch', 'Managed enrollment must use the retained native identity.');
    }
    return row;
  };
  const row = await assertCurrent();
  const nativeGuestHome = carrier.kind === 'native' ? carrier.guestHome : undefined;
  const configuration = {
    relay: { relayUrl: input.target.canonicalAuthUrl, webappUrl: input.target.webappUrl },
    homeTarget: input.target, managedEnrollment: correlation,
    requireLocalApproval: true,
    channel: input.channel ?? resolveManagedCliReleaseChannelSync({ argv: process.argv, invokedPath: process.argv[1], processEnv: process.env }).label,
    serviceMode: nativeGuestHome ? 'none' as const : 'user' as const,
  };
  const runPreparedTask = async (kind: InteractiveSystemTaskKind) => {
    const { getLiveSystemTasksRunnerAdapter } = await import('@/capabilities/systemTasks/liveSystemTasksRunner');
    const owner = getLiveSystemTasksRunnerAdapter();
    let controllerFailure: ManagedMachineControllerError | undefined;
    const task = await owner.startAdmitted({ run: async (ctx) => {
      try {
        return await kind.run({ ...ctx, emit: (event) => {
          ctx.emit(event);
          input.onEvent?.(event);
        }, prompt: async (prompt) => {
          input.onPrompt?.({ kind: prompt.kind, message: prompt.message });
          try { return await ctx.prompt(prompt); } finally { input.onPrompt?.(null); }
        } });
      } catch (error) {
        if (error instanceof ManagedMachineControllerError) {
          controllerFailure = error;
          throw new SystemTaskExecutionError(error.code, error.code);
        }
        throw error;
      }
    } });
    const cancel = () => { void owner.cancel(task); };
    input.signal?.addEventListener('abort', cancel, { once: true });
    if (input.signal?.aborted) cancel();
    try {
      await input.onTask?.({ ...task, kind: 'remote.ssh.bootstrapMachine.v1' });
      const result = await owner.wait(task);
      if (!result.ok) {
        // The task keeps its existing public error contract; its invoking
        // operation retains the original typed controller observation.
        if (controllerFailure && result.error?.code === controllerFailure.code) throw controllerFailure;
        throw new SystemTaskExecutionError(result.error?.code ?? 'system_task_failed', result.error?.message ?? 'Managed guest setup failed.');
      }
      const data = result.data;
      const machineId = data && typeof data === 'object' && !Array.isArray(data) && 'machineId' in data && typeof data.machineId === 'string' ? data.machineId : '';
      if (!machineId) throw new SystemTaskExecutionError('machine_registration_unconfirmed', 'Managed guest registration was not confirmed.');
      await assertCurrent();
      return { machineId };
    } catch (error) {
      await owner.cancel(task);
      await owner.wait(task);
      throw error;
    } finally { input.signal?.removeEventListener('abort', cancel); }
  };
  if (carrier.kind === 'ssh') {
    if (!isDeepStrictEqual(carrier.credentialRef, row.bootstrapCredentialRef) || !deps.materializeBootstrapCredential) {
      throw new SystemTaskExecutionError('credential_unavailable', 'The retained bootstrap credential is unavailable.');
    }
    const credential = await deps.materializeBootstrapCredential(carrier.credentialRef);
    try {
      await assertCurrent();
      const { createLiveRemoteSshBootstrapTaskKind } = await import('@/capabilities/systemTasks/ssh/liveRemoteSshBootstrap');
      const task = createLiveRemoteSshBootstrapTaskKind({ onEnrollmentDeadline, assertManagedEnrollmentCurrent: async () => { await assertCurrent(); } });
      return await runPreparedTask({ run: async (ctx) => task.run({ ...ctx, params: { ...configuration, ssh: {
        target: `${carrier.user}@${carrier.address}`, auth: 'keyfile', identityFile: credential.path,
          ...(carrier.port ? { port: carrier.port } : {}), hostKeyEvidence: carrier.hostKeyEvidence,
      } } }) });
    } finally { await credential.dispose(); }
  }
  if (!isDeepStrictEqual(carrier.transport.contributionRef, correlation.resource.contributionRef)
    || carrier.transport.schemaVersion !== correlation.resource.schemaVersion || !deps.native) {
    throw new SystemTaskExecutionError('resource_mismatch', 'Native bootstrap transport does not address the retained resource.');
  }
  const native = deps.native;
  const exec: ManagedNativeBootstrapIO['exec'] = async (request) => {
    await assertCurrent();
    const command = nativeGuestHome
      ? `export HOME=${safeBashSingleQuote(nativeGuestHome.homeDir)} HAPPIER_HOME_DIR=${safeBashSingleQuote(nativeGuestHome.happyHomeDir)}; cd ${safeBashSingleQuote(nativeGuestHome.homeDir)} && ${request.command}`
      : request.command;
    return await native.exec({ ...request, command, signal: request.signal ?? input.signal });
  };
  const putFile: ManagedNativeBootstrapIO['putFile'] = async (request) => {
    await assertCurrent();
    await native.putFile({ ...request, signal: request.signal ?? input.signal });
  };
  const configureNativeBoot = async (installedBinaryPath: string) => {
    if (!nativeGuestHome) return;
    const configured = await exec({ command: `exec env ${buildRemoteHappierInvocationCommand({ binaryPath: installedBinaryPath, args: ['daemon', 'start-sync'], channel: configuration.channel })}`,
      processConfig: { environment: { HOME: nativeGuestHome.homeDir, HAPPIER_HOME_DIR: nativeGuestHome.happyHomeDir } } });
    if (configured.status !== 0) throw new SystemTaskExecutionError('native_boot_unconfirmed', 'The native daemon boot configuration was not confirmed.');
    await assertCurrent();
  };
  // Registration may commit before the native config update is confirmed.
  // Retry the retained installation's boot config, not installation/pairing.
  if (row.enrolledMachineId && nativeGuestHome) {
    await configureNativeBoot(resolveRemoteInstalledFirstPartyBinaryPath({
      componentId: 'happier-cli', channel: configuration.channel, remoteHomeDir: nativeGuestHome.happyHomeDir,
    }));
    return { machineId: row.enrolledMachineId };
  }
  const observation = correlation.resource.devcontainerObservation;
  if (observation) {
    const namespace = await exec({ command: 'id -un; pwd -P' });
    // The first LF frames the username; only the final LF frames the path.
    // Paths themselves may contain newlines and must not be trimmed or split.
    const boundary = namespace.stdout.indexOf('\n');
    const user = boundary < 0 ? '' : namespace.stdout.slice(0, boundary);
    const workspaceFolder = boundary < 0 || !namespace.stdout.endsWith('\n')
      ? '' : namespace.stdout.slice(boundary + 1, -1);
    if (namespace.status !== 0 || user !== observation.user || workspaceFolder !== observation.workspaceFolder) {
      throw new SystemTaskExecutionError('resource_mismatch', 'Native guest namespace differs from the admitted observation.');
    }
    await assertCurrent();
  }
  let binaryPath = '';
  const installRemoteCli = async (signal?: AbortSignal) => {
      const platform = await exec({ command: 'uname -s; uname -m; printf "%s\\n" "$HOME"', signal });
      if (platform.status !== 0) throw new SystemTaskExecutionError('provider_unavailable', 'Native guest platform could not be observed.');
      const [os, arch, home] = platform.stdout.trim().split(/\r?\n/u);
      if (!home?.startsWith('/')) throw new SystemTaskExecutionError('provider_unavailable', 'Native guest home could not be observed.');
      const installed = await installRemoteFirstPartyComponentPayload({
        componentId: 'happier-cli', channel: configuration.channel, signal,
        ...(nativeGuestHome ? { remoteHomeDir: nativeGuestHome.happyHomeDir } : {}),
      }, {
        resolveRemoteReleaseTarget: async () => ({ os: normalizeRemoteReleaseOs(os), arch: normalizeRemoteReleaseArch(arch) }),
        runRemoteText: async ({ remoteCommand, signal: commandSignal }) => exec({ command: remoteCommand, signal: commandSignal }),
        copyLocalDirectoryToRemote: async ({ localPath, remotePath, signal: copySignal }) => {
          const archiveRoot = posix.resolve(home, remotePath, localPath.split(/[\\/]/u).at(-1)!);
          const mkdirResult = await exec({ command: `mkdir -p ${safeBashSingleQuote(archiveRoot)}`, signal: copySignal });
          if (mkdirResult.status !== 0) throw new SystemTaskExecutionError('remote_command_failed', 'Native payload staging failed.');
          for (const entry of await readdir(localPath, { withFileTypes: true })) {
            if (!entry.isFile()) throw new SystemTaskExecutionError('invalid_payload', 'The binary payload archive was not a regular file.');
            await deliverManagedNativeFile({ localPath: join(localPath, entry.name), guestPath: `${archiveRoot}/${entry.name}`,
              resource: correlation.resource.value, signal: copySignal }, { exec, putFile });
          }
        },
      });
      binaryPath = installed.binaryPath;
  };
  if (row.enrolledMachineId) {
    // Service-managed guests can update the installed CLI without issuing a new
    // sign-in or changing the existing Machine. Native-process boot recovery is
    // handled above and continues to reuse its retained installation.
    await installRemoteCli(input.signal);
    const args = ['daemon', 'service', 'install', '--json'];
    const updated = await exec({
      command: buildRemoteHappierInvocationCommand({ binaryPath, args, channel: configuration.channel }),
      timeoutMs: resolveLocalHappierCommandTimeoutMs(args),
    });
    if (updated.status !== 0) throw new SystemTaskExecutionError('background_service_failed', 'The updated guest background service could not be installed.');
    await assertCurrent();
    return { machineId: row.enrolledMachineId };
  }
  const executor = createHappierJsonExecutorFromTextRunner(async (args, options) => {
      if (!binaryPath) throw new SystemTaskExecutionError('cli_capability_missing', 'The native guest binary has not been installed.');
      return await exec({ command: buildRemoteHappierInvocationCommand({ binaryPath, args, channel: configuration.channel }), ...options,
        timeoutMs: options?.timeoutMs === undefined ? resolveLocalHappierCommandTimeoutMs(args) : options.timeoutMs,
      });
  });
  const task = createRemoteNativeBootstrapMachineTaskKind({
    onEnrollmentDeadline,
    configuration, executor, assertCurrent: async () => { await assertCurrent(); },
    installRemoteCli,
    approveLocalAuthRequest: async ({ publicKey, pairing, supportsTokenOnly, signal }) => {
      await assertCurrent();
      const { approveTerminalAuthRequest } = await import('@/auth/terminalAuthApproval');
      await approveTerminalAuthRequest({ publicKey, pairing, supportsTokenOnly, target: input.target, signal });
    },
  });
  const enrolled = await runPreparedTask(task);
  await configureNativeBoot(binaryPath);
  return enrolled;
}
