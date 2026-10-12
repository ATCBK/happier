/** @moduleRealm daemon */
import { join } from 'node:path';

import type { WindowsProtectedAclBoundarySync } from '@happier-dev/cli-common/fs/windowsProtectedAcl';
import { writeSecureFileSync } from '@happier-dev/cli-common/fs/writeSecureFileSync';
import { createHappierTempDir, removeHappierTempDir } from '@happier-dev/cli-common/tempDirs';

export type SecureTempTextFileInputV1 = Readonly<{
  prefix: string;
  suffix?: string;
  contents: string;
  tmpDir?: string | null;
}>;

export type SecureTempDirectoryInputV1 = Readonly<{
  prefix: string;
  tmpDir?: string | null;
}>;

export type SecureTempDirectoryV1 = Readonly<{
  path: string;
  cleanup(): void;
}>;

type SecureTempTextFileDeps = Readonly<{
  platform?: NodeJS.Platform;
  windowsAclBoundary?: WindowsProtectedAclBoundarySync;
}>;

function validatePathToken(value: string, field: 'prefix' | 'suffix'): void {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`Invalid temporary file ${field}`);
  }
}

export function createSecureTempDirectorySyncWithDeps(
  input: SecureTempDirectoryInputV1,
  deps: SecureTempTextFileDeps = {},
): SecureTempDirectoryV1 {
  validatePathToken(input.prefix, 'prefix');
  const directory = createHappierTempDir({
    purpose: input.prefix,
    ...(input.tmpDir == null ? {} : { root: input.tmpDir }),
  }, deps);
  return { path: directory, cleanup: () => removeHappierTempDir(directory) };
}

export function createSecureTempDirectorySync(
  input: SecureTempDirectoryInputV1,
): SecureTempDirectoryV1 {
  return createSecureTempDirectorySyncWithDeps(input);
}

export function writeSecureTempTextFileSyncWithDeps(
  input: SecureTempTextFileInputV1,
  deps: SecureTempTextFileDeps = {},
): string {
  validatePathToken(input.prefix, 'prefix');
  if (input.suffix !== undefined && input.suffix !== '') {
    validatePathToken(input.suffix, 'suffix');
  }

  const tempDirectory = createSecureTempDirectorySyncWithDeps({
    prefix: input.prefix,
    ...(input.tmpDir === undefined ? {} : { tmpDir: input.tmpDir }),
  }, deps);
  const directory = tempDirectory.path;
  const path = join(directory, `payload${input.suffix ?? ''}`);
  try {
    writeSecureFileSync(path, input.contents, deps);
    return path;
  } catch (error) {
    tempDirectory.cleanup();
    throw error;
  }
}

export function writeSecureTempTextFileSync(input: SecureTempTextFileInputV1): string {
  return writeSecureTempTextFileSyncWithDeps(input);
}
