import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { readProcessInstanceFingerprintSync } from '../../processInstance.mjs';
import { resolveSecureFileWindowsAclBoundarySync, writeSecureFileSync, type SecureFileBoundarySync } from '../fs/writeSecureFileSync.js';
import { getHappierTempRoot, getHappierTempDirOwnerPath, validateHappierTempDirPurpose, type HappierTempDirOwnerV1 } from '../../tempDirOwnership.mjs';
export { getHappierTempRoot, getHappierTempDirOwnerPath, readHappierTempDirOwner, readHappierTempDirOwnerLiveness,
  prepareHappierTempDirOwnerCleanup, type HappierTempDirOwnerV1, type HappierTempDirOwnerLiveness } from '../../tempDirOwnership.mjs';

export type HappierTempDirInput = Readonly<{ purpose: string; root?: string }>;

export function removeHappierTempDir(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
  rmSync(getHappierTempDirOwnerPath(directory), { force: true });
}

/** Async runtime callers retain non-blocking recursive cleanup; the SDK keeps its existing sync cleanup. */
export async function removeHappierTempDirAsync(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await rm(getHappierTempDirOwnerPath(directory), { force: true });
}

export function createHappierTempDir(input: HappierTempDirInput, boundary: SecureFileBoundarySync = {}): string {
  validateHappierTempDirPurpose(input.purpose);
  let parent = getHappierTempRoot(input.root);
  const createdParent = mkdirSync(parent, { recursive: true, mode: 0o700 }) !== undefined;
  // A caller-supplied parent may only become resolvable after recursive mkdir.
  parent = getHappierTempRoot(input.root);
  try {
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Happier temporary root must be a directory');
    if ((boundary.platform ?? process.platform) === 'win32') {
      const acl = resolveSecureFileWindowsAclBoundarySync(boundary);
      if (createdParent) acl.applyAndVerify({ path: parent, kind: 'directory' });
      else acl.verify({ path: parent, kind: 'directory' });
    } else {
      if (info.uid !== userInfo().uid) throw new Error('Happier temporary root belongs to another user');
      chmodSync(parent, 0o700);
    }
  } catch (error) {
    if (createdParent) rmSync(parent, { recursive: true, force: true });
    throw error;
  }
  const directory = mkdtempSync(join(parent, `${input.purpose}-`));
  try {
    if ((boundary.platform ?? process.platform) === 'win32') {
      resolveSecureFileWindowsAclBoundarySync(boundary).applyAndVerify({ path: directory, kind: 'directory' });
    } else chmodSync(directory, 0o700);
    const owner: HappierTempDirOwnerV1 = {
      v: 1,
      purpose: input.purpose,
      pid: process.pid,
      processInstanceFingerprint: readProcessInstanceFingerprintSync(process.pid),
    };
    writeSecureFileSync(getHappierTempDirOwnerPath(directory), JSON.stringify(owner), boundary);
    return directory;
  } catch (error) {
    removeHappierTempDir(directory);
    throw error;
  }
}

