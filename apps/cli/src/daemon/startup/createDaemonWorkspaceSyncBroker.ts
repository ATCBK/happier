import { join } from 'node:path';

import { createHappierTempDir, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';

import type { WorkspaceSyncSidecarBroker } from '@/workspaces/sync/workspaceSyncSidecarLifecycle';
import {
  listenWorkspaceSyncBroker,
  type WorkspaceSyncBrokerConfig,
} from '@/workspaces/sync/transport/workspaceSyncBroker';
import {
  BrokerProtocolError,
  type MutagenControlCommandV1,
} from '@/workspaces/sync/transport/workspaceSyncBrokerProtocol';
import type { WorkspaceSyncPeerIdentityValidator } from '@/workspaces/sync/transport/workspaceSyncPeerIdentity';

type BrokerHandle = Readonly<{
  socketPath: string;
  brokerInstanceId: string;
  launchNonce: string;
  authenticatedSidecarPid: number | undefined;
  whenReady: Promise<void>;
  command(
    command: MutagenControlCommandV1,
    options?: Readonly<{ signal?: AbortSignal; operationId?: string }>,
  ): Promise<unknown>;
  close(): Promise<void>;
}>;

export type ListenDaemonWorkspaceSyncBroker = (
  config: WorkspaceSyncBrokerConfig,
) => Promise<BrokerHandle>;

export type CreateDaemonWorkspaceSyncBrokerInput = Readonly<{
  brokerDir: string;
  brokerInstanceId: string;
  launchNonce: string;
  launchSecret: Uint8Array;
  openExternalStream: WorkspaceSyncBrokerConfig['openExternalStream'];
  peerIdentityValidator: WorkspaceSyncPeerIdentityValidator;
  listenBroker?: ListenDaemonWorkspaceSyncBroker;
}>;

/**
 * Production adapter between the strict OS broker and the managed sidecar
 * lifecycle. The only serialized launch credential is returned as bytes for
 * inherited descriptor 3; it is never written to argv, env, or disk.
 */
export async function createDaemonWorkspaceSyncBroker(
  input: CreateDaemonWorkspaceSyncBrokerInput,
): Promise<WorkspaceSyncSidecarBroker> {
  const listen = input.listenBroker ?? listenWorkspaceSyncBroker;
  // AF_UNIX paths are bounded by sockaddr_un (104 bytes on macOS). The
  // CLI-home and TMPDIR are unbounded; reuse the private temp owner under the
  // short native parent, as both control and data sockets share this directory.
  const runtimeDirectory = process.platform === 'win32'
    ? undefined
    : createHappierTempDir({ purpose: 'wsb', root: '/tmp' });
  const cleanupAfter = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      try {
        if (runtimeDirectory) await removeHappierTempDirAsync(runtimeDirectory);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'workspace sync broker runtime cleanup failed');
      }
      throw error;
    }
    if (runtimeDirectory) await removeHappierTempDirAsync(runtimeDirectory);
  };
  let broker: BrokerHandle;
  try {
    broker = await listen({
      // Every daemon launch owns a fresh endpoint. A path left by another
      // process is never unlinked merely because this launch wants to bind.
      socketPath: runtimeDirectory
        ? join(runtimeDirectory, 'b.sock')
        : join(input.brokerDir, `control-${input.brokerInstanceId}.sock`),
      brokerInstanceId: input.brokerInstanceId,
      launchNonce: input.launchNonce,
      launchSecret: input.launchSecret,
      openExternalStream: input.openExternalStream,
      validatePeerIdentity: input.peerIdentityValidator.validate,
    });
  } catch (error) {
    await cleanupAfter(async () => { throw error; });
    throw error;
  }
  const close = () => cleanupAfter(async () => await broker.close());
  const bootstrapDescriptor = Buffer.from(JSON.stringify({
    protocol: 1,
    brokerEndpoint: broker.socketPath,
    brokerInstanceId: broker.brokerInstanceId,
    launchNonce: broker.launchNonce,
    secret: Buffer.from(input.launchSecret).toString('base64url'),
  }), 'utf8');

  return {
    bootstrapDescriptor,
    setExpectedSidecarPid: (pid) => input.peerIdentityValidator.setExpectedSidecarPid(pid),
    waitForReady: async (pid) => {
      if (!Number.isSafeInteger(pid) || pid < 1) {
        await close();
        throw new BrokerProtocolError('unauthorized', 'invalid workspace sync sidecar pid');
      }
      await broker.whenReady;
      if (broker.authenticatedSidecarPid !== pid) {
        await close();
        throw new BrokerProtocolError('unauthorized', 'workspace sync sidecar pid did not match the spawned process');
      }
    },
    command: async (command, signal, operationId) => await broker.command(
      command,
      signal || operationId ? { ...(signal ? { signal } : {}), ...(operationId ? { operationId } : {}) } : undefined,
    ),
    close,
  };
}
