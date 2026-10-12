import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

import type { ModelPackManifest } from '@/voice/modelPacks/manifest';

import type { InstallerFs, Progress } from './types';
import { filePathParts } from './paths';
import { createTimeoutPromise, raceWithAbort } from './network';

// Model files are tens to hundreds of MB; whole-file reads exceed Android's per-app JS heap, so
// files are hashed through bounded reads.
const HASH_READ_CHUNK_BYTES = 1024 * 1024;

async function sha256FileHex(file: any): Promise<string> {
  const hash = sha256.create();
  const handle = file.open();
  try {
    while (true) {
      const chunk: Uint8Array = handle.readBytes(HASH_READ_CHUNK_BYTES);
      if (chunk.length === 0) break;
      hash.update(chunk);
      // `readBytes` is synchronous; yield between chunks so hashing does not block the JS thread.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    handle.close();
  }
  return bytesToHex(hash.digest());
}

async function writeResponseToFile(opts: {
  response: Response;
  file: any;
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}): Promise<{ loaded: number; total: number }> {
  const contentLength = opts.response.headers.get('content-length');
  const total = contentLength ? Number(contentLength) : 0;
  let loaded = 0;

  const reader = opts.response.body?.getReader();
  // Buffering the whole response would exceed the JS heap for large model files.
  if (!reader) throw new Error('model_pack_download_stream_unavailable');

  const writer = (opts.file.writableStream() as WritableStream<Uint8Array>).getWriter();
  try {
    while (true) {
      const { done, value } = await raceWithAbort(opts.signal, [reader.read()]);
      if (done) break;
      await writer.write(value);
      loaded += value.byteLength;
      opts.onProgress?.({ loaded, total });
    }
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => {});
    throw error;
  }
  return { loaded, total: total || loaded };
}

async function downloadAndVerifyFile(opts: {
  fs: InstallerFs;
  fetchImpl: typeof fetch;
  rootDir: any;
  entry: ModelPackManifest['files'][number];
  timeoutMs: number;
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}): Promise<void> {
  const parts = filePathParts(opts.entry.path);
  const parentParts = parts.slice(0, -1);
  const filename = parts[parts.length - 1]!;

  let dir = opts.rootDir;
  for (const p of parentParts) {
    dir = new opts.fs.Directory(dir, p);
  }
  try {
    dir.create({ intermediates: true, idempotent: true });
  } catch {
    // ignore
  }

  const file = new opts.fs.File(dir, filename);
  if (file.exists) {
    try {
      const actual = await sha256FileHex(file);
      if (actual === opts.entry.sha256.toLowerCase()) return;
      file.delete();
    } catch {
      try {
        file.delete();
      } catch {
        // ignore
      }
    }
  }

  const response = await raceWithAbort(opts.signal, [
    opts.fetchImpl(opts.entry.url, { signal: opts.signal }),
    createTimeoutPromise(opts.timeoutMs),
  ]);
  if (!response.ok) throw new Error(`model_pack_download_failed:${response.status}`);

  try {
    if (!file.exists) {
      try {
        file.create();
      } catch {
        // ignore
      }
    }

    await writeResponseToFile({ response, file, signal: opts.signal, onProgress: opts.onProgress });

    const actual = await sha256FileHex(file);
    if (actual !== opts.entry.sha256.toLowerCase()) {
      try {
        file.delete();
      } catch {
        // ignore
      }
      throw new Error('model_pack_sha256_mismatch');
    }
  } catch (error) {
    try {
      if (file.exists) file.delete();
    } catch {
      // ignore
    }
    throw error;
  }
}

export async function downloadManifestFiles(opts: {
  fs: InstallerFs;
  fetchImpl: typeof fetch;
  rootDir: any;
  manifest: ModelPackManifest;
  timeoutMs: number;
  signal: AbortSignal;
  onProgress?: (p: { loaded: number; total: number; file?: string }) => void;
}): Promise<void> {
  const total = opts.manifest.files.reduce((acc, f) => acc + (Number.isFinite(f.sizeBytes) ? f.sizeBytes : 0), 0);
  let loadedTotal = 0;

  for (const f of opts.manifest.files) {
    let loadedThisFile = 0;
    await downloadAndVerifyFile({
      fs: opts.fs,
      fetchImpl: opts.fetchImpl,
      rootDir: opts.rootDir,
      entry: f,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onProgress: (p) => {
        const delta = Math.max(0, p.loaded - loadedThisFile);
        loadedThisFile = p.loaded;
        loadedTotal += delta;
        opts.onProgress?.({ loaded: loadedTotal, total, file: f.path });
      },
    });
  }
}
