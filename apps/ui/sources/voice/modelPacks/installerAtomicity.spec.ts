import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  checkModelPackUpdateAvailable,
  ensureModelPackInstalled,
  getModelPackInstallSummary,
  removeModelPack,
} from '@/voice/modelPacks/installer.native';
import { createMemFs, createMemNativeDownload } from '@/voice/modelPacks/installerTestFs';
import { createExpoModelPackInstallerHost, reconcileExpoModelPackPromotion } from '@/voice/modelPacks/installer/host.native';
import { deriveModelPackStagingPlan } from '@happier-dev/voice-modelpacks';
import type { ModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

describe('modelPacks installer (native) atomicity', () => {
  it('rejects a failed stale-backup deletion before writing a new promotion intent', async () => {
    const { fs, files, root } = createMemFs();
    const packId = 'stale-backup-delete';
    const live = new Uint8Array([1]);
    const stale = new Uint8Array([9]);
    const next = new Uint8Array([2]);
    files.set(`${root}/${packId}/model.bin`, live);
    files.set(`${root}/.${packId}.backup/model.bin`, stale);
    const backupError = new Error('EACCES_stale_backup_delete');
    const BaseDirectory = fs.Directory;
    class BackupDirectory extends BaseDirectory {
      constructor(...args: unknown[]) {
        super(...args);
        const deleteDirectory = this.delete?.bind(this);
        this.delete = () => {
          if (this.uri === `${root}/.${packId}.backup`) throw backupError;
          deleteDirectory?.();
        };
      }
    }
    const host = createExpoModelPackInstallerHost({ fs: { ...fs, Directory: BackupDirectory }, invalidatePackRuntime: async () => {} });
    const manifest = { packId, kind: 'tts_sherpa', model: 'kokoro', version: 'v2',
      files: [{ path: 'model.bin', url: 'https://example.com/model.bin', sha256: sha256Hex(next), sizeBytes: 1 }] } satisfies ModelPackManifest;
    const staging = await host.beginStaging(packId, deriveModelPackStagingPlan(manifest));
    try {
      await staging.appendDownloadedChunk('model.bin', next);
      await staging.writeManifest(manifest);
      await expect(staging.promote({ scopeKey: 'fixture', identityKey: packId })).rejects.toBe(backupError);
      expect(files.get(`${root}/${packId}/model.bin`)).toEqual(live);
      expect(files.get(`${root}/.${packId}.backup/model.bin`)).toEqual(stale);
      expect(files.has(`${root}/.${packId}.promote-intent`)).toBe(false);
    } finally { await staging.cleanup(); }
  });

  it.each(['first install', 'update'] as const)('rejects failed commit intent deletion during %s and retains recoverable prior state', async (mode) => {
    const { fs, files, root } = createMemFs();
    const packId = 'intent-delete';
    const before = new Uint8Array([1]);
    const after = new Uint8Array([2]);
    const prior = { packId, kind: 'tts_sherpa', model: 'kokoro', version: 'v1',
      files: [{ path: 'model.bin', url: 'https://example.com/v1/model.bin', sha256: sha256Hex(before), sizeBytes: 1 }] };
    if (mode === 'update') {
      files.set(`${root}/${packId}/model.bin`, before);
      files.set(`${root}/${packId}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest: prior })));
    }
    const remote = { ...prior, version: 'v2', files: [{ path: 'model.bin', url: 'https://example.com/v2/model.bin', sha256: sha256Hex(after), sizeBytes: 1 }] };
    const deleteError = new Error('EACCES_intent_delete');
    let failDelete = true;
    const BaseFile = fs.File;
    class IntentFile extends BaseFile {
      override delete() {
        if (failDelete && this.uri.endsWith('.promote-intent')) throw deleteError;
        super.delete();
      }
    }
    const boundary = { ...fs, File: IntentFile };
    const fetchImpl: typeof fetch = async (input) => String(input).includes('manifest.json')
      ? Response.json(remote) : new Response(after);
    await expect(ensureModelPackInstalled({ packId, mode: 'download_if_missing', updatePolicy: 'manual_update_if_available',
      manifestUrl: 'https://example.com/manifest.json', timeoutMs: null, signal: new AbortController().signal },
      { fs: boundary, fetch: fetchImpl, download: createMemNativeDownload(boundary, fetchImpl), invalidatePackRuntime: async () => {} })).rejects.toBe(deleteError);

    expect(files.get(`${root}/${packId}/model.bin`)).toEqual(mode === 'update' ? before : undefined);
    expect(files.has(`${root}/.${packId}.promote-intent`)).toBe(true);
    failDelete = false;
    await reconcileExpoModelPackPromotion({ fs: boundary, packId, outcome: 'rollback', invalidatePackRuntime: async () => {} });
    const summary = await getModelPackInstallSummary({ packId }, { fs: boundary });
    expect(summary.installed).toBe(mode === 'update');
    expect(summary.manifest?.version).toBe(mode === 'update' ? 'v1' : undefined);
    expect(files.get(`${root}/${packId}/model.bin`)).toEqual(mode === 'update' ? before : undefined);
    expect(files.has(`${root}/.${packId}.promote-intent`)).toBe(false);
  });

  it('rejects a failed resume-plan removal before promotion leaves the installed pack untouched', async () => {
    const { fs, files, root } = createMemFs();
    const packId = 'resume-plan-delete';
    const before = new Uint8Array([1]);
    const after = new Uint8Array([2]);
    const prior = { packId, kind: 'tts_sherpa', model: 'kokoro', version: 'v1',
      files: [{ path: 'model.bin', url: 'https://example.com/v1/model.bin', sha256: sha256Hex(before), sizeBytes: 1 }] };
    files.set(`${root}/${packId}/model.bin`, before);
    files.set(`${root}/${packId}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest: prior })));
    const remote = { ...prior, version: 'v2', files: [{ path: 'model.bin', url: 'https://example.com/v2/model.bin', sha256: sha256Hex(after), sizeBytes: 1 }] };
    const deleteError = new Error('EACCES_resume_plan_delete');
    const BaseFile = fs.File;
    class ResumePlanFile extends BaseFile {
      override delete() {
        if (this.uri.endsWith('/.resume-plan.json')) throw deleteError;
        super.delete();
      }
    }
    const boundary = { ...fs, File: ResumePlanFile };
    const fetchImpl: typeof fetch = async (input) => String(input).includes('manifest.json')
      ? Response.json(remote) : new Response(after);
    await expect(ensureModelPackInstalled({ packId, mode: 'download_if_missing', updatePolicy: 'manual_update_if_available',
      manifestUrl: 'https://example.com/manifest.json', timeoutMs: null, signal: new AbortController().signal },
      { fs: boundary, fetch: fetchImpl, download: createMemNativeDownload(boundary, fetchImpl), invalidatePackRuntime: async () => {} })).rejects.toBe(deleteError);
    expect(files.get(`${root}/${packId}/model.bin`)).toEqual(before);
    expect((await getModelPackInstallSummary({ packId }, { fs: boundary })).manifest?.version).toBe('v1');
    expect(files.has(`${root}/.${packId}.promote-intent`)).toBe(false);
    expect(files.get(`${root}/.${packId}.scratch/model.bin`)).toEqual(after);
  });

  it('reconciles a missing-live crash topology before removing every pack artifact', async () => {
    const { fs, files } = createMemFs();
    const packId = 'remove-crash';
    const root = 'file:///docs/happier/voice/modelPacks';
    files.set(`${root}/.${packId}.backup/pack.json`, new TextEncoder().encode('{}'));
    files.set(`${root}/.${packId}.scratch/partial.bin`, new Uint8Array([1]));
    files.set(`${root}/.${packId}.promote-intent`, new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      packId,
      phase: 'swap_prepared',
      startedAtMs: 1,
      token: 'remove-crash',
      priorInstall: { scopeKey: 'device', identityKey: packId },
      recovery: null,
    })));

    await removeModelPack({ packId }, { fs });

    expect([...files.keys()].filter((path) => (
      path.startsWith(`${root}/${packId}/`)
      || path.startsWith(`${root}/.${packId}.backup/`)
      || path.startsWith(`${root}/.${packId}.scratch/`)
      || path === `${root}/.${packId}.promote-intent`
    ))).toEqual([]);
  });

  it('cancels an active install and waits for native transfer termination before removing the pack', async () => {
    const { fs, files } = createMemFs();
    const packId = 'remove-race';
    const bytes = new Uint8Array([3, 1, 4, 1]);
    const manifest = {
      packId,
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v1',
      files: [{ path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: sha256Hex(bytes), sizeBytes: bytes.length }],
    };
    let releaseDownload!: () => void;
    const downloadPaused = new Promise<void>((resolve) => { releaseDownload = resolve; });
    let markDownloadStarted!: () => void;
    const downloadStarted = new Promise<void>((resolve) => { markDownloadStarted = resolve; });
    let transferSignal: AbortSignal | null = null;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url).includes('manifest.json')) return Response.json(manifest);
      transferSignal = init?.signal ?? null;
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          markDownloadStarted();
          await downloadPaused;
          controller.enqueue(bytes);
          controller.close();
        },
      }));
    };
    const install = ensureModelPackInstalled({
      packId,
      mode: 'download_if_missing',
      updatePolicy: 'manual_update_if_available',
      manifestUrl: 'https://example.com/manifest.json',
      timeoutMs: 5000,
      signal: new AbortController().signal,
    }, { download: createMemNativeDownload(fs, fetchImpl), fs, fetch: fetchImpl });
    const installOutcome = install.catch((error: unknown) => error);
    await downloadStarted;

    let removalSettled = false;
    const removal = removeModelPack({ packId }, { fs }).then(() => { removalSettled = true; });
    await vi.waitFor(() => expect((transferSignal as AbortSignal | null)?.aborted).toBe(true));
    expect(removalSettled).toBe(false);
    releaseDownload();
    await removal;
    expect(await installOutcome).toMatchObject({ message: 'aborted' });
    expect(files.has(`file:///docs/happier/voice/modelPacks/${packId}/model.onnx`)).toBe(false);
  });

  it('releases removal ownership after cancellation or failure and remains idempotent', async () => {
    const { fs, files } = createMemFs();
    const packId = 'remove-retry';
    const liveRoot = `file:///docs/happier/voice/modelPacks/${packId}`;
    files.set(`${liveRoot}/pack.json`, new TextEncoder().encode('{}'));
    const aborted = new AbortController();
    aborted.abort();

    await expect(removeModelPack({ packId, signal: aborted.signal }, { fs }))
      .rejects.toThrow('model_pack_remove_aborted');
    expect(files.has(`${liveRoot}/pack.json`)).toBe(true);

    const OriginalDirectory = fs.Directory;
    let failOnce = true;
    class FailingDeleteDirectory extends (OriginalDirectory as any) {
      delete() {
        if (this.uri === liveRoot && failOnce) {
          failOnce = false;
          throw new Error('remove_failed');
        }
        return super.delete();
      }
    }
    (fs as any).Directory = FailingDeleteDirectory;

    await expect(removeModelPack({ packId }, { fs })).rejects.toThrow('remove_failed');
    expect(files.has(`${liveRoot}/pack.json`)).toBe(true);
    await expect(removeModelPack({ packId }, { fs })).resolves.toBeUndefined();
    await expect(removeModelPack({ packId }, { fs })).resolves.toBeUndefined();
    expect(files.has(`${liveRoot}/pack.json`)).toBe(false);
  });

  it('does not let update checks observe a metadata-committed promotion without an outcome owner', async () => {
    const { fs, files } = createMemFs();
    const packId = 'example';
    const packDir = `file:///docs/happier/voice/modelPacks/${packId}`;
    const manifest = {
      packId,
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v2',
      files: [{ path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: sha256Hex(new Uint8Array([1])), sizeBytes: 1 }],
    };
    files.set(`${packDir}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest })));
    const intentUri = 'file:///docs/happier/voice/modelPacks/.example.promote-intent';
    files.set(intentUri, new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      packId,
      phase: 'metadata_committed',
      startedAtMs: 1,
      token: 'metadata-committed',
      priorInstall: null,
      recovery: { kind: 'test', value: {} },
    })));

    await expect(checkModelPackUpdateAvailable({
      packId,
      manifestUrl: null,
      timeoutMs: 5000,
      signal: new AbortController().signal,
    }, { fs })).rejects.toThrow('model_pack_promotion_outcome_required');
    expect(files.has(intentUri)).toBe(true);
  });

  it('keeps the previously-installed pack intact when an update download fails', async () => {
    const { fs, files } = createMemFs();
    const packDir = 'file:///docs/happier/voice/modelPacks/example';

    const oldBytes = new Uint8Array([1, 2, 3, 4]);
    const oldSha = sha256Hex(oldBytes);
    const oldManifest = {
      packId: 'example',
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v1',
      files: [{ path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: oldSha, sizeBytes: oldBytes.length }],
    };

    // Seed an installed pack: live model file + meta.
    files.set(`${packDir}/model.onnx`, oldBytes);
    files.set(`${packDir}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest: oldManifest })));

    // Remote manifest v2 differs (forces refresh) but its download fails.
    const newSha = sha256Hex(new Uint8Array([9, 9, 9, 9]));
    const fetchImpl = async (url: string) => {
      if (url.includes('manifest.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            packId: 'example',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: 'v2',
            files: [{ path: 'model.onnx', url: 'https://example.com/model-v2.onnx', sha256: newSha, sizeBytes: 4 }],
          }),
        } as any;
      }
      // The new file download fails — this is the data-loss trigger.
      return { ok: false, status: 500 } as any;
    };

    await expect(
      ensureModelPackInstalled(
        {
          packId: 'example',
          mode: 'download_if_missing',
          updatePolicy: 'manual_update_if_available',
          manifestUrl: 'https://example.com/manifest.json',
          timeoutMs: 5000,
          signal: new AbortController().signal,
        },
        { download: createMemNativeDownload(fs, fetchImpl as any), fs, fetch: fetchImpl as any },
      ),
    ).rejects.toThrow();

    // DATA-LOSS GUARD: the live pack must still be present and unchanged.
    const survivingMeta = files.get(`${packDir}/pack.json`);
    expect(survivingMeta, 'live pack.json must survive a failed update').toBeDefined();
    const parsed = JSON.parse(new TextDecoder().decode(survivingMeta!));
    expect(parsed?.manifest?.version).toBe('v1');

    const survivingModel = files.get(`${packDir}/model.onnx`);
    expect(survivingModel, 'live model file must survive a failed update').toBeDefined();
    expect(Array.from(survivingModel!)).toEqual(Array.from(oldBytes));

    // No staging/backup leftovers should remain in the packs root.
    const leftovers = Array.from(files.keys()).filter(
      (k) => k.includes('.staging-') || k.includes('.backup-'),
    );
    expect(leftovers).toEqual([]);
  });

  it('atomically swaps to the new pack on a successful update', async () => {
    const { fs, files } = createMemFs();
    const packDir = 'file:///docs/happier/voice/modelPacks/example';

    const oldBytes = new Uint8Array([1, 2, 3, 4]);
    const oldSha = sha256Hex(oldBytes);
    const oldManifest = {
      packId: 'example',
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v1',
      files: [{ path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: oldSha, sizeBytes: oldBytes.length }],
    };
    files.set(`${packDir}/model.onnx`, oldBytes);
    files.set(`${packDir}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest: oldManifest })));

    const newBytes = new Uint8Array([5, 6, 7, 8]);
    const newSha = sha256Hex(newBytes);
    const fetchImpl = async (url: string) => {
      if (url.includes('manifest.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            packId: 'example',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: 'v2',
            files: [{ path: 'model.onnx', url: 'https://example.com/model-v2.onnx', sha256: newSha, sizeBytes: newBytes.length }],
          }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(newBytes.length) : null) },
        body: {
          getReader() {
            let done = false;
            return {
              async read() {
                if (done) return { done: true, value: undefined };
                done = true;
                return { done: false, value: newBytes };
              },
            };
          },
        },
      } as any;
    };

    const result = await ensureModelPackInstalled(
      {
        packId: 'example',
        mode: 'download_if_missing',
        updatePolicy: 'manual_update_if_available',
        manifestUrl: 'https://example.com/manifest.json',
        timeoutMs: 5000,
        signal: new AbortController().signal,
      },
      { download: createMemNativeDownload(fs, fetchImpl as any), fs, fetch: fetchImpl as any },
    );

    expect(result.manifest.version).toBe('v2');

    const meta = files.get(`${packDir}/pack.json`);
    expect(meta).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(meta!))?.manifest?.version).toBe('v2');

    const model = files.get(`${packDir}/model.onnx`);
    expect(model).toBeDefined();
    expect(Array.from(model!)).toEqual(Array.from(newBytes));

    // No staging/backup leftovers after a successful swap.
    const leftovers = Array.from(files.keys()).filter(
      (k) => k.includes('.staging-') || k.includes('.backup-'),
    );
    expect(leftovers).toEqual([]);
  });
  it('retires pack runtime state on both sides of live-directory mutations', async () => {
    const { fs, files } = createMemFs();
    const packId = 'runtime-invalidation';
    const liveRoot = `file:///docs/happier/voice/modelPacks/${packId}`;
    const v1 = new Uint8Array([1, 1, 1]);
    const v2 = new Uint8Array([2, 2, 2, 2]);
    const manifestFor = (version: string, bytes: Uint8Array) => ({
      packId,
      kind: 'tts_sherpa',
      model: 'kokoro',
      version,
      files: [{ path: 'model.onnx', url: `https://example.com/${version}.onnx`, sha256: sha256Hex(bytes), sizeBytes: bytes.length }],
    });
    let servedManifest = manifestFor('v1', v1);
    let servedBytes = v1;
    const fetchImpl = async (url: string) => {
      if (url.includes('manifest.json')) {
        return { ok: true, status: 200, json: async () => servedManifest } as any;
      }
      let done = false;
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(servedBytes.length) },
        body: {
          getReader: () => ({
            read: async () => {
              if (done) return { done: true, value: undefined };
              done = true;
              return { done: false, value: servedBytes };
            },
          }),
        },
      } as any;
    };

    // The invalidation owner must observe the live directory it is invalidating,
    // so record the bytes visible at the pack dir at the moment it runs. A
    // post-mutation implementation would see the successor bytes (or nothing).
    const observed: Array<{ packDirUri: string; liveBytes: string | null }> = [];
    const invalidatePackRuntime = async (packDirUri: string) => {
      const live = files.get(`${liveRoot}/model.onnx`);
      observed.push({ packDirUri, liveBytes: live ? sha256Hex(live) : null });
    };
    const overrides = { download: createMemNativeDownload(fs, fetchImpl as any), fs, fetch: fetchImpl as any, invalidatePackRuntime };

    await ensureModelPackInstalled({
      packId,
      mode: 'download_if_missing',
      manifestUrl: 'https://example.com/manifest.json',
      timeoutMs: 5000,
      signal: new AbortController().signal,
    }, overrides);
    expect(sha256Hex(files.get(`${liveRoot}/model.onnx`)!)).toBe(sha256Hex(v1));
    // First install has no predecessor, but its final retirement still closes a
    // creator that began between the pre-mutation release and promotion.
    expect(observed).toEqual([
      { packDirUri: liveRoot, liveBytes: null },
      { packDirUri: liveRoot, liveBytes: sha256Hex(v1) },
    ]);

    servedManifest = manifestFor('v2', v2);
    servedBytes = v2;
    await ensureModelPackInstalled({
      packId,
      mode: 'download_if_missing',
      updatePolicy: 'manual_update_if_available',
      manifestUrl: 'https://example.com/manifest.json',
      timeoutMs: 5000,
      signal: new AbortController().signal,
    }, overrides);

    expect(sha256Hex(files.get(`${liveRoot}/model.onnx`)!)).toBe(sha256Hex(v2));
    expect(observed).toEqual([
      { packDirUri: liveRoot, liveBytes: null },
      { packDirUri: liveRoot, liveBytes: sha256Hex(v1) },
      // The first update retirement sees the predecessor, and the final one
      // sees the promoted successor before install reports completion.
      { packDirUri: liveRoot, liveBytes: sha256Hex(v1) },
      { packDirUri: liveRoot, liveBytes: sha256Hex(v2) },
    ]);

    await removeModelPack({ packId }, overrides);

    expect(files.has(`${liveRoot}/model.onnx`)).toBe(false);
    expect(observed).toEqual([
      { packDirUri: liveRoot, liveBytes: null },
      { packDirUri: liveRoot, liveBytes: sha256Hex(v1) },
      { packDirUri: liveRoot, liveBytes: sha256Hex(v1) },
      { packDirUri: liveRoot, liveBytes: sha256Hex(v2) },
      { packDirUri: liveRoot, liveBytes: sha256Hex(v2) },
      { packDirUri: liveRoot, liveBytes: null },
    ]);
  });

  it('invalidates pack runtime state before a recovered promotion rolls the live directory back', async () => {
    const { fs, files } = createMemFs();
    const packId = 'runtime-invalidation-recovery';
    const root = 'file:///docs/happier/voice/modelPacks';
    const liveRoot = `${root}/${packId}`;
    const promoted = new Uint8Array([9, 9]);
    const prior = new Uint8Array([7]);
    // A promotion that crashed inside the swap window: the promoted bytes are
    // live and the superseded pack is still parked in the backup directory.
    files.set(`${liveRoot}/model.onnx`, promoted);
    files.set(`${root}/.${packId}.backup/model.onnx`, prior);
    files.set(`${root}/.${packId}.promote-intent`, new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      packId,
      phase: 'swap_prepared',
      startedAtMs: 1,
      token: 'recovery',
      priorInstall: { scopeKey: `filesystem:${liveRoot}`, identityKey: packId },
      recovery: null,
    })));

    const observed: Array<string | null> = [];
    const invalidatePackRuntime = async (packDirUri: string) => {
      expect(packDirUri).toBe(liveRoot);
      const live = files.get(`${liveRoot}/model.onnx`);
      observed.push(live ? sha256Hex(live) : null);
    };

    await getModelPackInstallSummary({ packId }, { fs, invalidatePackRuntime });

    // Recovery restores the prior pack at the same path. Retire both the
    // promoted predecessor and any creator that started before the restore
    // completed.
    expect(sha256Hex(files.get(`${liveRoot}/model.onnx`)!)).toBe(sha256Hex(prior));
    expect(observed).toEqual([sha256Hex(promoted), sha256Hex(prior)]);
  });

  it('retires creators admitted after pre-mutation invalidation before an update or remove completes', async () => {
    const { fs, files, root } = createMemFs();
    const packId = 'runtime-creator-race';
    const liveRoot = `${root}/${packId}`;
    const v1 = new Uint8Array([1, 2, 3]);
    const v2 = new Uint8Array([4, 5, 6]);
    const manifestFor = (version: string, bytes: Uint8Array) => ({
      packId,
      kind: 'tts_sherpa',
      model: 'kokoro',
      version,
      files: [{ path: 'model.onnx', url: `https://example.com/${version}.onnx`, sha256: sha256Hex(bytes), sizeBytes: bytes.length }],
    });

    files.set(`${liveRoot}/model.onnx`, v1);
    files.set(`${liveRoot}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest: manifestFor('v1', v1) })));

    // Boundary model for the native cache: it clears on release, but a creator
    // can finish loading the stable path after the first release and before the
    // filesystem mutation. The installer must retire it again before reporting
    // either mutation complete.
    let liveCreator: { source: 'update' | 'remove'; bytes: string } | null = null;
    const invalidationCountsAtCreator: number[] = [];
    let invalidationCount = 0;
    const invalidatePackRuntime = async () => {
      invalidationCount += 1;
      liveCreator = null;
    };

    const OriginalDirectory = fs.Directory;
    class CreatorRaceDirectory extends (OriginalDirectory as any) {
      move(destination: { uri: string }) {
        if (this.uri === liveRoot && destination.uri === `${root}/.${packId}.backup`) {
          invalidationCountsAtCreator.push(invalidationCount);
          liveCreator = { source: 'update', bytes: sha256Hex(v1) };
        }
        return super.move(destination);
      }

      delete() {
        if (this.uri === liveRoot) {
          invalidationCountsAtCreator.push(invalidationCount);
          liveCreator = { source: 'remove', bytes: sha256Hex(v2) };
        }
        return super.delete();
      }
    }
    (fs as any).Directory = CreatorRaceDirectory;

    const fetchImpl = async (url: string) => {
      if (url.includes('manifest.json')) {
        return { ok: true, status: 200, json: async () => manifestFor('v2', v2) } as any;
      }
      let done = false;
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(v2.length) },
        body: {
          getReader: () => ({
            read: async () => {
              if (done) return { done: true, value: undefined };
              done = true;
              return { done: false, value: v2 };
            },
          }),
        },
      } as any;
    };
    const overrides = { download: createMemNativeDownload(fs, fetchImpl as any), fs, fetch: fetchImpl as any, invalidatePackRuntime };

    await ensureModelPackInstalled({
      packId,
      mode: 'download_if_missing',
      updatePolicy: 'manual_update_if_available',
      manifestUrl: 'https://example.com/manifest.json',
      timeoutMs: 5000,
      signal: new AbortController().signal,
    }, overrides);

    expect(liveCreator).toBeNull();

    await removeModelPack({ packId }, overrides);

    expect(liveCreator).toBeNull();
    expect(invalidationCountsAtCreator).toEqual([1, 3]);
    expect(invalidationCount).toBe(4);
  });
});
