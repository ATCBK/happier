import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, unlink } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readProcessInstanceFingerprintSync } from './processInstance.mjs';

export function validateHappierTempDirPurpose(purpose) {
  if (!purpose || purpose === '.' || purpose === '..' || /[/\\\0]/u.test(purpose)) throw new Error('Invalid temporary directory purpose');
}

const namespaceName = suffix => `happier-${suffix}`;
function namespaceRoot(root, suffix) {
  let parent = root;
  try { parent = realpathSync(root); } catch { /* Unavailable parent stays lexical. */ }
  return join(parent, namespaceName(suffix));
}

export function getHappierTempRoot(root = tmpdir()) {
  const user = userInfo();
  const identity = user.uid >= 0 ? String(user.uid) : createHash('sha256').update(user.homedir).digest('hex');
  return namespaceRoot(root, identity);
}

/** Linux maintenance may observe another explicit UID without changing its identity. */
export function getHappierTempRootForUid(root, ownerUid) {
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) throw new Error('Temporary root owner UID unavailable');
  return namespaceRoot(root, String(ownerUid));
}

export function isHappierTempRootForUid(directory, ownerUid) {
  return basename(directory) === namespaceName(String(ownerUid));
}

export function getHappierTempDirOwnerPath(directory) { return `${directory}.owner.json`; }

export function readHappierTempDirOwner(directory) {
  try {
    const path = getHappierTempDirOwnerPath(directory);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || value.v !== 1 || typeof value.purpose !== 'string'
      || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || !(value.processInstanceFingerprint === null
        || (typeof value.processInstanceFingerprint === 'string' && value.processInstanceFingerprint.trim().length > 0))) return null;
    validateHappierTempDirPurpose(value.purpose);
    return { v: 1, purpose: value.purpose, pid: value.pid, processInstanceFingerprint: value.processInstanceFingerprint };
  } catch { return null; }
}

export function readHappierTempDirOwnerForDirectory(directory, ownerUid) {
  const owner = readHappierTempDirOwner(directory);
  if (!owner || !basename(directory).startsWith(`${owner.purpose}-`)
    // Trash's no-overwrite Put back beside it retains the generated name and
    // appends this suffix; it does not create a new process-ownership witness.
    || !/^[a-zA-Z0-9]{6}(?: \(restored\))*$/u.test(basename(directory).slice(owner.purpose.length + 1))) return null;
  const parent = dirname(directory);
  try {
    const expected = ownerUid === undefined ? getHappierTempRoot(dirname(parent)) : getHappierTempRootForUid(dirname(parent), ownerUid);
    return parent === expected ? owner : null;
  } catch { return null; }
}

/** Capture before removal; cleanup grants no directory-removal authority. */
export function prepareHappierTempDirOwnerCleanup(directory, ownerUid, retainMarker) {
  const nothing = async () => {};
  const marker = getHappierTempDirOwnerPath(directory);
  const owner = readHappierTempDirOwnerForDirectory(directory, ownerUid);
  if (!owner) return nothing;
  let identity;
  try {
    identity = lstatSync(marker, { bigint: true });
    if (!identity.isFile() || identity.isSymbolicLink()
      || JSON.stringify(readHappierTempDirOwner(directory)) !== JSON.stringify(owner)) return nothing;
  } catch { return nothing; }
  return async () => {
    try { await lstat(directory); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      const current = await lstat(marker, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
        || JSON.stringify(readHappierTempDirOwner(directory)) !== JSON.stringify(owner)) return;
      if (retainMarker) await retainMarker(marker, { dev: String(current.dev), ino: String(current.ino) });
      else await unlink(marker);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}

export function readHappierTempDirOwnerLiveness(owner) {
  if (!owner.processInstanceFingerprint) return 'unknown';
  const fingerprint = readProcessInstanceFingerprintSync(owner.pid, { expectedFingerprint: owner.processInstanceFingerprint });
  if (fingerprint !== null) return fingerprint === owner.processInstanceFingerprint ? 'alive' : 'gone';
  try { process.kill(owner.pid, 0); }
  catch (error) { if (error && typeof error === 'object' && error.code === 'ESRCH') return 'gone'; }
  return 'unknown';
}
