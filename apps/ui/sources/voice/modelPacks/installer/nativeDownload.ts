import { Platform } from 'react-native';

import { throwIfAborted } from './network';

/** Resolves only for successful HTTP responses, after native transfer and task cleanup settle. */
export type NativeModelPackDownload = (request: Readonly<{
  url: string;
  fileUri: string;
  rangeStart?: number;
  signal: AbortSignal;
  onProgress?: (loaded: number) => void;
}>) => Promise<Readonly<{ status: number; headers: Readonly<Record<string, string>> }>>;

/** Native network/file boundary: artifact bytes never enter an unbounded JS response queue. */
export const downloadNativeModelPackFile: NativeModelPackDownload = async (request) => {
  throwIfAborted(request.signal);
  const { createDownloadResumable, FileSystemSessionType } = await import('expo-file-system/legacy');
  throwIfAborted(request.signal);
  const headers: Record<string, string> = {};
  if (request.rangeStart) headers.Range = `bytes=${request.rangeStart}-`;
  const task = createDownloadResumable(request.url, request.fileUri, {
    headers, sessionType: FileSystemSessionType.FOREGROUND,
  }, (progress) => request.onProgress?.(progress.totalBytesWritten));
  let releasePromise: Promise<void> | undefined;
  const release = () => releasePromise ??= (async () => {
    if (Platform.OS === 'android') {
      // Pause removes Android's task record; cancel also removes its JS subscription.
      try { await task.pauseAsync(); } finally { await task.cancelAsync(); }
    } else {
      await task.cancelAsync();
    }
  })();
  const onAbort = () => { void release().catch(() => undefined); };
  const download = task.downloadAsync();
  request.signal.addEventListener('abort', onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  let failed = false;
  try {
    // Cancellation is not terminal. Wait for native writes before reading or deleting the file.
    // Native network timeouts own artifacts; the configured deadline still owns manifests.
    const result = await download;
    throwIfAborted(request.signal);
    if (!result) throw new Error('model_pack_download_cancelled');
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`model_pack_download_failed:${result.status}`);
    }
    return result;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    request.signal.removeEventListener('abort', onAbort);
    try { await release(); } catch (error) {
      if (!failed) throw error;
      console.warn('model_pack_native_download_cleanup_failed', error);
    }
  }
};
