import type { ExternalSessionContentSearchControl } from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { CodexRolloutPreparation } from '../../../rollout/discovery/preparation.js';
import type { CodexSessionMetaCache } from '../../../rollout/discovery/indexData.js';
import type { AgentExternalSessionsPageTranscriptRequest } from '@happier-dev/plugin-sdk/sessions/external';
import type { JsonlScannerFileSystem } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { open, stat } from 'node:fs/promises';

export type CodexExternalSessionInvocationBounds = Readonly<{
  signal?: AbortSignal;
  deadlineAtMs?: number;
  /** Content discovery may yield before another observed work unit cannot fit. */
  onProgress?: (resetEstimate?: boolean) => void;
  contentSearchControl?: ExternalSessionContentSearchControl;
  preparation?: CodexRolloutPreparation;
  sessionMetaCache?: CodexSessionMetaCache;
  observation?: AgentExternalSessionsPageTranscriptRequest['observation'];
}>;

export function throwIfCodexExternalSessionInvocationStopped(
  bounds: CodexExternalSessionInvocationBounds,
): void {
  bounds.signal?.throwIfAborted();
  bounds.preparation?.assertNotYielded();
  bounds.onProgress?.();
  if (
    bounds.deadlineAtMs !== undefined
    && Number.isFinite(bounds.deadlineAtMs)
    && Date.now() >= bounds.deadlineAtMs
  ) {
    const error = new Error('Codex External Sessions invocation deadline exceeded.');
    error.name = 'TimeoutError';
    throw error;
  }
}

/** Signal-only reads use the SDK's scan-owned descriptor. Explicit invocation
 * checkpoints still need the filesystem boundary between indivisible rows. */
export function createCodexExternalSessionJsonlScannerFileSystem(
  bounds: CodexExternalSessionInvocationBounds,
): JsonlScannerFileSystem | undefined {
  if (bounds.deadlineAtMs === undefined && !bounds.onProgress && !bounds.preparation) return undefined;
  return {
    async stat(filePath) {
      throwIfCodexExternalSessionInvocationStopped(bounds);
      const metadata = await stat(filePath);
      throwIfCodexExternalSessionInvocationStopped(bounds);
      return metadata;
    },
    async read(filePath, position, length) {
      throwIfCodexExternalSessionInvocationStopped(bounds);
      const handle = await open(filePath, 'r');
      try {
        throwIfCodexExternalSessionInvocationStopped(bounds);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        throwIfCodexExternalSessionInvocationStopped(bounds);
        return buffer.subarray(0, bytesRead);
      } finally { await handle.close(); }
    },
  };
}

/**
 * Runs bounded parallel work for one Codex External Sessions invocation, checking
 * the invocation bounds before and after every unit so an abort or deadline stops
 * new filesystem effects instead of draining the whole input.
 */
export async function mapCodexExternalSessionWorkWithConcurrency<TInput, TOutput>(
  input: readonly TInput[],
  concurrency: number,
  mapper: (item: TInput) => Promise<TOutput>,
  bounds: CodexExternalSessionInvocationBounds,
): Promise<TOutput[]> {
  const limit = Math.max(1, Math.trunc(concurrency));
  const output = new Array<TOutput>(input.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, input.length) }, async () => {
      while (nextIndex < input.length) {
        throwIfCodexExternalSessionInvocationStopped(bounds);
        const index = nextIndex;
        nextIndex += 1;
        output[index] = await mapper(input[index]!);
        throwIfCodexExternalSessionInvocationStopped(bounds);
      }
    }),
  );
  return output;
}
