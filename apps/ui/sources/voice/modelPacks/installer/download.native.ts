import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import type { File as ExpoFile } from 'expo-file-system';
import { Platform } from 'react-native';

import type { ModelPackManifest } from '@/voice/modelPacks/manifest';

import type { InstallerFs, Progress } from './types';
import { getPackFile } from './paths';
import { cacheBustUrl, throwIfAborted } from './network';

// Model files are tens to hundreds of MB; whole-file reads exceed Android's per-app JS heap, so
// files are hashed through bounded reads.
const HASH_READ_CHUNK_BYTES = 1024 * 1024;

// Packs hold hundreds of small espeak-ng files, so per-request latency dominates a sequential install.
// Measured on the 254 small Kokoro q8 assets from GitHub releases: sequential 55s, 3 parallel 6.1s,
// 6 parallel 2.8s, 12 parallel 1.8s. Six matches the conventional per-host connection limit and bounds
// concurrent native transfer tasks and verification reads; beyond it the gain flattens.
const MAX_PARALLEL_FILE_DOWNLOADS = 6;

// GitHub release downloads intermittently fail with 5xx; one exact asset URL served a sticky 500 for
// minutes while the same asset with any other query string succeeded, so retries use a fresh query. The
// schedule surfaces a real outage within seconds; a manual retry then resumes from verified files.
const TRANSIENT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

const HTTP_FAILURE_PREFIX = 'model_pack_download_failed:';

function isTransientTransferFailure(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || !(error instanceof Error)) return false;
  if (error.message.startsWith(HTTP_FAILURE_PREFIX)) {
    const status = Number(error.message.slice(HTTP_FAILURE_PREFIX.length));
    return status === 408 || status === 429 || status >= 500;
  }
  // Installer outcomes (checksum mismatch, cancellation) are final; native transport failures
  // (connection reset, DNS, timeouts) carry platform-specific messages and are retried.
  return !error.message.startsWith('model_pack_');
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  throwIfAborted(signal);
}

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

type NativeDownloader = Pick<typeof import('expo-file-system/legacy'), 'createDownloadResumable' | 'FileSystemSessionType'>;

async function downloadToFile(opts: {
  downloader: NativeDownloader;
  url: string;
  fileUri: string;
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}): Promise<void> {
  throwIfAborted(opts.signal);
  const { createDownloadResumable, FileSystemSessionType } = opts.downloader;
  // Expo fetch queues native events without backpressure. Keep artifact bytes entirely native;
  // only numeric progress crosses into JS, followed by bounded disk reads for verification.
  const task = createDownloadResumable(opts.url, opts.fileUri, {
    sessionType: FileSystemSessionType.FOREGROUND,
  }, (progress) => opts.onProgress?.({
    loaded: progress.totalBytesWritten,
    total: progress.totalBytesExpectedToWrite,
  }));
  let releasePromise: Promise<void> | undefined;
  const release = () => releasePromise ??= (async () => {
    if (Platform.OS === 'android') {
      // Android's cancel alone retains the native task. Pause removes it; cancel also removes
      // the JS progress subscription when native setup failed before task registration.
      try {
        await task.pauseAsync();
      } finally {
        await task.cancelAsync();
      }
    } else {
      // iOS unregisters completed tasks itself, so pause would fail before unsubscribing.
      await task.cancelAsync();
    }
  })();
  const onAbort = () => {
    // The same promise is awaited below; attach a handler now to avoid an unhandled rejection.
    void release().catch(() => undefined);
  };
  const download = task.downloadAsync();
  opts.signal.addEventListener('abort', onAbort, { once: true });
  if (opts.signal.aborted) onAbort();
  let transferFailed = false;
  try {
    // A cancellation request is not terminal: native writes must settle before hashing/deleting.
    // Model files use native network timeouts; the configured deadline still owns manifest fetches.
    const result = await download;
    throwIfAborted(opts.signal);
    if (!result) throw new Error('model_pack_download_cancelled');
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`${HTTP_FAILURE_PREFIX}${result.status}`);
    }
  } catch (error) {
    transferFailed = true;
    throw error;
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
    try {
      await release();
    } catch (error) {
      if (!transferFailed) throw error;
      // Preserve the causal transfer error, but keep failed cleanup visible by default.
      console.warn('[modelPacks] Failed to release native download', error);
    }
  }
}

async function downloadAndVerifyFile(opts: {
  downloader: NativeDownloader;
  fs: InstallerFs;
  rootDir: any;
  entry: ModelPackManifest['files'][number];
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      // A cached edge failure is keyed by the exact URL, so retries must not repeat it.
      const url = attempt === 0 ? opts.entry.url : cacheBustUrl(opts.entry.url);
      await downloadAndVerifyFileOnce({ ...opts, url });
      return;
    } catch (error) {
      const retryDelayMs = TRANSIENT_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || !isTransientTransferFailure(error, opts.signal)) throw error;
      console.warn(`[modelPacks] Retrying ${opts.entry.path} after transient failure`, error);
      await abortableDelay(retryDelayMs, opts.signal);
    }
  }
}

async function downloadAndVerifyFileOnce(opts: {
  downloader: NativeDownloader;
  fs: InstallerFs;
  rootDir: any;
  entry: ModelPackManifest['files'][number];
  url: string;
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}): Promise<void> {
  const file = getPackFile(opts.fs, opts.rootDir, opts.entry.path, { createParents: true });
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

  try {
    await downloadToFile({
      downloader: opts.downloader, url: opts.url, fileUri: file.uri, signal: opts.signal, onProgress: opts.onProgress,
    });

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
  rootDir: any;
  manifest: ModelPackManifest;
  signal: AbortSignal;
  onProgress?: (p: { loaded: number; total: number; file?: string }) => void;
}): Promise<void> {
  const total = opts.manifest.files.reduce((acc, f) => acc + (Number.isFinite(f.sizeBytes) ? f.sizeBytes : 0), 0);
  let loadedTotal = 0;
  throwIfAborted(opts.signal);
  const downloader = await import('expo-file-system/legacy');
  // The first fatal failure stops sibling transfers; the pack then reports that failure, not their aborts.
  const pack = new AbortController();
  const forwardAbort = () => pack.abort();
  opts.signal.addEventListener('abort', forwardAbort, { once: true });
  if (opts.signal.aborted) pack.abort();
  let failure: { error: unknown } | null = null;
  let next = 0;

  const installFile = async (f: ModelPackManifest['files'][number]) => {
    let loadedThisFile = 0;
    const advance = (loaded: number) => {
      const delta = loaded - loadedThisFile;
      if (delta <= 0) return;
      loadedThisFile = loaded;
      loadedTotal += delta;
      opts.onProgress?.({ loaded: loadedTotal, total, file: f.path });
    };
    await downloadAndVerifyFile({
      downloader,
      fs: opts.fs,
      rootDir: opts.rootDir,
      entry: f,
      signal: pack.signal,
      // Native counts error-response bodies too; a failed attempt must not report beyond the asset.
      onProgress: (p) => advance(Number.isFinite(f.sizeBytes) ? Math.min(p.loaded, f.sizeBytes) : p.loaded),
    });
    // Verified files count fully, including ones already present from an interrupted install.
    advance(Number.isFinite(f.sizeBytes) ? f.sizeBytes : loadedThisFile);
  };

  const worker = async () => {
    while (!pack.signal.aborted && next < opts.manifest.files.length) {
      const f = opts.manifest.files[next++]!;
      try {
        await installFile(f);
      } catch (error) {
        failure ??= { error };
        pack.abort();
      }
    }
  };

  try {
    const workerCount = Math.min(MAX_PARALLEL_FILE_DOWNLOADS, opts.manifest.files.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
  } finally {
    opts.signal.removeEventListener('abort', forwardAbort);
  }
  throwIfAborted(opts.signal);
  if (failure) throw (failure as { error: unknown }).error;
}
