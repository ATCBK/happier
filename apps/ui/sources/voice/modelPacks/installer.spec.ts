import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadResumable, DownloadOptions, DownloadProgressData } from 'expo-file-system/legacy';

import { ensureModelPackInstalled, getModelPackInstallSummary, removeModelPack } from '@/voice/modelPacks/installer.native';
import type { ModelPackManifest } from '@/voice/modelPacks/manifest';
import { settleWithFakeClock, useInstallerFakeClock } from '@/voice/modelPacks/installerFakeClock.testHarness';

const nativeDownload = vi.hoisted(() => vi.fn<(
  url: string, uri: string, options?: DownloadOptions, onProgress?: (progress: DownloadProgressData) => void,
) => Pick<DownloadResumable, 'downloadAsync' | 'pauseAsync' | 'cancelAsync'>>());
// Artifact network and disk IO are native system boundaries, unavailable in the Node test process.
vi.mock('expo-file-system/legacy', () => ({
  createDownloadResumable: nativeDownload,
  FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 },
}));
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'android' });
});

const PACK_URI = 'file:///docs/happier/voice/modelPacks/example';
const MAX_BOUNDED_READ_BYTES = 4 * 1024 * 1024;

function createFs(files = new Map<string, Uint8Array>(), options: {
  onRead?: () => void;
  openHandles?: Set<object>;
} = {}) {
  const directories = new Set<string>();
  function joinUri(parts: Array<string | { uri: string }>) {
    return parts.map((part) => (typeof part === 'string' ? part : part.uri).replace(/\/$/, '')).join('/');
  }
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = joinUri(parts); }
    get exists() { return directories.has(this.uri); }
    create() { directories.add(this.uri); }
    delete() {
      directories.delete(this.uri);
      for (const key of files.keys()) if (key.startsWith(`${this.uri}/`)) files.delete(key);
    }
  }
  class File {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = joinUri(parts); }
    get exists() { return files.has(this.uri); }
    create() { if (!this.exists) files.set(this.uri, new Uint8Array()); }
    delete() {
      if (options.openHandles?.size) throw new Error('file_handle_still_open');
      files.delete(this.uri);
    }
    write(value: string | Uint8Array) {
      files.set(this.uri, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value));
    }
    async text() { return new TextDecoder().decode(files.get(this.uri)); }
    // Whole-file reads must stay unavailable: these fixtures also protect the Android heap contract.
    async bytes(): Promise<Uint8Array> { throw new Error('whole_file_read_exceeds_js_heap'); }
    // expo-file-system's File.move updates `uri` to the destination.
    move(destination: { uri: string }) {
      const data = files.get(this.uri);
      if (!data) throw new Error('move_source_missing');
      if (files.has(destination.uri)) throw new Error('move_destination_exists');
      files.delete(this.uri);
      files.set(destination.uri, data);
      this.uri = destination.uri;
    }
    open() {
      let offset = 0;
      const data = files.get(this.uri) ?? new Uint8Array();
      const handle = {};
      options.openHandles?.add(handle);
      return {
        readBytes(length: number) {
          if (length > MAX_BOUNDED_READ_BYTES) throw new Error('read_exceeds_js_heap_budget');
          const chunk = data.slice(offset, offset + length);
          offset += chunk.length;
          options.onRead?.();
          return chunk;
        },
        close() { options.openHandles?.delete(handle); },
      };
    }
  }
  return { Directory, File, Paths: { document: 'file:///docs/' }, files };
}

function useNativeDownloads(fs: ReturnType<typeof createFs>, data: (url: string) => Uint8Array, requested: string[] = [], transfer: {
  status?: (url: string) => number;
  // Bytes native reports written; error responses write their body, which can exceed the asset size.
  writtenBytes?: (url: string) => number;
  // Holds the native transfer open so tests can observe how many run at once.
  inFlight?: (url: string) => Promise<void>;
} = {}) {
  nativeDownload.mockImplementation((url, destination, options, onProgress) => ({
    async downloadAsync() {
      requested.push(url);
      await transfer.inFlight?.(url);
      fs.files.set(destination, new Uint8Array(data(url)));
      const written = transfer.writtenBytes?.(url);
      if (written !== undefined) onProgress?.({ totalBytesWritten: written, totalBytesExpectedToWrite: written });
      return { uri: destination, status: transfer.status?.(url) ?? 200, headers: {}, mimeType: null };
    },
    async pauseAsync() { return { url, fileUri: destination, options: options ?? {}, resumeData: '0' }; },
    async cancelAsync() {},
  }));
}

function fetchManifest(manifest: ModelPackManifest): typeof fetch {
  return async (input) => {
    if (!String(input).includes('manifest.json')) throw new Error('artifact_fetch_crossed_js_boundary');
    return Response.json(manifest);
  };
}

function manifest(files: ModelPackManifest['files'], version = 'v1'): ModelPackManifest {
  return { packId: 'example', kind: 'tts_sherpa', model: 'kokoro', version, files };
}

async function sha256Hex(bytes: Uint8Array) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

function multiChunkBytes(seed: number) {
  const bytes = new Uint8Array(MAX_BOUNDED_READ_BYTES * 2 + 12345);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + seed) & 0xff;
  return bytes;
}

const installOptions = {
  packId: 'example', mode: 'download_if_missing' as const, manifestUrl: 'https://example.com/manifest.json', timeoutMs: 120_000,
};

describe('modelPacks installer (native)', () => {
  beforeEach(() => { nativeDownload.mockReset(); });

  it('rewrites GitHub release file URLs using publisher-authored asset names', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha256 = await sha256Hex(bytes);
    const fs = createFs();
    const requested: string[] = [];
    useNativeDownloads(fs, () => bytes, requested);
    const remote = manifest([
      { path: 'model.onnx', url: 'https://github.com/happier/happier-assets/releases/download/model-packs/example__model.onnx?v=1', sha256, sizeBytes: bytes.length },
      // GitHub sanitizes ! into ., so the pack-relative path cannot reproduce the uploaded asset name.
      { path: 'espeak-ng-data/voices/!v/Alex', url: 'https://github.com/happier/happier-assets/releases/download/model-packs/example__espeak-ng-data__voices__.v__Alex?v=1', sha256, sizeBytes: bytes.length },
      // A malformed percent escape is still a valid URL pathname and must be reused without decoding.
      { path: 'notes%ZZ.txt', url: 'https://github.com/happier/happier-assets/releases/download/model-packs/example__notes%ZZ.txt?v=1', sha256, sizeBytes: bytes.length },
    ]);
    await ensureModelPackInstalled({
      ...installOptions, signal: new AbortController().signal,
      manifestUrl: 'https://github.com/happier-dev/happier-assets/releases/download/model-packs/example__manifest.json',
    }, { fs, fetch: fetchManifest(remote) });
    const prefix = 'https://github.com/happier-dev/happier-assets/releases/download/model-packs/';
    expect(requested).toEqual([
      `${prefix}example__model.onnx`,
      `${prefix}example__espeak-ng-data__voices__.v__Alex`,
      `${prefix}example__notes%ZZ.txt`,
    ]);
  });

  describe('large files', () => {
    it('verifies existing and downloaded files without whole-file reads', async () => {
      const existing = multiChunkBytes(1);
      const downloaded = multiChunkBytes(2);
      const fs = createFs(new Map([[`${PACK_URI}/existing.bin`, existing]]));
      const requested: string[] = [];
      useNativeDownloads(fs, () => downloaded, requested);
      await ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
        fs, fetch: fetchManifest(manifest([
          { path: 'existing.bin', url: 'https://example.com/existing.bin', sha256: await sha256Hex(existing), sizeBytes: existing.length },
          { path: 'downloaded.bin', url: 'https://example.com/downloaded.bin', sha256: await sha256Hex(downloaded), sizeBytes: downloaded.length },
        ])),
      });
      expect(requested).toEqual(['https://example.com/downloaded.bin']);
      expect(Buffer.from(fs.files.get(`${PACK_URI}/downloaded.bin`) ?? []).equals(Buffer.from(downloaded))).toBe(true);
    });

    it('rejects and removes a downloaded file whose SHA-256 does not match', async () => {
      const fs = createFs();
      useNativeDownloads(fs, () => new Uint8Array([4, 5, 6, 7]));
      await expect(ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
        fs, fetch: fetchManifest(manifest([
          { path: 'model.bin', url: 'https://example.com/model.bin', sha256: 'a'.repeat(64), sizeBytes: 4 },
        ])),
      })).rejects.toThrow('model_pack_sha256_mismatch');
      expect(fs.files.has(`${PACK_URI}/model.bin`)).toBe(false);
      expect(fs.files.has(`${PACK_URI}/pack.json`)).toBe(false);
    });

    it.each(['existing', 'downloaded'] as const)('stops %s file verification when cancelled and closes its handle', async (state) => {
      const bytes = multiChunkBytes(3);
      const fileUri = `${PACK_URI}/model.bin`;
      const files = new Map<string, Uint8Array>(state === 'existing' ? [[fileUri, bytes]] : []);
      const openHandles = new Set<object>();
      const controller = new AbortController();
      const fs = createFs(files, { openHandles, onRead: () => queueMicrotask(() => controller.abort()) });
      useNativeDownloads(fs, () => bytes);
      await expect(ensureModelPackInstalled({ ...installOptions, signal: controller.signal }, {
        fs, fetch: fetchManifest(manifest([
          { path: 'model.bin', url: 'https://example.com/model.bin', sha256: await sha256Hex(bytes), sizeBytes: bytes.length },
        ])),
      })).rejects.toThrow('aborted');
      expect(openHandles.size).toBe(0);
      expect(files.has(`${PACK_URI}/pack.json`)).toBe(false);
      // Cancelling discards the partial pack, including files kept from an earlier interrupted attempt.
      expect(files.has(fileUri)).toBe(false);
    });
  });

  describe('pack transfer', () => {
    async function packOf(count: number) {
      const bytes = new Uint8Array([9, 8, 7]);
      const sha256 = await sha256Hex(bytes);
      return {
        bytes,
        manifest: manifest(Array.from({ length: count }, (_, i) => ({
          path: `espeak-ng-data/lang/f${i}`, url: `https://example.com/f${i}`, sha256, sizeBytes: bytes.length,
        }))),
      };
    }

    it('retries a transient server error on a cache-distinct URL and completes the pack', async () => {
      useInstallerFakeClock();
      try {
        const { bytes, manifest: remote } = await packOf(1);
        const fs = createFs();
        const requested: string[] = [];
        // GitHub has served a sticky 500 for one exact asset URL while the same asset with any other
        // query string succeeded.
        useNativeDownloads(fs, () => bytes, requested, { status: (url) => (url === 'https://example.com/f0' ? 500 : 200) });
        await settleWithFakeClock(ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
          fs, fetch: fetchManifest(remote),
        }));
        expect(requested).toHaveLength(2);
        expect(requested[1]).not.toBe(requested[0]);
        expect(requested[1]?.startsWith('https://example.com/f0?')).toBe(true);
        expect(fs.files.has(`${PACK_URI}/pack.json`)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives up on a persistent server error with its status and leaves the pack uninstalled', async () => {
      useInstallerFakeClock();
      try {
        const { bytes, manifest: remote } = await packOf(1);
        const fs = createFs();
        const requested: string[] = [];
        useNativeDownloads(fs, () => bytes, requested, { status: () => 503 });
        await expect(settleWithFakeClock(ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
          fs, fetch: fetchManifest(remote),
        }))).rejects.toThrow('model_pack_download_failed:503');
        expect(requested.length).toBeGreaterThan(1);
        expect(fs.files.has(`${PACK_URI}/espeak-ng-data/lang/f0`)).toBe(false);
        expect(fs.files.has(`${PACK_URI}/pack.json`)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('downloads many small files concurrently within a bound', async () => {
      const { bytes, manifest: remote } = await packOf(24);
      const fs = createFs();
      let active = 0;
      let peak = 0;
      useNativeDownloads(fs, () => bytes, [], {
        inFlight: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        },
      });
      await ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, { fs, fetch: fetchManifest(remote) });
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThan(24);
      expect(fs.files.has(`${PACK_URI}/pack.json`)).toBe(true);
    });

    it('stops the pack on a non-retryable failure and reports that failure rather than sibling cancellation', async () => {
      const { bytes, manifest: remote } = await packOf(48);
      const fs = createFs();
      const requested: string[] = [];
      useNativeDownloads(fs, () => bytes, requested, {
        status: (url) => (url === 'https://example.com/f1' ? 404 : 200),
        // The failing file answers last, so earlier siblings have verified by then.
        inFlight: (url) => new Promise((resolve) => setTimeout(resolve, url.endsWith('/f1') ? 30 : 5)),
      });
      await expect(ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
        fs, fetch: fetchManifest(remote),
      })).rejects.toThrow('model_pack_download_failed:404');
      expect(requested.filter((url) => url === 'https://example.com/f1')).toHaveLength(1);
      expect(requested.length).toBeLessThan(48);
      expect(fs.files.has(`${PACK_URI}/pack.json`)).toBe(false);
      // Unlike a cancellation, a failure keeps verified files so retrying resumes.
      expect(fs.files.has(`${PACK_URI}/espeak-ng-data/lang/f0`)).toBe(true);
    });

    it('discards every downloaded file when the user cancels an install', async () => {
      const { bytes, manifest: remote } = await packOf(24);
      const fs = createFs();
      const controller = new AbortController();
      let completed = 0;
      useNativeDownloads(fs, () => bytes, [], {
        inFlight: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          completed += 1;
          if (completed === 8) controller.abort();
        },
      });
      await expect(ensureModelPackInstalled({ ...installOptions, signal: controller.signal }, {
        fs, fetch: fetchManifest(remote),
      })).rejects.toThrow('aborted');
      expect([...fs.files.keys()].filter((uri) => uri.startsWith(`${PACK_URI}/`))).toEqual([]);
    });

    it('never reports more progress than the pack size when a failed response body is larger than the asset', async () => {
      useInstallerFakeClock();
      try {
        const { bytes, manifest: remote } = await packOf(2);
        const fs = createFs();
        const progress: number[] = [];
        // A 500 error page is far larger than a tiny espeak-ng asset.
        useNativeDownloads(fs, () => bytes, [], {
          status: (url) => (url === 'https://example.com/f0' ? 500 : 200),
          writtenBytes: (url) => (url === 'https://example.com/f0' ? 164_854 : bytes.length),
        });
        await settleWithFakeClock(ensureModelPackInstalled({
          ...installOptions, signal: new AbortController().signal, onProgress: (p) => progress.push(p.loaded / p.total),
        }, { fs, fetch: fetchManifest(remote) }));
        expect(Math.max(...progress)).toBe(1);
        expect(progress.filter((ratio) => ratio === 1)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('removes update leftovers once a fresh install completes', async () => {
      const { bytes, manifest: remote } = await packOf(1);
      const leftover = 'file:///docs/happier/voice/modelPackUpdates/example/model.onnx';
      const fs = createFs(new Map([[leftover, new Uint8Array([7])]]));
      useNativeDownloads(fs, () => bytes);
      await ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, { fs, fetch: fetchManifest(remote) });
      expect(fs.files.has(leftover)).toBe(false);
    });

    it('counts already verified files toward progress when an interrupted install resumes', async () => {
      const { bytes, manifest: remote } = await packOf(3);
      const fs = createFs(new Map([[`${PACK_URI}/espeak-ng-data/lang/f0`, bytes], [`${PACK_URI}/espeak-ng-data/lang/f1`, bytes]]));
      const progress: Array<{ loaded: number; total: number }> = [];
      useNativeDownloads(fs, () => bytes);
      await ensureModelPackInstalled({
        ...installOptions, signal: new AbortController().signal, onProgress: (p) => progress.push({ loaded: p.loaded, total: p.total }),
      }, { fs, fetch: fetchManifest(remote) });
      expect(progress.at(-1)).toEqual({ loaded: bytes.length * 3, total: bytes.length * 3 });
    });
  });

  it('rejects pack manifests that contain unsafe paths', async () => {
    await expect(ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
      fs: createFs(), fetch: fetchManifest(manifest([
        { path: '../escape.txt', url: 'https://example.com/escape.txt', sha256: 'a'.repeat(64), sizeBytes: 1 },
      ])),
    })).rejects.toThrow('model_pack_invalid_path');
  });

  it('refreshes an installed pack when a requested manual update has a different remote manifest', async () => {
    const fs = createFs();
    const oldManifest = manifest([
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: 'a'.repeat(64), sizeBytes: 1 },
    ]);
    const meta = new fs.File(PACK_URI, 'pack.json');
    meta.write(JSON.stringify({ manifest: oldManifest }));
    const bytes = new Uint8Array([1]);
    useNativeDownloads(fs, () => bytes);
    const remote = manifest([
      { path: 'model.onnx', url: 'https://example.com/model.onnx?rev=2', sha256: await sha256Hex(bytes), sizeBytes: bytes.length },
    ], 'v2');
    await ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal, updatePolicy: 'manual_update_if_available' }, {
      fs, fetch: fetchManifest(remote),
    });
    const parsed = JSON.parse(await meta.text());
    expect(parsed.manifest.version).toBe('v2');
  });

  describe('manual updates', () => {
    async function installedPack(fs: ReturnType<typeof createFs>, entries: Array<{ path: string; bytes: Uint8Array }>) {
      const installed = manifest(await Promise.all(entries.map(async ({ path, bytes }) => {
        fs.files.set(`${PACK_URI}/${path}`, bytes);
        return { path, url: `https://example.com/v1/${path}`, sha256: await sha256Hex(bytes), sizeBytes: bytes.length };
      })), 'v1');
      new fs.File(PACK_URI, 'pack.json').write(JSON.stringify({ manifest: installed }));
      return installed;
    }

    const updateOptions = { ...installOptions, updatePolicy: 'manual_update_if_available' as const };

    it('downloads only changed files and removes files the new build dropped', async () => {
      const fs = createFs();
      const same = new Uint8Array([1]);
      await installedPack(fs, [
        { path: 'same.bin', bytes: same },
        { path: 'changed.bin', bytes: new Uint8Array([2]) },
        { path: 'dropped.bin', bytes: new Uint8Array([3]) },
      ]);
      const changed = new Uint8Array([4]);
      const added = new Uint8Array([5]);
      const remote = manifest([
        { path: 'same.bin', url: 'https://example.com/v2/same.bin', sha256: await sha256Hex(same), sizeBytes: 1 },
        { path: 'changed.bin', url: 'https://example.com/v2/changed.bin', sha256: await sha256Hex(changed), sizeBytes: 1 },
        { path: 'nested/added.bin', url: 'https://example.com/v2/added.bin', sha256: await sha256Hex(added), sizeBytes: 1 },
      ], 'v2');
      const requested: string[] = [];
      useNativeDownloads(fs, (url) => (url.endsWith('changed.bin') ? changed : added), requested);

      await ensureModelPackInstalled({ ...updateOptions, signal: new AbortController().signal }, { fs, fetch: fetchManifest(remote) });

      expect(requested.sort()).toEqual(['https://example.com/v2/added.bin', 'https://example.com/v2/changed.bin']);
      expect(fs.files.get(`${PACK_URI}/same.bin`)).toEqual(same);
      expect(fs.files.get(`${PACK_URI}/changed.bin`)).toEqual(changed);
      expect(fs.files.get(`${PACK_URI}/nested/added.bin`)).toEqual(added);
      expect(fs.files.has(`${PACK_URI}/dropped.bin`)).toBe(false);
      expect(JSON.parse(await new fs.File(PACK_URI, 'pack.json').text()).manifest.version).toBe('v2');
    });

    it('restores installed files that went missing while updating changed ones', async () => {
      const fs = createFs();
      const kept = new Uint8Array([1]);
      await installedPack(fs, [{ path: 'kept.bin', bytes: kept }, { path: 'changed.bin', bytes: new Uint8Array([2]) }]);
      fs.files.delete(`${PACK_URI}/kept.bin`);
      const changed = new Uint8Array([4]);
      const remote = manifest([
        { path: 'kept.bin', url: 'https://example.com/v2/kept.bin', sha256: await sha256Hex(kept), sizeBytes: 1 },
        { path: 'changed.bin', url: 'https://example.com/v2/changed.bin', sha256: await sha256Hex(changed), sizeBytes: 1 },
      ], 'v2');
      useNativeDownloads(fs, (url) => (url.endsWith('kept.bin') ? kept : changed));

      await ensureModelPackInstalled({ ...updateOptions, signal: new AbortController().signal }, { fs, fetch: fetchManifest(remote) });

      expect(fs.files.get(`${PACK_URI}/kept.bin`)).toEqual(kept);
      expect(fs.files.get(`${PACK_URI}/changed.bin`)).toEqual(changed);
    });

    it('removes update leftovers when the installed pack is already current', async () => {
      const fs = createFs();
      const installed = await installedPack(fs, [{ path: 'model.bin', bytes: new Uint8Array([1]) }]);
      const leftover = 'file:///docs/happier/voice/modelPackUpdates/example/model.bin';
      fs.files.set(leftover, new Uint8Array([9]));
      await ensureModelPackInstalled({ ...updateOptions, signal: new AbortController().signal }, { fs, fetch: fetchManifest(installed) });
      expect(fs.files.has(leftover)).toBe(false);
    });

    it('discards staged update files but keeps the installed pack when the user cancels an update', async () => {
      const fs = createFs();
      const original = new Uint8Array([2]);
      const installed = await installedPack(fs, [{ path: 'a.bin', bytes: original }, { path: 'b.bin', bytes: original }]);
      const next = new Uint8Array([7]);
      const remote = manifest([
        { path: 'a.bin', url: 'https://example.com/v2/a.bin', sha256: await sha256Hex(next), sizeBytes: 1 },
        { path: 'b.bin', url: 'https://example.com/v2/b.bin', sha256: await sha256Hex(next), sizeBytes: 1 },
      ], 'v2');
      const controller = new AbortController();
      useNativeDownloads(fs, () => next, [], {
        // a.bin finishes; cancelling while b.bin is in flight leaves a staged file behind without cleanup.
        inFlight: async (url) => {
          if (!url.endsWith('b.bin')) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.abort();
        },
      });

      await expect(ensureModelPackInstalled({ ...updateOptions, signal: controller.signal }, {
        fs, fetch: fetchManifest(remote),
      })).rejects.toThrow('aborted');

      expect([...fs.files.keys()].filter((uri) => uri.includes('/modelPackUpdates/'))).toEqual([]);
      expect(fs.files.get(`${PACK_URI}/a.bin`)).toEqual(original);
      expect(JSON.parse(await new fs.File(PACK_URI, 'pack.json').text()).manifest).toEqual(installed);
    });

    it('keeps the installed pack usable when an update download fails', async () => {
      const fs = createFs();
      const original = new Uint8Array([2]);
      const installed = await installedPack(fs, [{ path: 'model.bin', bytes: original }]);
      const remote = manifest([
        { path: 'model.bin', url: 'https://example.com/v2/model.bin', sha256: await sha256Hex(new Uint8Array([9])), sizeBytes: 1 },
      ], 'v2');
      const requested: string[] = [];
      useNativeDownloads(fs, () => new Uint8Array([9]), requested, { status: () => 404 });

      await expect(ensureModelPackInstalled({ ...updateOptions, signal: new AbortController().signal }, {
        fs, fetch: fetchManifest(remote),
      })).rejects.toThrow('model_pack_download_failed:404');

      expect(requested).toEqual(['https://example.com/v2/model.bin']);
      expect(fs.files.get(`${PACK_URI}/model.bin`)).toEqual(original);
      expect(JSON.parse(await new fs.File(PACK_URI, 'pack.json').text()).manifest).toEqual(installed);
    });
  });

  it('throws when packs are required but not installed', async () => {
    await expect(ensureModelPackInstalled({
      ...installOptions, signal: new AbortController().signal, mode: 'require_installed', manifestUrl: null,
    }, { fs: createFs() })).rejects.toThrow('model_pack_not_installed');
  });

  it('throws when download is requested but manifestUrl is missing', async () => {
    await expect(ensureModelPackInstalled({
      ...installOptions, signal: new AbortController().signal, manifestUrl: null,
    }, { fs: createFs() })).rejects.toThrow('model_pack_manifest_url_missing');
  });

  it('reports not installed when pack.json is missing', async () => {
    const summary = await getModelPackInstallSummary({ packId: 'example' }, { fs: createFs() });
    expect(summary.installed).toBe(false);
    expect(summary.manifest).toBe(null);
  });

  it('removes without throwing when the directory is missing', async () => {
    await expect(removeModelPack({ packId: 'example' }, { fs: createFs() })).resolves.toBeUndefined();
  });
});
