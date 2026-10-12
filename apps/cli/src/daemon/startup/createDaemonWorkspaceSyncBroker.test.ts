import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { getHappierTempDirOwnerPath } from '@happier-dev/cli-common/tempDirs';
import { createWorkspaceSyncBrokerEndpoint, listenWorkspaceSyncBroker, type WorkspaceSyncBrokerConfig } from '@/workspaces/sync/transport/workspaceSyncBroker';
import { WorkspaceSyncBrokerClient } from '@/workspaces/sync/transport/workspaceSyncBrokerClient.testkit';
import { deriveWorkspaceSyncEndpointId } from '@/workspaces/sync/transport/workspaceSyncBrokerProtocol';

import { createDaemonWorkspaceSyncBroker } from './createDaemonWorkspaceSyncBroker';

function fixture(sidecarPid = 42) {
  const command = vi.fn(async () => ({ ok: true }));
  const close = vi.fn(async () => undefined);
  const broker = {
    socketPath: '/private/broker/control-broker-instance.sock',
    brokerInstanceId: 'broker-instance',
    launchNonce: 'launch-nonce',
    authenticatedSidecarPid: sidecarPid,
    whenReady: Promise.resolve(),
    command,
    close,
  };
  const listenBroker = vi.fn(async (config: WorkspaceSyncBrokerConfig) => {
    broker.socketPath = config.socketPath;
    return broker;
  });
  return { broker, command, close, listenBroker };
}

describe('createDaemonWorkspaceSyncBroker', () => {
  it.skipIf(process.platform === 'win32')('removes the owned runtime directory and marker when listener hardening fails', async () => {
    let directory: string | undefined;
    await expect(createDaemonWorkspaceSyncBroker({
      brokerDir: '/unused-cli-home/broker',
      brokerInstanceId: 'broker-instance',
      launchNonce: 'launch-nonce',
      launchSecret: new Uint8Array(32).fill(7),
      openExternalStream: async () => new PassThrough(),
      peerIdentityValidator: { setExpectedSidecarPid: () => {}, validate: async () => true },
      listenBroker: async (config) => {
        directory = dirname(config.socketPath);
        return await listenWorkspaceSyncBroker({
          ...config,
          // ACL hardening is an OS boundary; keep real bind and rollback.
          createEndpoint: (endpointPath) => ({
            ...createWorkspaceSyncBrokerEndpoint({ endpointPath }),
            secure: async () => { throw new Error('ACL denied'); },
          }),
        });
      },
    })).rejects.toThrow('ACL denied');
    expect(directory).toBeDefined();
    await expect(stat(directory!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(getHappierTempDirOwnerPath(directory!))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('serves control and data sockets with long CLI-home and TMPDIR paths, then removes its private runtime directory', async () => {
    const root = await mkdtemp('/tmp/wsb-test-');
    const brokerDir = join(root, 'long-cli-home-'.repeat(12), 'daemon', 'workspace-sync', 'mutagen', 'broker');
    const longTmpDir = join(root, 'long-temporary-directory-'.repeat(8));
    await mkdir(longTmpDir, { recursive: true });
    vi.stubEnv('TMPDIR', longTmpDir);
    let result: Awaited<ReturnType<typeof createDaemonWorkspaceSyncBroker>> | undefined;
    let client: WorkspaceSyncBrokerClient | undefined;
    try {
      result = await createDaemonWorkspaceSyncBroker({
        brokerDir,
        brokerInstanceId: '550e8400-e29b-41d4-a716-446655440000',
        launchNonce: 'launch-nonce',
        launchSecret: new Uint8Array(32).fill(7),
        openExternalStream: async () => new PassThrough(),
        peerIdentityValidator: { setExpectedSidecarPid: () => {}, validate: async () => true },
      });
      const descriptor = JSON.parse(Buffer.from(result.bootstrapDescriptor).toString('utf8'));
      const endpointPath: string = descriptor.brokerEndpoint;
      const directory = dirname(endpointPath);
      // macOS's sockaddr_un has 104 bytes including the terminating NUL.
      expect(Buffer.byteLength(endpointPath)).toBeLessThan(104);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(endpointPath)).mode & 0o777).toBe(0o600);
      client = new WorkspaceSyncBrokerClient({
        endpointPath,
        brokerInstanceId: descriptor.brokerInstanceId,
        launchNonce: descriptor.launchNonce,
        launchSecret: Buffer.from(descriptor.secret, 'base64url'),
        sidecarPid: process.pid,
      });
      await client.connectControl();
      await result.waitForReady(process.pid);
      const stream = await client.openStream(deriveWorkspaceSyncEndpointId('long-home', 'alpha'));
      await stream.close();
      await client.close();
      await result.close();
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(getHappierTempDirOwnerPath(directory))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(result.close()).resolves.toBeUndefined();
    } finally {
      await client?.close();
      await result?.close();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates the private broker and encodes the complete bootstrap descriptor only in inherited bytes', async () => {
    const harness = fixture();
    const launchSecret = new Uint8Array(32).fill(0xfb);
    const openExternalStream = vi.fn(async () => new PassThrough());
    const peerIdentityValidator = {
      setExpectedSidecarPid: vi.fn(),
      validate: vi.fn(async () => true),
    };

    const result = await createDaemonWorkspaceSyncBroker({
      brokerDir: '/private/broker',
      brokerInstanceId: 'broker-instance',
      launchNonce: 'launch-nonce',
      launchSecret,
      openExternalStream,
      peerIdentityValidator,
      listenBroker: harness.listenBroker,
    });

    expect(harness.listenBroker).toHaveBeenCalledWith({
      socketPath: expect.any(String),
      brokerInstanceId: 'broker-instance',
      launchNonce: 'launch-nonce',
      launchSecret,
      openExternalStream,
      validatePeerIdentity: peerIdentityValidator.validate,
    });
    expect(JSON.parse(Buffer.from(result.bootstrapDescriptor).toString('utf8'))).toEqual({
      protocol: 1,
      brokerEndpoint: harness.broker.socketPath,
      brokerInstanceId: 'broker-instance',
      launchNonce: 'launch-nonce',
      secret: Buffer.from(launchSecret).toString('base64url'),
    });
    await result.close();
  });

  it('binds readiness to the spawned sidecar pid and forwards commands with cancellation', async () => {
    const harness = fixture(42);
    const result = await createDaemonWorkspaceSyncBroker({
      brokerDir: '/private/broker',
      brokerInstanceId: 'broker-instance',
      launchNonce: 'launch-nonce',
      launchSecret: new Uint8Array(32).fill(7),
      openExternalStream: async () => new PassThrough(),
      peerIdentityValidator: { setExpectedSidecarPid: vi.fn(), validate: async () => true },
      listenBroker: harness.listenBroker,
    });
    const abort = new AbortController();

    result.setExpectedSidecarPid?.(42);
    await expect(result.waitForReady(42)).resolves.toBeUndefined();
    await expect(result.command({ t: 'list', requestId: 'request-1', limit: 100 }, abort.signal)).resolves.toEqual({ ok: true });
    expect(harness.command).toHaveBeenCalledWith(
      { t: 'list', requestId: 'request-1', limit: 100 },
      { signal: abort.signal },
    );
    await result.close();
  });

  it('fails closed and closes the broker when the authenticated pid differs from the spawned sidecar', async () => {
    const harness = fixture(99);
    const result = await createDaemonWorkspaceSyncBroker({
      brokerDir: '/private/broker',
      brokerInstanceId: 'broker-instance',
      launchNonce: 'launch-nonce',
      launchSecret: new Uint8Array(32).fill(7),
      openExternalStream: async () => new PassThrough(),
      peerIdentityValidator: { setExpectedSidecarPid: vi.fn(), validate: async () => true },
      listenBroker: harness.listenBroker,
    });

    await expect(result.waitForReady(42)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(harness.close).toHaveBeenCalledTimes(1);
    if (process.platform !== 'win32') {
      const directory = dirname(harness.broker.socketPath);
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(getHappierTempDirOwnerPath(directory))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
