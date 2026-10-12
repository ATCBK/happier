import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Approved historical sweep: legitimate builds run <=3h and watchers <=2h.
// A full day is the explicit margin, not an admission or execution deadline.
const historicalAgeMs = 24 * 60 * 60 * 1000;
const knownRoot = /^(?:happier-|hstack-|docs-check-|yarn--)/;
const identity = info => `${info.dev}:${info.ino}`;

function inspectTree(path, countedInodes = new Set()) {
  const info = lstatSync(path);
  let newestMtimeMs = info.mtimeMs;
  const key = identity(info);
  let bytes = countedInodes.has(key) ? 0 : info.blocks * 512;
  countedInodes.add(key);
  const identities = new Set([key]);
  if (info.isDirectory()) {
    for (const name of readdirSync(path)) {
      const child = inspectTree(join(path, name), countedInodes);
      newestMtimeMs = Math.max(newestMtimeMs, child.newestMtimeMs);
      bytes += child.bytes;
      for (const key of child.identities) identities.add(key);
    }
  }
  // lstat avoids traversing symlinks outside the reclaimable root.
  return { info, newestMtimeMs, bytes, identities };
}

function processReferences(procRoot, ownerUid) {
  const paths = [], identities = new Set();
  for (const pid of readdirSync(procRoot).filter(name => /^\d+$/.test(name))) {
    const processRoot = join(procRoot, pid);
    try {
      const status = readFileSync(join(processRoot, 'status'), 'utf8');
      // Procfs inode ownership changes with dumpability; status owns actual
      // process UIDs. Skip only known foreign users, not unknown visibility.
      const uids = /^Uid:[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]*$/m.exec(status);
      if (uids && !uids.slice(1).some(uid => Number(uid) === ownerUid)) continue;
      if (/^State:\s+Z/m.test(status) || /^Kthread:\s+1/m.test(status)) continue;
      const observe = (path, read, command, decode = value => value) => {
        try { return read(); }
        catch (error) {
          // Nondumpable same-UID processes (including SSH sessions) still hold
          // real references. Never exempt them by name. The kernel permits a
          // privileged read; use only existing noninteractive OS authorization,
          // for this known UID's proc entries, and keep all mutation unprivileged.
          if (!['EACCES', 'EPERM'].includes(error.code) || procRoot !== '/proc'
            || ownerUid !== process.getuid() || !uids?.slice(1).some(uid => Number(uid) === ownerUid)) throw error;
          const result = spawnSync('sudo', ['-n', '--', ...command], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity,
          });
          // Neither environment bytes nor sudo output belong in diagnostics.
          if (result.error || result.status !== 0) throw error;
          return decode(result.stdout);
        }
      };
      const readText = path => observe(path, () => readFileSync(path, 'utf8'), ['/usr/bin/cat', '--', path]);
      const readLink = path => observe(path, () => readlinkSync(path), ['/usr/bin/readlink', '--zero', '--', path], value => {
        if (!value.endsWith('\0')) throw new Error('invalid privileged proc link observation');
        return value.slice(0, -1);
      });
      const readDirectory = path => observe(path, () => readdirSync(path),
        ['/usr/bin/find', path, '-mindepth', '1', '-maxdepth', '1', '-printf', '%f\\0'], value => value.split('\0').filter(Boolean));
      const readIdentity = path => observe(path, () => identity(statSync(path)), ['/usr/bin/stat', '-L', '-c', '%d:%i', '--', path], value => {
        const key = value.trim();
        if (!/^\d+:\d+$/.test(key)) throw new Error('invalid privileged proc inode observation');
        return key;
      });
      const addPath = path => {
        paths.push(path.replace(/ \(deleted\)$/, ''));
        try { identities.add(identity(statSync(path))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
      // Detached children can inherit scratch before opening a file in it.
      // Observe only the explicit non-secret temp bindings, never emit env.
      for (const binding of readText(join(processRoot, 'environ')).split('\0')) {
        if (binding.startsWith('TMPDIR=/')) addPath(binding.slice('TMPDIR='.length));
        if (binding.startsWith('HAPPIER_TEST_TEMP_ROOTS=')) {
          for (const path of binding.slice('HAPPIER_TEST_TEMP_ROOTS='.length).split('\n')) {
            if (path.startsWith('/')) addPath(path);
          }
        }
      }
      for (const link of [join(processRoot, 'cwd'), ...readDirectory(join(processRoot, 'fd')).map(fd => join(processRoot, 'fd', fd))]) {
        try {
          addPath(readLink(link));
          identities.add(readIdentity(link));
        } catch (error) {
          // A descriptor may close during inspection. Missing cwd for a live
          // userspace process is unknown, not proof that it owns no root.
          if (error.code !== 'ENOENT' || link.endsWith('/cwd')) throw error;
        }
      }
      for (const line of readText(join(processRoot, 'maps')).split('\n')) {
        const path = /^\S+(?:\s+\S+){4}\s+(\/.*)$/.exec(line)?.[1];
        if (path) addPath(path.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))));
      }
    } catch (error) {
      if (!existsSync(processRoot)) continue; // exited while being observed
      throw new Error(`live process ${pid} references unavailable (${error.code ?? error.message})`);
    }
  }
  return { paths, identities };
}

function hasUser(directory, tree, references) {
  return references.paths.some(path => path === directory || path.startsWith(directory + sep))
    || [...tree.identities].some(key => references.identities.has(key));
}

export function reapHistoricalTempRoots(tempParent, procRoot = '/proc', {
  candidateNames, ownerUid = process.getuid(), minimumAgeMs = historicalAgeMs,
} = {}) {
  const result = { reclaimedBytes: 0, reclaimedRoots: 0, retainedRoots: 0, observationUnavailable: null };
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
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.uid !== ownerUid || info.mtimeMs >= cutoff) continue;
      const tree = inspectTree(directory);
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
      const current = inspectTree(directory);
      if (identity(current.info) !== identity(tree.info) || current.newestMtimeMs >= cutoff
        || hasUser(directory, current, processReferences(procRoot, ownerUid))) {
        result.retainedRoots++;
        continue;
      }
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
  console.error(JSON.stringify(reapHistoricalTempRoots(process.argv[2])));
}
