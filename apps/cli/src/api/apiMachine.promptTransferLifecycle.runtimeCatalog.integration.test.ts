import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Machine } from '@/api/types';
import { createTransferRecipientKeyPair } from '@happier-dev/transfers/node';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { accountSettingsParse } from '@happier-dev/protocol';
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

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
  it('disposes abandoned prompt asset upload and download resources on shutdown', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-machine-prompt-assets-home-'));
    const client = new ApiMachineClient('token', createMachine());

    try {
      await mkdir(join(homeDir, '.agents', 'skills', 'reviewer'), { recursive: true });
      await writeFile(join(homeDir, '.agents', 'skills', 'reviewer', 'SKILL.md'), '# Reviewer\n', 'utf8');

      client.setRPCHandlers({
        spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
        stopSession: async () => true,
        requestShutdown: () => {},
      }, {
        promptAssetsHomedir: () => homeDir,
      });

      const lifecycle = getMachineRpcLifecycleRegistration(client);
      expect(lifecycle).toBeTruthy();
      const store = lifecycle.promptAssetTransfers.transferSessionStore;
      const rpc = (client as any).rpcHandlerManager as RpcInvoker;

      const upload = await rpc.invokeLocal(RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT, { sizeBytes: 4 });
      expect(upload).toMatchObject({ success: true, uploadId: expect.any(String) });
      const uploadSession = store.getUploadSession(upload.uploadId);
      expect(uploadSession).toBeTruthy();
      const uploadTempPath = uploadSession.tempPath;
      await expect(access(uploadTempPath)).resolves.toBeUndefined();

      const recipient = createTransferRecipientKeyPair();
      const download = await rpc.invokeLocal(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT, {
        assetTypeId: 'agents.skill',
        scope: 'user',
        externalRef: { skillName: 'reviewer' },
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      });
      expect(download).toMatchObject({ success: true, downloadId: expect.any(String) });
      const downloadSession = store.getDownloadSession(download.downloadId);
      expect(downloadSession).toBeTruthy();
      const downloadTempPath = downloadSession.filePath;
      await expect(access(downloadTempPath)).resolves.toBeUndefined();

      await client.shutdown();
      await client.shutdown();

      expect(store.getUploadSession(upload.uploadId)).toBeNull();
      expect(store.getDownloadSession(download.downloadId)).toBeNull();
      await expectPathMissing(uploadTempPath);
      await expectPathMissing(downloadTempPath);
      await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT, { sizeBytes: 1 }))
        .rejects.toThrow('Transfer session store is disposed');
    } finally {
      await client.shutdown().catch(() => undefined);
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
        spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
        stopSession: async () => true,
        requestShutdown: () => {},
      }, {
        promptAssetsHappierHomeDir: () => happierHomeDir,
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
      setActiveAccountSettingsSnapshot(null);
      await rm(happierHomeDir, { recursive: true, force: true });
    }
  });

  it('waits for active local prompt transfer RPC handlers before disposing lifecycle stores', async () => {
    const client = new ApiMachineClient('token', createMachine());
    const handlerStarted = createDeferredVoid();
    const releaseHandler = createDeferredVoid();

    try {
      client.setRPCHandlers({
        spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
        stopSession: async () => true,
        requestShutdown: () => {},
      });

      const lifecycle = getMachineRpcLifecycleRegistration(client);
      expect(lifecycle).toBeTruthy();
      const store = lifecycle.promptAssetTransfers.transferSessionStore;
      const rpc = client.getPeerMediationMachineRpcHandlerManager();
      const upload = await rpc.invokeLocal(RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT, { sizeBytes: 4 });
      expect(upload).toMatchObject({ success: true, uploadId: expect.any(String) });
      if (!upload || typeof upload !== 'object' || !('uploadId' in upload) || typeof upload.uploadId !== 'string') {
        throw new Error('Prompt asset upload did not return its transfer identity');
      }
      const uploadSession = store.getUploadSession(upload.uploadId);
      expect(uploadSession).toBeTruthy();

      (client as any).rpcHandlerManager.registerHandler(
        RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT,
        async () => {
          handlerStarted.resolve();
          await releaseHandler.promise;
          return { success: true, uploadId: 'slow-local-upload' };
        },
      );

      const invokePromise = rpc.invokeLocal(RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT, {});
      await handlerStarted.promise;

      const shutdownPromise = client.shutdown();
      await Promise.resolve();
      await Promise.resolve();

      expect(store.getUploadSession(upload.uploadId)).toBe(uploadSession);
      await expect(access(uploadSession.tempPath)).resolves.toBeUndefined();

      releaseHandler.resolve();
      await invokePromise;
      await shutdownPromise;

      expect(store.getUploadSession(upload.uploadId)).toBeNull();
      await expectPathMissing(uploadSession.tempPath);
    } finally {
      releaseHandler.resolve();
      await client.shutdown().catch(() => undefined);
    }
  });
});
