import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';

import { isPidPresent } from '@happier-dev/cli-common/process';
import {
  reclaimJsonOwnerFileLockSnapshot,
  withJsonOwnerFileLock,
} from '@/utils/fs/jsonOwnerFileLock';

import type { PluginStorePaths } from './paths';

export const MARKETPLACE_SOURCE_REGISTRY_LOCK_NAME = 'marketplace-source-registry.v1.lock';
export const NPM_REGISTRY_PROFILES_LOCK_NAME = 'npm-registry-profiles.v1.lock';
export const NPM_REGISTRY_SECRETS_LOCK_NAME = 'npm-registry-secrets.v1.lock';
export const NPM_REGISTRY_AUTHORITY_LOCK_NAME = 'npm-registry-authority.v1.lock';

type PredecessorPluginStoreLockRecord = Readonly<{
  pid: number;
  createdAtMs: number;
}>;

// Compatibility basis: the pre-consolidation plugin-store writer persisted exactly this shape.
// Remove after supported mixed-version CLIs can no longer leave these records for a newer CLI.
const PredecessorPluginStoreLockStoredReadSchema = createStoredReadSchema(z.strictObject({
  pid: z.number().check(z.int(), z.positive()), createdAtMs: z.number().check(z.int(), z.nonnegative()),
}));

function parsePredecessorPluginStoreLock(raw: string): PredecessorPluginStoreLockRecord | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    // Current owner tokens/generation witnesses are never reinterpreted as a PID-only predecessor.
    if (['ownerToken', 'processStartedAtMs', 'updatedAtMs', 'processWitness'].some(key => Object.hasOwn(record, key))) return null;
    return PredecessorPluginStoreLockStoredReadSchema.parse(record);
  } catch {
    return null;
  }
}

async function waitForPredecessorPluginStoreLock(params: Readonly<{
  lockFilePath: string;
  signal?: AbortSignal;
  errorCode: string;
}>): Promise<void> {
  for (;;) {
    params.signal?.throwIfAborted();
    let raw: string;
    try {
      raw = await readFile(params.lockFilePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return;
      throw error;
    }

    const predecessor = parsePredecessorPluginStoreLock(raw);
    if (!predecessor) return;

    if (!isPidPresent(predecessor.pid)) {
      const reclaimed = await reclaimJsonOwnerFileLockSnapshot(params.lockFilePath, raw);
      if (reclaimed === 'ownership_unknown') {
        throw new Error(`${params.errorCode}_compromised`);
      }
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function withPluginStoreLock<T>(params: Readonly<{
  paths: PluginStorePaths;
  lockName: string;
  signal?: AbortSignal;
  fn: () => Promise<T>;
}>): Promise<T> {
  const lockFilePath = join(params.paths.locksDir, params.lockName);
  const errorCode = `Plugin store lock '${params.lockName}'`;

  await waitForPredecessorPluginStoreLock({
    lockFilePath,
    signal: params.signal,
    errorCode,
  });

  return await withJsonOwnerFileLock({
    lockPath: lockFilePath,
    timeoutMs: Number.POSITIVE_INFINITY,
    // A predecessor can publish after the compatibility read and before canonical publication.
    // Unknown bytes cannot prove a dead owner. Exact current-schema dead owners
    // remain reclaimable through PID/process-start evidence, never elapsed age.
    staleAfterMs: Number.POSITIVE_INFINITY,
    signal: params.signal,
    errorCode,
  }, async () => {
    params.signal?.throwIfAborted();
    return await params.fn();
  });
}
