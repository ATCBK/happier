import { chmodSync, closeSync, fsyncSync, openSync, rmSync, writeFileSync } from 'node:fs';

import { createWindowsProtectedAclBoundarySync, type WindowsProtectedAclBoundarySync } from './windowsProtectedAcl.js';

export type SecureFileBoundarySync = Readonly<{
  platform?: NodeJS.Platform;
  windowsAclBoundary?: WindowsProtectedAclBoundarySync;
}>;

let windowsAclBoundary: WindowsProtectedAclBoundarySync | undefined;

export function resolveSecureFileWindowsAclBoundarySync(boundary: SecureFileBoundarySync = {}): WindowsProtectedAclBoundarySync {
  return boundary.windowsAclBoundary ?? (windowsAclBoundary ??= createWindowsProtectedAclBoundarySync());
}

/** Creates an exclusive private file; Windows protection is verified before any contents are written. */
export function writeSecureFileSync(path: string, contents: string, boundary: SecureFileBoundarySync = {}): void {
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    created = true;
    const windows = (boundary.platform ?? process.platform) === 'win32';
    if (windows) resolveSecureFileWindowsAclBoundarySync(boundary).applyAndVerify({ path, kind: 'file' });
    else chmodSync(path, 0o600);
    writeFileSync(descriptor, contents, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (windows) resolveSecureFileWindowsAclBoundarySync(boundary).verify({ path, kind: 'file' });
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Preserve the protection/write failure. */ }
    }
    if (created) rmSync(path, { force: true });
    throw error;
  }
}
