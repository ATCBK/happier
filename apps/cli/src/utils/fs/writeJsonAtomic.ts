/**
 * Atomic file writer
 *
 * Used for replacing durable files so consumers never read partially-written content.
 */

import { mkdir, rename, unlink, writeFile, chmod, open, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const WINDOWS_RENAME_MAX_ATTEMPTS = 5;
const WINDOWS_RENAME_RETRY_DELAY_MS = 10;

async function bestEffortChmod0600(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(path, 0o600).catch(() => {});
}

function isRetryableWindowsRenameError(error: unknown): boolean {
  if (process.platform !== 'win32') return false;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EBUSY' || code === 'EEXIST' || code === 'EPERM';
}

async function renameWithWindowsRetries(
  sourcePath: string,
  destinationPath: string,
  beforeAttempt?: () => void,
  prepareAttempt?: () => Promise<void>,
): Promise<void> {
  for (let attempt = 1; attempt <= WINDOWS_RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      if (prepareAttempt) await prepareAttempt();
      beforeAttempt?.();
      await rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (!isRetryableWindowsRenameError(error) || attempt === WINDOWS_RENAME_MAX_ATTEMPTS) {
        throw error;
      }
      await delay(WINDOWS_RENAME_RETRY_DELAY_MS * attempt);
    }
  }
}

export async function writeFileAtomically(input: Readonly<{
  path: string;
  writeTemporaryFile: (temporaryPath: string) => Promise<void>;
  /** Synchronous currentness fence immediately before the final rename. */
  beforeCommit?: () => void;
  /** Await caller authority after staging, before the synchronous publication fence. */
  prepareCommit?: () => Promise<void>;
  /** Workspace replacements retain permission bits; durable private stores stay 0600. */
  mode?: 'preserve';
  /** Flush staged bytes before the currentness fence and publication. */
  fsync?: boolean;
}>): Promise<void> {
  const path = input.path;
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  try {
    await input.writeTemporaryFile(tmpPath);
    // Acquire the writable descriptor before retaining a read-only destination mode.
    const staged = input.fsync ? await open(tmpPath, 'r+') : null;
    try {
      if (input.mode === 'preserve') {
        const destination = await stat(path).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
          throw error;
        });
        if (destination && process.platform !== 'win32') await chmod(tmpPath, destination.mode & 0o7777);
      } else {
        await bestEffortChmod0600(tmpPath);
      }
      await staged?.sync();
    } finally {
      await staged?.close();
    }
    await renameWithWindowsRetries(tmpPath, path, input.beforeCommit, input.prepareCommit);
    if (input.mode !== 'preserve') await bestEffortChmod0600(path);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

export async function writeBytesAtomic(path: string, value: Uint8Array): Promise<void> {
  await writeFileAtomically({
    path,
    writeTemporaryFile: async (temporaryPath) => {
      await writeFile(temporaryPath, value, { mode: 0o600 });
    },
  });
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomically({
    path,
    writeTemporaryFile: async (temporaryPath) => {
      await writeFile(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    },
  });
}
