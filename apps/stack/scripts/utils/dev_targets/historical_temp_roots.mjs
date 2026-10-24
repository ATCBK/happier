import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isHappierTempRootForUid, readHappierTempDirOwnerForDirectory, readHappierTempDirOwnerLiveness } from '../../../../../packages/cli-common/tempDirOwnership.mjs';

// Approved historical sweep: legitimate builds run <=3h and watchers <=2h.
// A full day is the explicit margin, not an admission or execution deadline.
const historicalAgeMs = 24 * 60 * 60 * 1000;
const knownRoot = /^(?:happier-|hstack-|docs-check-|yarn--)/;
const identity = info => `${info.dev}:${info.ino}`;

function inspectTree(path, countedInodes = new Set(), ownerUid = process.getuid()) {
  const info = lstatSync(path);
  let newestMtimeMs = info.mtimeMs;
  const key = identity(info);
  let bytes = countedInodes.has(key) ? 0 : info.blocks * 512;
  countedInodes.add(key);
  const identities = new Set([key]);
  let ownedRootActive = false;
  if (info.isDirectory()) {
    if (isHappierTempRootForUid(dirname(path), ownerUid)) {
      const owner = readHappierTempDirOwnerForDirectory(path, ownerUid);
      ownedRootActive = !owner || readHappierTempDirOwnerLiveness(owner) !== 'gone';
    }
    for (const name of readdirSync(path)) {
      const child = inspectTree(join(path, name), countedInodes, ownerUid);
      newestMtimeMs = Math.max(newestMtimeMs, child.newestMtimeMs);
      bytes += child.bytes;
      for (const key of child.identities) identities.add(key);
      ownedRootActive ||= child.ownedRootActive;
    }
  }
  // lstat avoids traversing symlinks outside the reclaimable root.
  return { info, newestMtimeMs, bytes, identities, ownedRootActive };
}

function collectProcessReferences(procRoot, ownerUid, { bindingsOnly = false, processIds } = {}) {
  const paths = [], identities = new Set();
  for (const pid of processIds ?? readdirSync(procRoot).filter(name => /^\d+$/.test(name))) {
    const processRoot = join(procRoot, pid);
    let matchingOwnerUid = false;
    try {
      const status = readFileSync(join(processRoot, 'status'), 'utf8');
      // Procfs inode ownership changes with dumpability; status owns actual
      // process UIDs. Skip only known foreign users, not unknown visibility.
      const uids = /^Uid:[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]*$/m.exec(status);
      matchingOwnerUid = uids?.slice(1).some(uid => Number(uid) === ownerUid) === true;
      if (uids && !uids.slice(1).some(uid => Number(uid) === ownerUid)) continue;
      if (/^State:\s+Z/m.test(status) || /^Kthread:\s+1/m.test(status)) continue;
      const addPath = path => {
        paths.push(path.replace(/ \(deleted\)$/, ''));
        if (bindingsOnly) return;
        try { identities.add(identity(statSync(path))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
      // Detached children can inherit scratch before opening a file in it.
      // Observe only the explicit non-secret temp bindings, never emit env.
      for (const binding of readFileSync(join(processRoot, 'environ'), 'utf8').split('\0')) {
        if (binding.startsWith('TMPDIR=/')) addPath(binding.slice('TMPDIR='.length));
        if (binding.startsWith('HAPPIER_TEST_TEMP_ROOTS=')) {
          for (const path of binding.slice('HAPPIER_TEST_TEMP_ROOTS='.length).split('\n')) {
            if (path.startsWith('/')) addPath(path);
          }
        }
      }
      if (bindingsOnly) continue;
      for (const link of [join(processRoot, 'cwd'), ...readdirSync(join(processRoot, 'fd')).map(fd => join(processRoot, 'fd', fd))]) {
        try {
          addPath(readlinkSync(link));
          identities.add(identity(statSync(link)));
        } catch (error) {
          // A descriptor may close during inspection. Missing cwd for a live
          // userspace process is unknown, not proof that it owns no root.
          if (error.code !== 'ENOENT' || link.endsWith('/cwd')) throw error;
        }
      }
      for (const line of readFileSync(join(processRoot, 'maps'), 'utf8').split('\n')) {
        const path = /^\S+(?:\s+\S+){4}\s+(\/.*)$/.exec(line)?.[1];
        if (path) addPath(path.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))));
      }
    } catch (error) {
      if (!existsSync(processRoot)) continue; // exited while being observed
      const unavailable = new Error(`live process ${pid} references unavailable (${error.code ?? error.message})`);
      unavailable.canRetryPrivilegedReferences = matchingOwnerUid && ['EACCES', 'EPERM'].includes(error.code);
      throw unavailable;
    }
  }
  return { paths, identities };
}

function processReferences(procRoot, ownerUid, { bindingsOnly = false, processIds } = {}) {
  try { return collectProcessReferences(procRoot, ownerUid, { bindingsOnly, processIds }); }
  catch (error) {
    // Nondumpable same-UID processes still hold real references. Acquire one
    // complete read-only observation with existing noninteractive authorization,
    // reusing this collector instead of spawning sudo for every proc entry.
    // Unknown UID/visibility remains closed, and deletion keeps the caller's UID.
    if (!error.canRetryPrivilegedReferences || procRoot !== '/proc' || ownerUid !== process.getuid()) throw error;
    const result = spawnSync('sudo', ['-n', '--', process.execPath, fileURLToPath(import.meta.url),
      bindingsOnly ? '--observe-temp-bindings' : '--observe-process-references', String(ownerUid)], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: Infinity,
      input: processIds === undefined ? '' : JSON.stringify(processIds),
    });
    if (result.error || result.status !== 0) throw error;
    // Only paths, inode identities and explicitly selected non-secret temp
    // bindings leave the collector. Never log its output or environment bytes.
    try {
      const references = JSON.parse(result.stdout);
      if (!references || Object.keys(references).sort().join(',') !== 'identities,paths'
        || !Array.isArray(references.paths) || !references.paths.every(path => typeof path === 'string')
        || !Array.isArray(references.identities) || !references.identities.every(key => typeof key === 'string' && /^\d+:\d+$/.test(key))) throw error;
      return { paths: references.paths, identities: new Set(references.identities) };
    } catch { throw error; }
  }
}

function hasUser(directory, tree, references) {
  return references.paths.some(path => path === directory || path.startsWith(directory + sep))
    || [...tree.identities].some(key => references.identities.has(key));
}

export function reapHistoricalTempRoots(tempParent, procRoot = '/proc', {
  candidateNames, ownerUid = process.getuid(), minimumAgeMs = historicalAgeMs, dryRun = false, retainCandidate,
} = {}) {
  const result = { reclaimedBytes: 0, reclaimedRoots: 0, retainedRoots: 0, observationUnavailable: null,
    reclaimableBytes: 0, reclaimableRoots: 0 };
  const parent = realpathSync(tempParent);
  const cutoff = Date.now() - minimumAgeMs;
  const candidates = [];
  const isChildName = name => typeof name === 'string' && name && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
  const names = candidateNames ?? readdirSync(parent).filter(name => {
    if (!knownRoot.test(name)) return false;
    if (isChildName(name)) return true;
    result.retainedRoots++;
    return false;
  });
  // Lifecycle owners may nominate exact regenerable staging children. Never
  // let a nominated name escape its owning parent or become a broad root.
  if (names.some(name => !isChildName(name))) {
    throw new Error('historical cleanup candidate must be a direct child name');
  }
  for (const name of names) {
    const directory = join(parent, name);
    try {
      // A shared SDK namespace is never a historical job root. Its creators'
      // markers own lifetime, including live JS-only publication references.
      if (isHappierTempRootForUid(directory, ownerUid)) { result.retainedRoots++; continue; }
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.uid !== ownerUid || info.mtimeMs >= cutoff) continue;
      const tree = inspectTree(directory, new Set(), ownerUid);
      if (tree.ownedRootActive) { result.retainedRoots++; continue; }
      if (tree.newestMtimeMs < cutoff) candidates.push({ directory, tree });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      result.retainedRoots++;
      console.error(`[preferred-execution] retaining historical temporary root ${directory}: ${error.code ?? error.message}`);
    }
  }
  if (!candidates.length) return result;
  let references;
  try { references = processReferences(procRoot, ownerUid); }
  catch (error) {
    result.retainedRoots += candidates.length;
    result.observationUnavailable = error.message;
    console.error(`[preferred-execution] historical temporary sweep retained ${candidates.length} roots: ${error.message}`);
    return result;
  }
  for (const { directory, tree } of candidates) {
    try {
      if (hasUser(directory, tree, references)) { result.retainedRoots++; continue; }
      // Recheck both mutation and live use immediately before deletion. A
      // replacement inode never inherits this candidate's deletion authority.
      const current = inspectTree(directory, new Set(), ownerUid);
      if (identity(current.info) !== identity(tree.info) || current.newestMtimeMs >= cutoff || current.ownedRootActive
        || hasUser(directory, current, processReferences(procRoot, ownerUid)) || retainCandidate?.(directory)) {
        result.retainedRoots++;
        continue;
      }
      result.reclaimableRoots++;
      result.reclaimableBytes += current.bytes;
      if (dryRun) continue;
      rmSync(directory, { recursive: true });
      result.reclaimedRoots++;
      result.reclaimedBytes += current.bytes;
      console.error(`[preferred-execution] reclaimed historical temporary root ${directory} (${current.bytes} allocated bytes)`);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      result.retainedRoots++;
      console.error(`[preferred-execution] retaining historical temporary root ${directory}: ${error.code ?? error.message}`);
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--test-temp-users') {
    try {
      // Reuse the native custody census. The observer is born after this
      // snapshot and never becomes a consumer merely by inheriting bindings.
      const processIds = process.argv.includes('--census') ? readFileSync(0, 'utf8').split('\n').filter(line => line.trim()).map(line => {
        const match = /^(\d+)\s+\d+\s+\S+\s+\d+$/.exec(line.trim());
        if (!match) throw new Error('process custody census unavailable');
        return match[1];
      }) : undefined;
      if (processIds?.length === 0) throw new Error('process custody census unavailable');
      const references = processReferences('/proc', process.getuid(), { bindingsOnly: true, processIds });
      const users = new Set();
      for (const path of references.paths) {
        // Native cleanup consumers match exact roots; a binding below a root
        // retains its ancestors too. Never emit unrelated environment values.
        for (let directory = path; ; directory = dirname(directory)) {
          if (!/[\r\n]/.test(directory)) users.add(directory);
          if (dirname(directory) === directory) break;
        }
      }
      process.stdout.write([...users].join('\n') + '\n');
    } catch (error) {
      console.error(`[preferred-execution] temporary custody observation unavailable: ${error.message}`);
      process.exitCode = 2;
    }
  } else if (['--observe-process-references', '--observe-temp-bindings'].includes(process.argv[2])) {
    const ownerUid = Number(process.argv[3]);
    if (process.argv.length !== 4 || !Number.isSafeInteger(ownerUid) || ownerUid < 0) throw new Error('process reference owner UID unavailable');
    const bindingsOnly = process.argv[2] === '--observe-temp-bindings';
    const request = bindingsOnly ? readFileSync(0, 'utf8').trim() : '';
    const processIds = request ? JSON.parse(request) : undefined;
    if (processIds !== undefined && (!Array.isArray(processIds) || !processIds.length
      || !processIds.every(pid => typeof pid === 'string' && /^\d+$/.test(pid)))) throw new Error('process custody census unavailable');
    const references = collectProcessReferences('/proc', ownerUid, { bindingsOnly, processIds });
    process.stdout.write(JSON.stringify({ paths: references.paths, identities: [...references.identities] }) + '\n');
  } else console.error(JSON.stringify(reapHistoricalTempRoots(process.argv[2])));
}
