import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import type { File as ExpoFile } from 'expo-file-system';

import type { ModelPackManifest } from '@/voice/modelPacks/manifest';

import type { InstallerFs, Progress } from './types';
import { filePathParts } from './paths';
import { createTimeoutPromise, raceWithAbort, throwIfAborted } from './network';

// Model files are tens to hundreds of MB; whole-file reads exceed Android's per-app JS heap, so
// files are hashed through bounded reads.
const HASH_READ_CHUNK_BYTES = 1024 * 1024;

async function sha256FileHex(file: Pick<ExpoFile, 'open'>, signal: AbortSignal): Promise<string> {
  const hash = sha256.create();
  const handle = file.open();
  try {
    while (true) {
      throwIfAborted(signal);
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
  file: Pick<ExpoFile, 'open'>;
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}): Promise<{ loaded: number; total: number }> {
  const contentLength = opts.response.headers.get('content-length');
  const total = contentLength ? Number(contentLength) : 0;
  let loaded = 0;

  const reader = opts.response.body?.getReader();
  // Buffering the whole response would exceed the JS heap for large model files.
  if (!reader) throw new Error('model_pack_download_stream_unavailable');

  let handle: ReturnType<ExpoFile['open']> | undefined;
  try {
    // Own the handle directly: an errored WritableStream cannot close its native sink.
    handle = opts.file.open();
    while (true) {
      throwIfAborted(opts.signal);
      const { done, value } = await raceWithAbort(opts.signal, [reader.read()]);
      if (done) break;
      handle.writeBytes(value);
      loaded += value.byteLength;
      opts.onProgress?.({ loaded, total });
    }
  } finally {
    try {
      handle?.close();
    } finally {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
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
      const actual = await sha256FileHex(file, opts.signal);
      if (actual === opts.entry.sha256.toLowerCase()) return;
      file.delete();
    } catch (error) {
      // A cancelled verification does not invalidate an already downloaded file.
      if (opts.signal.aborted) throw error;
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

    const actual = await sha256FileHex(file, opts.signal);
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
