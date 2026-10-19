import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ComposerContentHandleV1Schema, ComposerContentClaimResponseV1Schema } from '@happier-dev/protocol/runtime/input/composerContentV1';

import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';
import { createComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';

type Handler = (data: unknown) => Promise<unknown>;

const executionTarget = { serverId: 'server-current', machineId: 'machine-current' } as const;
const owner = { pluginId: 'com.example.media', localId: 'composer' } as const;
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlW6UYAAAAASUVORK5CYII=',
  'base64',
);

function createRpcHandlerManager(): Readonly<{
  handlers: Map<string, Handler>;
  registerHandler: (method: string, handler: Handler) => void;
}> {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler: (method, handler) => {
      handlers.set(method, handler);
    },
  };
}

describe('Composer media stage claim handler', () => {
  const temporaryDirectories: string[] = [];
  const registrations: Array<ReturnType<typeof registerFileSystemHandlers>> = [];

  afterEach(async () => {
    await Promise.all(registrations.splice(0).map(async (registration) => await registration.dispose()));
    await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }));
  });

  it('captures and rejoins one exact submission snapshot after releasing its source draft', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'happier-composer-media-submission-claim-'));
    temporaryDirectories.push(rootDirectory);
    const sourcePath = join(rootDirectory, 'incoming.png');
    await writeFile(sourcePath, pngBytes);
    const stagesDirectory = join(rootDirectory, 'stages');
    const store = createComposerMediaStageStore({ rootDirectory: stagesDirectory, executionTarget });
    const finalized = await store.finalizeUpload({ tempPath: sourcePath, sizeBytes: pngBytes.byteLength,
      sha256: createHash('sha256').update(pngBytes).digest('hex'), executionTarget, owner,
      mediaKind: 'image', mimeType: 'image/png', name: 'captured.png' });
    if (!finalized.success) throw new Error(finalized.error);
    const manager = createRpcHandlerManager();
    registrations.push(registerFileSystemHandlers(manager as unknown as RpcHandlerManager, rootDirectory, {
      composerMediaStage: { executionTarget, store },
    }));
    const claim = manager.handlers.get(RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CLAIM);
    if (!claim) throw new Error('expected Composer media claim handler');
    const claimant = { composer: { kind: 'session', sessionId: 'source-session' }, attachmentInstanceId: 'attachment-a' } as const;
    const submission = { destinationComposerRef: { kind: 'session', sessionId: 'destination-session' }, messageLocalId: 'ask-1' } as const;
    await expect(claim({ handle: finalized.handle, claimant })).resolves.toMatchObject({ success: true });
    const captured = ComposerContentClaimResponseV1Schema.parse(await claim({ handle: finalized.handle, claimant, submission }));
    expect(captured).toMatchObject({ success: true, newlyAcquired: true, handle: expect.any(Object) });
    if (!captured.success) throw new Error(captured.error);
    const handle = ComposerContentHandleV1Schema.parse(captured.handle);
    expect(handle.id).not.toBe(finalized.handle.id);
    await expect(store.inspectForFinalization({ handle: finalized.handle, executionTarget, owner, claimant }))
      .resolves.toMatchObject({ status: 'ready' });
    await expect(store.release({ handle: finalized.handle, executionTarget, owner, claimant })).resolves.toEqual({ status: 'released' });
    const restartedStore = createComposerMediaStageStore({ rootDirectory: stagesDirectory, executionTarget });
    const restartedManager = createRpcHandlerManager();
    registrations.push(registerFileSystemHandlers(restartedManager as unknown as RpcHandlerManager, rootDirectory, {
      composerMediaStage: { executionTarget, store: restartedStore },
    }));
    const rejoin = restartedManager.handlers.get(RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CLAIM);
    if (!rejoin) throw new Error('expected restarted Composer media claim handler');
    await expect(rejoin({ handle: finalized.handle, claimant, submission }))
      .resolves.toEqual({ success: true, newlyAcquired: false, handle });
    await expect(restartedStore.inspectForFinalization({ handle, executionTarget, owner,
      claimant: { ...claimant, composer: submission.destinationComposerRef } })).resolves.toMatchObject({ status: 'ready' });
    for (const forged of [
      { handle: finalized.handle, claimant: { ...claimant, attachmentInstanceId: 'other-attachment' }, submission },
      { handle: finalized.handle, claimant, submission: { ...submission, destinationComposerRef: claimant.composer } },
      { handle: { ...finalized.handle, sha256: '0'.repeat(64) }, claimant, submission },
      { handle: { ...finalized.handle, executionTarget: { ...executionTarget, machineId: 'foreign-machine' } }, claimant, submission },
    ]) {
      await expect(rejoin(forged)).resolves.toMatchObject({ success: false });
    }
  });

  it('claims an unclaimed stage for one exact attachment and refuses a second claimant over the wire', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'happier-composer-media-claim-'));
    temporaryDirectories.push(rootDirectory);
    const sourcePath = join(rootDirectory, 'incoming.png');
    await writeFile(sourcePath, pngBytes);
    const store = createComposerMediaStageStore({
      rootDirectory: join(rootDirectory, 'stages'),
      executionTarget,
    });
    const finalized = await store.finalizeUpload({
      tempPath: sourcePath,
      sizeBytes: pngBytes.byteLength,
      sha256: createHash('sha256').update(pngBytes).digest('hex'),
      executionTarget,
      owner,
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'attached.png',
    });
    expect(finalized.success).toBe(true);
    if (!finalized.success) throw new Error(finalized.error);

    const manager = createRpcHandlerManager();
    registrations.push(registerFileSystemHandlers(manager as unknown as RpcHandlerManager, rootDirectory, {
      composerMediaStage: { executionTarget, store },
    }));
    const claim = manager.handlers.get(RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CLAIM);
    if (!claim) throw new Error('expected Composer media claim handler');

    const firstClaimant = {
      composer: { kind: 'session' as const, sessionId: 'session-a' },
      attachmentInstanceId: 'attachment-a',
    };
    const secondClaimant = {
      composer: { kind: 'session' as const, sessionId: 'session-b' },
      attachmentInstanceId: 'attachment-b',
    };

    await expect(claim({ handle: finalized.handle, claimant: firstClaimant }))
      .resolves.toEqual({ success: true, newlyAcquired: true });
    // Same claimant re-claims idempotently (restart/rejoin).
    await expect(claim({ handle: finalized.handle, claimant: firstClaimant }))
      .resolves.toEqual({ success: true, newlyAcquired: false });
    // Another document/attachment resolves the typed custody conflict.
    await expect(claim({ handle: finalized.handle, claimant: secondClaimant }))
      .resolves.toEqual({
        success: false,
        error: 'Composer media stage is claimed elsewhere',
        claimedElsewhere: true,
      });
    // A claim request without its exact attachment claimant is invalid.
    await expect(claim({ handle: finalized.handle }))
      .resolves.toEqual({ success: false, error: 'Invalid Composer media claim request' });

    await expect(store.release({
      handle: finalized.handle,
      executionTarget,
      owner,
      claimant: firstClaimant,
    })).resolves.toEqual({ status: 'released' });
  });
});
