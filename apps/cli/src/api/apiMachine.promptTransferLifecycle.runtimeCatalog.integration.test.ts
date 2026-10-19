import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
const { fixtureHome } = vi.hoisted(() => ({ fixtureHome: vi.fn<() => string | undefined>() }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fixtureHome() ?? actual.homedir() };
});

import type { Machine } from '@/api/types';
import { createTransferRecipientKeyPair } from '@happier-dev/transfers/node';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { accountSettingsParse } from '@happier-dev/protocol';
import { clearActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

import { ApiMachineClient } from './apiMachine';

type RpcInvoker = Readonly<{
  invokeLocal: (method: string, params: unknown) => Promise<any>;
}>;

function createMachine(): Machine {
  return {
    id: 'machine-test',
    encryptionKey: new Uint8Array(32).fill(7),
    encryptionVariant: 'legacy',
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
  };
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Happier Bot',
      GIT_AUTHOR_EMAIL: 'bot@example.com',
      GIT_COMMITTER_NAME: 'Happier Bot',
      GIT_COMMITTER_EMAIL: 'bot@example.com',
    },
  });
}

async function expectPathMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function getMachineRpcLifecycleRegistration(client: ApiMachineClient): any {
  const registrations = (client as any).rpcLifecycleRegistrations as readonly unknown[] | undefined;
  return registrations?.find((registration: any) => (
    registration?.promptAssetTransfers || registration?.registryTransfers
  ));
}

describe('ApiMachineClient prompt transfer lifecycle', () => {
  it('disposes abandoned scanner-backed Found download resources on shutdown', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-machine-found-home-'));
    fixtureHome.mockReturnValue(homeDir);
    const client = new ApiMachineClient('token', createMachine());
    try {
      await mkdir(join(homeDir, '.agents', 'skills', 'reviewer'), { recursive: true });
      await writeFile(join(homeDir, '.agents', 'skills', 'reviewer', 'SKILL.md'), '---\nname: reviewer\n---\n# Reviewer\n', 'utf8');
      client.setRPCHandlers({
        spawnSession: async () => ({ type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: 'Unavailable fixture Agent' }),
        stopSession: async () => true, requestShutdown: () => {},
      });
      const lifecycle = getMachineRpcLifecycleRegistration(client);
      expect(lifecycle).toBeTruthy();
      const store = lifecycle.promptAssetTransfers.downloadStore;
      const rpc = (client as unknown as { rpcHandlerManager: RpcInvoker }).rpcHandlerManager;
      const recipient = createTransferRecipientKeyPair();
      const download = await rpc.invokeLocal(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT, {
        path: join(homeDir, '.agents', 'skills', 'reviewer'),
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      });
      expect(download).toMatchObject({ success: true, downloadId: expect.any(String) });
      const session = store.getDownloadSession(download.downloadId);
      expect(session).toBeTruthy();
      await expect(access(session.filePath)).resolves.toBeUndefined();
      await client.shutdown();
      await client.shutdown();
      expect(store.getDownloadSession(download.downloadId)).toBeNull();
      await expectPathMissing(session.filePath);
    } finally {
      await client.shutdown().catch(() => undefined);
      fixtureHome.mockReset();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('disposes abandoned prompt registry download resources on shutdown', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'happier-machine-prompt-registry-repo-'));
    const happierHomeDir = await mkdtemp(join(tmpdir(), 'happier-machine-prompt-registry-home-'));
    const client = new ApiMachineClient('token', createMachine());

    try {
      await mkdir(join(repo, 'reviewer'), { recursive: true });
      await writeFile(join(repo, 'reviewer', 'SKILL.md'), '# Reviewer\n', 'utf8');
      git(repo, ['init', '-b', 'main']);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-m', 'init']);

      client.setRPCHandlers({
        spawnSession: async () => ({ type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: 'not implemented' }),
        stopSession: async () => true,
        requestShutdown: () => {},
      }, {
      });

      const lifecycle = getMachineRpcLifecycleRegistration(client);
      expect(lifecycle).toBeTruthy();
      const store = lifecycle.registryTransfers.transferSessionStore;
      const rpc = (client as any).rpcHandlerManager as RpcInvoker;
      setActiveAccountSettingsSnapshot({source:'network',settings:accountSettingsParse({}),settingsVersion:1,loadedAtMs:1,settingsSecretsReadKeys:[],
        promptLibraryCatalog:{status:'ready',rows:[{revision:1,record:{key:'registry-sources',value:{v:2,disabledSourceIds:[],sources:[
          {id:'local-skills',title:'Local skills',format:'git',kinds:['skill'],url:repo,enabled:true,addedAt:0},
        ]}}}],diagnostics:[],tombstones:[]}});
      const scan = await rpc.invokeLocal(RPC_METHODS.DAEMON_REGISTRIES_FETCH, {
        op:'list',kind:'skill',sourceId: 'local-skills',
      });
      expect(scan).toMatchObject({ op:'list',page:{items: [expect.objectContaining({ itemId: expect.any(String) })]} });
      const recipient = createTransferRecipientKeyPair();
      const download = await rpc.invokeLocal(RPC_METHODS.DAEMON_REGISTRIES_DOWNLOAD_INIT, {
        kind:'skill',sourceId: 'local-skills',
        itemId: scan.page.items[0].itemId,version:scan.page.items[0].version,
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      });
      expect(download).toMatchObject({ success: true, downloadId: expect.any(String) });
      const downloadSession = store.getDownloadSession(download.downloadId);
      expect(downloadSession).toBeTruthy();
      const downloadTempPath = downloadSession.filePath;
      await expect(access(downloadTempPath)).resolves.toBeUndefined();

      await client.shutdown();
      await client.shutdown();

      expect(store.getDownloadSession(download.downloadId)).toBeNull();
      await expectPathMissing(downloadTempPath);
    } finally {
      await client.shutdown().catch(() => undefined);
      await rm(repo, { recursive: true, force: true });
      clearActiveAccountSettingsSnapshot();
      await rm(happierHomeDir, { recursive: true, force: true });
    }
  });

  it('waits for active local prompt transfer RPC handlers before disposing lifecycle stores', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-machine-active-found-home-'));
    fixtureHome.mockReturnValue(homeDir);
    const client = new ApiMachineClient('token', createMachine());
    const handlerStarted = createDeferredVoid();
    const releaseHandler = createDeferredVoid();

    try {
      await mkdir(join(homeDir, '.agents', 'skills', 'reviewer'), { recursive: true });
      await writeFile(join(homeDir, '.agents', 'skills', 'reviewer', 'SKILL.md'), '---\nname: reviewer\n---\n# Reviewer\n', 'utf8');
      client.setRPCHandlers({
        spawnSession: async () => ({ type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: 'not implemented' }),
        stopSession: async () => true,
        requestShutdown: () => {},
      });

      const lifecycle = getMachineRpcLifecycleRegistration(client);
      expect(lifecycle).toBeTruthy();
      const store = lifecycle.promptAssetTransfers.downloadStore;
      const handlerManager = (client as unknown as { rpcHandlerManager: RpcHandlerManager }).rpcHandlerManager;
      const rpc = handlerManager;
      const recipient = createTransferRecipientKeyPair();
      const download = await rpc.invokeLocal(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT, {
        path: join(homeDir, '.agents', 'skills', 'reviewer'),
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      });
      expect(download).toMatchObject({ success: true, downloadId: expect.any(String) });
      if (!download || typeof download !== 'object' || !('downloadId' in download) || typeof download.downloadId !== 'string') {
        throw new Error('Found download did not return its transfer identity');
      }
      const downloadSession = store.getDownloadSession(download.downloadId);
      expect(downloadSession).toBeTruthy();

      handlerManager.registerHandler(
        RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK,
        async () => {
          handlerStarted.resolve();
          await releaseHandler.promise;
          return { success: true, downloadId: download.downloadId };
        },
      );

      const invokePromise = rpc.invokeLocal(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK, { downloadId: download.downloadId });
      await handlerStarted.promise;

      const shutdownPromise = client.shutdown();
      await Promise.resolve();
      await Promise.resolve();

      expect(store.getDownloadSession(download.downloadId)).toBe(downloadSession);
      await expect(access(downloadSession.filePath)).resolves.toBeUndefined();

      releaseHandler.resolve();
      await invokePromise;
      await shutdownPromise;

      expect(store.getDownloadSession(download.downloadId)).toBeNull();
      await expectPathMissing(downloadSession.filePath);
    } finally {
      releaseHandler.resolve();
      await client.shutdown().catch(() => undefined);
      fixtureHome.mockReset();
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
