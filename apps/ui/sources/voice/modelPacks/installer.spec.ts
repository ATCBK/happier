import { describe, expect, it, vi } from 'vitest';

import { ensureModelPackInstalled, getModelPackInstallSummary, removeModelPack } from '@/voice/modelPacks/installer.native';

const nativeFetch = vi.hoisted(() => vi.fn<typeof fetch>());
// Expo's native network transport is unavailable in the Node test process.
vi.mock('expo/fetch', () => ({ fetch: nativeFetch }));

function openBytes(data: Uint8Array, maxReadBytes = Number.POSITIVE_INFINITY, options: {
  onRead?: () => void;
  onClose?: () => void;
  writeBytes?: (chunk: Uint8Array, offset: number) => void;
} = {}) {
  let offset = 0;
  return {
    readBytes(length: number) {
      if (length > maxReadBytes) throw new Error('read_exceeds_js_heap_budget');
      const chunk = data.slice(offset, offset + length);
      offset += chunk.length;
      options.onRead?.();
      return chunk;
    },
    writeBytes(chunk: Uint8Array) {
      options.writeBytes?.(chunk, offset);
      offset += chunk.byteLength;
    },
    close() { options.onClose?.(); },
  };
}

describe('modelPacks installer (native)', () => {
  it('reports progress without exceeding total (streaming body)', async () => {
    const { createHash } = await import('node:crypto');
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    const expectedSha = createHash('sha256').update(Buffer.concat(chunks.map((c) => Buffer.from(c)))).digest('hex');

    const writes = new Map<string, Uint8Array[]>();

    class Directory {
      uri: string;
      exists = true;
      constructor(...uris: any[]) {
        const packId = String(uris[uris.length - 1] ?? '');
        this.uri = `file:///docs/happier/voice/modelPacks/${packId}`;
      }
      create() {}
      delete() {}
    }

    class File {
      uri: string;
      constructor(...uris: any[]) {
        const [base, name] = uris;
        if (base?.uri && typeof name === 'string') {
          this.uri = `${String(base.uri).replace(/\/$/, '')}/${name}`;
        } else if (typeof base === 'string' && typeof name === 'string') {
          this.uri = `${base.replace(/\/$/, '')}/${name}`;
        } else if (typeof uris[0] === 'string') {
          this.uri = uris[0];
        } else {
          this.uri = 'file:///docs/happier/voice/modelPacks/example/pack.json';
        }
      }
      get exists() {
        return writes.has(this.uri);
      }
      create() {
        if (!writes.has(this.uri)) writes.set(this.uri, []);
      }
      async bytes() {
        return this.bytesSync();
      }
      bytesSync() {
        const arr = writes.get(this.uri) ?? [];
        const total = arr.reduce((acc, b) => acc + b.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const b of arr) {
          out.set(b, off);
          off += b.length;
        }
        return out;
      }
      async text() {
        const buf = await this.bytes();
        return new TextDecoder().decode(buf);
      }
      open() {
        return openBytes(this.bytesSync(), Number.POSITIVE_INFINITY, {
          writeBytes: (chunk) => {
            const arr = writes.get(this.uri) ?? [];
            arr.push(new Uint8Array(chunk));
            writes.set(this.uri, arr);
          },
        });
      }
      write(data: string | Uint8Array) {
        const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        writes.set(this.uri, [new Uint8Array(buf)]);
      }
      delete() {
        writes.delete(this.uri);
      }
      arrayBuffer() {
        return this.bytes().then((b) => b.buffer);
      }
    }

    const progressCalls: Array<{ loaded: number; total: number }> = [];

    const fetchImpl = async (url: string) => {
      if (url.includes('manifest.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            packId: 'example',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: 'v1',
            files: [
              {
                path: 'model.onnx',
                url: 'https://example.com/model.onnx',
                sha256: expectedSha,
                sizeBytes: 4,
              },
            ],
          }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? '4' : null) },
        body: {
          getReader() {
            let i = 0;
            return {
              async read() {
                if (i >= chunks.length) return { done: true, value: undefined };
                const value = chunks[i++]!;
                return { done: false, value };
              },
              async cancel() {},
              releaseLock() {},
            };
          },
        },
      } as any;
    };

    await ensureModelPackInstalled(
      {
        packId: 'example',
        mode: 'download_if_missing',
        manifestUrl: 'https://example.com/manifest.json',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        onProgress: (p) => progressCalls.push({ loaded: p.loaded, total: p.total }),
      },
      {
        fs: { Directory, File, Paths: { document: 'file:///docs/' } } as any,
        fetch: fetchImpl as any,
      },
    );

    expect(progressCalls.length).toBeGreaterThan(1);
    const last = progressCalls[progressCalls.length - 1]!;
    expect(last.total).toBe(4);
    expect(last.loaded).toBe(4);
    for (const call of progressCalls) {
      expect(call.loaded).toBeLessThanOrEqual(call.total);
    }
  });

  it('rewrites GitHub release file URLs to match the manifest origin', async () => {
    const { createHash } = await import('node:crypto');
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const expectedSha = createHash('sha256').update(Buffer.from(bytes)).digest('hex');

    const writes = new Map<string, Uint8Array[]>();

    class Directory {
      uri: string;
      exists = true;
      constructor(...uris: any[]) {
        const packId = String(uris[uris.length - 1] ?? '');
        this.uri = `file:///docs/happier/voice/modelPacks/${packId}`;
      }
      create() {}
      delete() {}
    }

    class File {
      uri: string;
      constructor(...uris: any[]) {
        const [base, name] = uris;
        if (base?.uri && typeof name === 'string') {
          this.uri = `${String(base.uri).replace(/\/$/, '')}/${name}`;
        } else if (typeof base === 'string' && typeof name === 'string') {
          this.uri = `${base.replace(/\/$/, '')}/${name}`;
        } else if (typeof uris[0] === 'string') {
          this.uri = uris[0];
        } else {
          this.uri = 'file:///docs/happier/voice/modelPacks/example/pack.json';
        }
      }
      get exists() {
        return writes.has(this.uri);
      }
      create() {
        if (!writes.has(this.uri)) writes.set(this.uri, []);
      }
      write(data: string | Uint8Array) {
        const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        writes.set(this.uri, [new Uint8Array(buf)]);
      }
      async bytes() {
        return this.bytesSync();
      }
      bytesSync() {
        const arr = writes.get(this.uri) ?? [];
        const total = arr.reduce((acc, b) => acc + b.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const b of arr) {
          out.set(b, off);
          off += b.length;
        }
        return out;
      }
      async text() {
        const buf = await this.bytes();
        return new TextDecoder().decode(buf);
      }
      open() {
        return openBytes(this.bytesSync(), Number.POSITIVE_INFINITY, {
          writeBytes: (chunk) => {
            const arr = writes.get(this.uri) ?? [];
            arr.push(new Uint8Array(chunk));
            writes.set(this.uri, arr);
          },
        });
      }
      delete() {
        writes.delete(this.uri);
      }
    }

    const manifestUrl = 'https://github.com/happier-dev/happier-assets/releases/download/model-packs/example__manifest.json';
    const expectedDownloadPrefix = 'https://github.com/happier-dev/happier-assets/releases/download/model-packs/';
    const requestedFileUrls: string[] = [];

    const fetchImpl = async (url: string) => {
      if (url.includes('__manifest.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            packId: 'example',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: 'v1',
            files: [
              {
                path: 'model.onnx',
                url: 'https://github.com/happier/happier-assets/releases/download/model-packs/example__model.onnx?v=1',
                sha256: expectedSha,
                sizeBytes: bytes.length,
              },
              {
                // GitHub stores uploaded asset names with `!` replaced by `.`, so the published
                // asset name cannot be re-derived from the pack-relative path.
                path: 'espeak-ng-data/voices/!v/Alex',
                url: 'https://github.com/happier/happier-assets/releases/download/model-packs/example__espeak-ng-data__voices__.v__Alex?v=1',
                sha256: expectedSha,
                sizeBytes: bytes.length,
              },
              {
                // A malformed percent-escape is a valid URL and must not reject the whole manifest.
                path: 'notes%ZZ.txt',
                url: 'https://github.com/happier/happier-assets/releases/download/model-packs/example__notes%ZZ.txt?v=1',
                sha256: expectedSha,
                sizeBytes: bytes.length,
              },
            ],
          }),
        } as any;
      }

      requestedFileUrls.push(url);
      if (!url.startsWith(expectedDownloadPrefix)) {
        throw new Error(`unexpected_file_url:${url}`);
      }

      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
        body: {
          getReader() {
            let done = false;
            return {
              async read() {
                if (done) return { done: true, value: undefined };
                done = true;
                return { done: false, value: bytes };
              },
              async cancel() {},
              releaseLock() {},
            };
          },
        },
      } as any;
    };

    await ensureModelPackInstalled(
      {
        packId: 'example',
        mode: 'download_if_missing',
        manifestUrl,
        timeoutMs: 5000,
        signal: new AbortController().signal,
      },
      {
        fs: { Directory, File, Paths: { document: 'file:///docs/' } } as any,
        fetch: fetchImpl as any,
      },
    );

    expect(requestedFileUrls).toEqual([
      `${expectedDownloadPrefix}example__model.onnx`,
      `${expectedDownloadPrefix}example__espeak-ng-data__voices__.v__Alex`,
      `${expectedDownloadPrefix}example__notes%ZZ.txt`,
    ]);
  });

  describe('large files', () => {
    // Native `File.bytes()` materializes the whole file in the JS heap, which exceeds Android's
    // per-app heap for model files (tens to hundreds of MB). This boundary fake makes whole-file
    // reads fail and only supports bounded reads through `File.open().readBytes(length)`.
    function createBoundedReadFs(files: Map<string, Uint8Array>, options: {
      onRead?: () => void;
      writeError?: Error;
      openError?: Error;
      openHandles?: Set<object>;
    } = {}) {
      class Directory {
        uri: string;
        exists = true;
        constructor(...uris: any[]) {
          const [base, name] = uris;
          this.uri = base?.uri && typeof name === 'string' ? `${base.uri}/${name}` : `file:///docs/modelPacks/${String(uris[uris.length - 1] ?? '')}`;
        }
        create() {}
        delete() {}
      }

      class File {
        uri: string;
        constructor(base: any, name: string) {
          this.uri = `${typeof base === 'string' ? base : base.uri}/${name}`;
        }
        get exists() {
          return files.has(this.uri);
        }
        create() {
          if (!files.has(this.uri)) files.set(this.uri, new Uint8Array());
        }
        delete() {
          if (options.openHandles?.size) throw new Error('file_handle_still_open');
          files.delete(this.uri);
        }
        write(data: string | Uint8Array) {
          files.set(this.uri, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
        }
        async text() {
          return new TextDecoder().decode(files.get(this.uri) ?? new Uint8Array());
        }
        async bytes(): Promise<Uint8Array> {
          throw new Error('whole_file_read_exceeds_js_heap');
        }
        open() {
          if (options.openError) throw options.openError;
          const token = {};
          options.openHandles?.add(token);
          return openBytes(files.get(this.uri) ?? new Uint8Array(), MAX_BOUNDED_READ_BYTES, {
            onRead: options.onRead,
            onClose: () => { options.openHandles?.delete(token); },
            writeBytes: (chunk, offset) => {
              if (options.writeError) throw options.writeError;
              const prev = files.get(this.uri) ?? new Uint8Array();
              const next = new Uint8Array(Math.max(prev.byteLength, offset + chunk.byteLength));
              next.set(prev);
              next.set(chunk, offset);
              files.set(this.uri, next);
            },
          });
        }
      }

      return { Directory, File, Paths: { document: 'file:///docs/' } };
    }

    // Generous stand-in for "a read the JS heap can afford"; test files span several of these so the
    // hash must be computed across chunk boundaries.
    const MAX_BOUNDED_READ_BYTES = 4 * 1024 * 1024;

    function multiChunkBytes(seed: number) {
      const bytes = new Uint8Array(MAX_BOUNDED_READ_BYTES * 2 + 12345);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + seed) & 0xff;
      return bytes;
    }

    function streamingResponse(bytes: Uint8Array) {
      let done = false;
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
        body: {
          getReader() {
            return {
              async read() {
                if (done) return { done: true, value: undefined };
                done = true;
                return { done: false, value: bytes };
              },
              async cancel() {},
              releaseLock() {},
            };
          },
        },
      };
    }

    async function sha256Hex(bytes: Uint8Array) {
      const { createHash } = await import('node:crypto');
      return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    }

    it('verifies existing and downloaded files without whole-file reads', async () => {
      const existing = multiChunkBytes(1);
      const downloaded = multiChunkBytes(2);
      const files = new Map<string, Uint8Array>([['file:///docs/modelPacks/example/existing.bin', existing]]);
      const requested: string[] = [];

      await ensureModelPackInstalled(
        {
          packId: 'example',
          mode: 'download_if_missing',
          manifestUrl: 'https://example.com/manifest.json',
          timeoutMs: 5000,
          signal: new AbortController().signal,
        },
        {
          fs: createBoundedReadFs(files) as any,
          fetch: (async (url: string) => {
            if (url.includes('manifest.json')) {
              return {
                ok: true,
                status: 200,
                json: async () => ({
                  packId: 'example',
                  kind: 'stt_sherpa',
                  model: 'zipformer',
                  version: 'v1',
                  files: [
                    { path: 'existing.bin', url: 'https://example.com/existing.bin', sha256: await sha256Hex(existing), sizeBytes: existing.length },
                    { path: 'downloaded.bin', url: 'https://example.com/downloaded.bin', sha256: await sha256Hex(downloaded), sizeBytes: downloaded.length },
                  ],
                }),
              };
            }
            requested.push(url);
            return streamingResponse(downloaded);
          }) as any,
        },
      );

      expect(requested).toEqual(['https://example.com/downloaded.bin']);
      expect(Buffer.from(files.get('file:///docs/modelPacks/example/downloaded.bin') ?? []).equals(Buffer.from(downloaded))).toBe(true);
    });

    it('still rejects a downloaded file whose sha256 does not match', async () => {
      const files = new Map<string, Uint8Array>();

      await expect(
        ensureModelPackInstalled(
          {
            packId: 'example',
            mode: 'download_if_missing',
            manifestUrl: 'https://example.com/manifest.json',
            timeoutMs: 5000,
            signal: new AbortController().signal,
          },
          {
            fs: createBoundedReadFs(files) as any,
            fetch: (async (url: string) => {
              if (url.includes('manifest.json')) {
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({
                    packId: 'example',
                    kind: 'stt_sherpa',
                    model: 'zipformer',
                    version: 'v1',
                    files: [{ path: 'model.bin', url: 'https://example.com/model.bin', sha256: 'a'.repeat(64), sizeBytes: 4 }],
                  }),
                };
              }
              return streamingResponse(new Uint8Array([4, 5, 6, 7]));
            }) as any,
          },
        ),
      ).rejects.toThrow(/model_pack_sha256_mismatch/);
      expect(files.has('file:///docs/modelPacks/example/model.bin')).toBe(false);
    });

    it.each(['existing', 'downloaded'] as const)('stops %s file verification when cancelled and closes its handle', async (state) => {
      const bytes = multiChunkBytes(3);
      const fileUri = 'file:///docs/modelPacks/example/model.bin';
      const files = new Map<string, Uint8Array>(state === 'existing' ? [[fileUri, bytes]] : []);
      const openHandles = new Set<object>();
      const controller = new AbortController();
      const expectedSha = await sha256Hex(bytes);
      const fs = createBoundedReadFs(files, { openHandles, onRead: () => queueMicrotask(() => controller.abort()) });
      const fetchImpl: typeof fetch = async (url) => String(url).includes('manifest.json')
        ? Response.json({ packId: 'example', kind: 'stt_sherpa', model: 'zipformer', version: 'v1', files: [
          { path: 'model.bin', url: 'https://example.com/model.bin', sha256: expectedSha, sizeBytes: bytes.length },
        ] })
        : new Response(new Blob([bytes]).stream());

      await expect(ensureModelPackInstalled({
        packId: 'example', mode: 'download_if_missing', manifestUrl: 'https://example.com/manifest.json',
        timeoutMs: 5000, signal: controller.signal,
      }, { fs, fetch: fetchImpl })).rejects.toThrow('aborted');

      expect(openHandles.size).toBe(0);
      expect(files.has('file:///docs/modelPacks/example/pack.json')).toBe(false);
      expect(files.has(fileUri)).toBe(state === 'existing');
    });

    it.each(['write', 'open'] as const)('cancels the response and closes file handles after a file %s failure', async (failure) => {
      const files = new Map<string, Uint8Array>();
      const openHandles = new Set<object>();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); },
        cancel() { cancelled = true; },
      });
      const error = new Error(`file_${failure}_failed`);
      const fs = createBoundedReadFs(files, { openHandles, ...(failure === 'write' ? { writeError: error } : { openError: error }) });
      const fetchImpl: typeof fetch = async (url) => String(url).includes('manifest.json')
        ? Response.json({ packId: 'example', kind: 'stt_sherpa', model: 'zipformer', version: 'v1', files: [
          { path: 'model.bin', url: 'https://example.com/model.bin', sha256: 'a'.repeat(64), sizeBytes: 4 },
        ] })
        : new Response(body);

      await expect(ensureModelPackInstalled({
        packId: 'example', mode: 'download_if_missing', manifestUrl: 'https://example.com/manifest.json',
        timeoutMs: 5000, signal: new AbortController().signal,
      }, { fs, fetch: fetchImpl })).rejects.toThrow(error.message);

      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
      expect(openHandles.size).toBe(0);
      expect(files.has('file:///docs/modelPacks/example/model.bin')).toBe(false);
      expect(files.has('file:///docs/modelPacks/example/pack.json')).toBe(false);
    });

    it('rejects unavailable streaming without reading the entire response', async () => {
      const files = new Map<string, Uint8Array>();
      const response = new Response(new Uint8Array([1]));
      Object.defineProperty(response, 'body', { value: null });
      response.arrayBuffer = async () => { throw new Error('whole_response_read'); };
      const fetchImpl: typeof fetch = async (url) => String(url).includes('manifest.json')
        ? Response.json({ packId: 'example', kind: 'stt_sherpa', model: 'zipformer', version: 'v1', files: [
          { path: 'model.bin', url: 'https://example.com/model.bin', sha256: 'a'.repeat(64), sizeBytes: 1 },
        ] })
        : response;

      await expect(ensureModelPackInstalled({
        packId: 'example', mode: 'download_if_missing', manifestUrl: 'https://example.com/manifest.json',
        timeoutMs: 5000, signal: new AbortController().signal,
      }, { fs: createBoundedReadFs(files), fetch: fetchImpl })).rejects.toThrow('model_pack_download_stream_unavailable');
      expect(files.has('file:///docs/modelPacks/example/model.bin')).toBe(false);
    });

    it('installs through Expo streaming fetch by default without global fetch', async () => {
      const files = new Map<string, Uint8Array>();
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const expectedSha = await sha256Hex(bytes);
      nativeFetch.mockImplementation(async (url) => String(url).includes('manifest.json')
        ? Response.json({ packId: 'example', kind: 'stt_sherpa', model: 'zipformer', version: 'v1', files: [
          { path: 'model.bin', url: 'https://example.com/model.bin', sha256: expectedSha, sizeBytes: bytes.length },
        ] })
        : new Response(new Blob([bytes]).stream()));
      const globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('global_fetch_cannot_stream'));
      try {
        await ensureModelPackInstalled({
          packId: 'example', mode: 'download_if_missing', manifestUrl: 'https://example.com/manifest.json',
          timeoutMs: 5000, signal: new AbortController().signal,
        }, { fs: createBoundedReadFs(files) });
        expect(files.get('file:///docs/modelPacks/example/model.bin')).toEqual(bytes);
        expect(files.has('file:///docs/modelPacks/example/pack.json')).toBe(true);
      } finally {
        globalFetch.mockRestore();
      }
    });
  });

  it('rejects pack manifests that contain unsafe paths', async () => {
    class Directory {
      uri: string;
      exists = false;
      constructor(..._uris: any[]) {
        this.uri = 'file:///docs/happier/voice/modelPacks/example';
      }
      create() {}
      delete() {}
    }
    class File {
      exists = false;
      uri = 'file:///docs/happier/voice/modelPacks/example/pack.json';
      constructor(..._uris: any[]) {}
      async text() {
        return '';
      }
      write() {}
      create() {}
      delete() {}
      async bytes() {
        return new Uint8Array();
      }
    }

    const fetchImpl = async (_url: string) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          packId: 'example',
          kind: 'tts_sherpa',
          model: 'kokoro',
          version: 'v1',
          files: [
            {
              path: '../escape.txt',
              url: 'https://example.com/escape.txt',
              sha256: 'a'.repeat(64),
              sizeBytes: 1,
            },
          ],
        }),
      } as any;
    };

    await expect(
      ensureModelPackInstalled(
        {
          packId: 'example',
          mode: 'download_if_missing',
          manifestUrl: 'https://example.com/manifest.json',
          timeoutMs: 5000,
          signal: new AbortController().signal,
        },
        {
          fs: { Directory, File, Paths: { document: 'file:///docs/' } } as any,
          fetch: fetchImpl as any,
        },
      ),
    ).rejects.toThrow(/model_pack_invalid_path/);
  });

  it('refreshes an installed pack when manual_update_if_available is requested and the remote manifest differs', async () => {
    const files = new Map<string, Uint8Array>();
    const sha256Byte1 = '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a';

    class Directory {
      uri: string;
      constructor(...uris: any[]) {
        const packId = String(uris[uris.length - 1] ?? '');
        this.uri = `file:///docs/happier/voice/modelPacks/${packId || 'example'}`;
      }
      create() {}
      delete() {
        // Wipe all tracked files in this directory.
        for (const key of Array.from(files.keys())) {
          if (key.startsWith(this.uri)) files.delete(key);
        }
      }
    }

    class File {
      uri: string;
      constructor(...uris: any[]) {
        const [base, name] = uris;
        if (typeof base === 'string' && typeof name === 'string') {
          this.uri = `${base.replace(/\/$/, '')}/${name}`;
        } else if (base?.uri && typeof name === 'string') {
          this.uri = `${String(base.uri).replace(/\/$/, '')}/${name}`;
        } else if (typeof uris[0] === 'string') {
          this.uri = uris[0];
        } else {
          this.uri = 'file:///docs/happier/voice/modelPacks/example/pack.json';
        }
      }
      get exists() {
        return files.has(this.uri);
      }
      async text() {
        const buf = files.get(this.uri) ?? new Uint8Array();
        return new TextDecoder().decode(buf);
      }
      async bytes() {
        return files.get(this.uri) ?? new Uint8Array();
      }
      open() {
        return openBytes(files.get(this.uri) ?? new Uint8Array(), Number.POSITIVE_INFINITY, {
          writeBytes: (chunk, offset) => {
            const prev = files.get(this.uri) ?? new Uint8Array();
            const next = new Uint8Array(Math.max(prev.byteLength, offset + chunk.byteLength));
            next.set(prev);
            next.set(chunk, offset);
            files.set(this.uri, next);
          },
        });
      }
      write(data: string | Uint8Array) {
        const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        files.set(this.uri, new Uint8Array(buf));
      }
      create() {
        if (!files.has(this.uri)) files.set(this.uri, new Uint8Array());
      }
      delete() {
        files.delete(this.uri);
      }
    }

    // Seed an installed pack.json with manifest A.
    const installedMeta = new File('file:///docs/happier/voice/modelPacks/example', 'pack.json');
    installedMeta.write(
      JSON.stringify({
        manifest: {
          packId: 'example',
          kind: 'tts_sherpa',
          model: 'kokoro',
          version: 'v1',
          files: [
            {
              path: 'model.onnx',
              url: 'https://example.com/model.onnx',
              sha256: 'a'.repeat(64),
              sizeBytes: 1,
            },
          ],
        },
      }),
    );

    const fetchImpl = async (url: string) => {
      // Remote manifest B with a different sha256 forces refresh.
      if (url.includes('manifest.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            packId: 'example',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: 'v2',
            files: [
              {
                path: 'model.onnx',
                url: 'https://example.com/model.onnx?rev=2',
                sha256: sha256Byte1,
                sizeBytes: 1,
              },
            ],
          }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => '1' },
        body: new Blob([new Uint8Array([1])]).stream(),
      } as any;
    };

    await ensureModelPackInstalled(
      {
        packId: 'example',
        mode: 'download_if_missing',
        updatePolicy: 'manual_update_if_available',
        manifestUrl: 'https://example.com/manifest.json',
        timeoutMs: 5000,
        signal: new AbortController().signal,
      },
      {
        fs: { Directory, File, Paths: { document: 'file:///docs/' } } as any,
        fetch: fetchImpl as any,
      },
    );

    // pack.json should now contain version v2.
    const parsed = JSON.parse(await installedMeta.text());
    expect(parsed?.manifest?.version).toBe('v2');
  });

  it('throws when packs are required but not installed', async () => {
    await expect(
      ensureModelPackInstalled(
        {
          packId: 'kokoro-tts-en-v1',
          mode: 'require_installed',
          manifestUrl: null,
          timeoutMs: 5000,
          signal: new AbortController().signal,
        },
        {
          fs: {
            Directory: class {
              uri: string;
              exists = false;
              constructor(..._uris: any[]) {
                this.uri = 'file:///docs/happier/voice/modelPacks/kokoro-tts-en-v1';
              }
              create() {}
              list() {
                return [];
              }
            },
            File: class {
              exists = false;
              uri = 'file:///docs/happier/voice/modelPacks/kokoro-tts-en-v1/pack.json';
              constructor(..._uris: any[]) {}
              async text() {
                return '';
              }
              write() {}
            },
            Paths: { document: 'file:///docs/' },
          },
        },
      ),
    ).rejects.toThrow(/model_pack_not_installed/);
  });

  it('throws when download is requested but manifestUrl is missing', async () => {
    await expect(
      ensureModelPackInstalled(
        {
          packId: 'kokoro-tts-en-v1',
          mode: 'download_if_missing',
          manifestUrl: null,
          timeoutMs: 5000,
          signal: new AbortController().signal,
        },
        {
          fs: {
            Directory: class {
              uri: string;
              exists = false;
              constructor(..._uris: any[]) {
                this.uri = 'file:///docs/happier/voice/modelPacks/kokoro-tts-en-v1';
              }
              create() {}
              list() {
                return [];
              }
            },
            File: class {
              exists = false;
              uri = 'file:///docs/happier/voice/modelPacks/kokoro-tts-en-v1/pack.json';
              constructor(..._uris: any[]) {}
              async text() {
                return '';
              }
              write() {}
            },
            Paths: { document: 'file:///docs/' },
          },
        },
      ),
    ).rejects.toThrow(/model_pack_manifest_url_missing/);
  });

  it('reports not installed when pack.json is missing', async () => {
    const summary = await getModelPackInstallSummary(
      { packId: 'kokoro-tts-en-v1' },
      {
        fs: {
          Directory: class {
            uri: string;
            exists = false;
            constructor(..._uris: any[]) {
              this.uri = 'file:///docs/happier/voice/modelPacks/kokoro-tts-en-v1';
            }
            create() {}
          },
          File: class {
            exists = false;
            uri = 'file:///docs/happier/voice/modelPacks/kokoro-tts-en-v1/pack.json';
            constructor(..._uris: any[]) {}
            async text() {
              return '';
            }
          },
          Paths: { document: 'file:///docs/' },
        },
      },
    );

    expect(summary.installed).toBe(false);
    expect(summary.manifest).toBe(null);
  });

  it('removes without throwing when the directory is missing', async () => {
    await expect(
      removeModelPack(
        { packId: 'kokoro-tts-en-v1' },
        {
          fs: {
            Directory: class {
              exists = false;
              uri = 'file:///docs/happier/voice/modelPacks/kokoro-tts-en-v1';
              constructor(..._uris: any[]) {}
              delete() {}
            },
            File: class {
              exists = false;
              uri = 'file:///docs/happier/voice/modelPacks/kokoro-tts-en-v1/pack.json';
              constructor(..._uris: any[]) {}
            },
            Paths: { document: 'file:///docs/' },
          },
        },
      ),
    ).resolves.toBeUndefined();
  });
});
