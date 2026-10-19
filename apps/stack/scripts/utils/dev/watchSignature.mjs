import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { isWorkspaceBuildInputIgnoredPath } from '../fs/workspaceBuildInputs.mjs';

import {
  forgetCachedFileDigest,
  readCachedFileDigest,
  readCachedFileDigestSync,
} from '../fs/cached_file_digest.mjs';

const RELOAD_ONLY_DIRECTORY_NAMES = new Set([
  '__snapshots__',
  'coverage',
  'snapshots',
]);
const BENCHMARK_FILE_RE = /(?:^|[._-])(?:bench|benchmark)\.[cm]?[jt]sx?$/;

// The coordinator owns the lifetime. Finite fingerprint readers in the same
// stack process consume these observations without creating another watcher.
const sourceObservers = new Set();
function containsPath(root, path) {
  const suffix = relative(root, path);
  return !suffix || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

async function observeSourcePath(path) {
  let stats;
  try { stats = await lstat(path, { bigint: true }); } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    forgetCachedFileDigest(path);
    return null;
  }
  return {
    stats,
    names: stats.isDirectory() ? (await readdir(path).catch(() => [])).sort() : null,
    link: stats.isSymbolicLink() ? await readlink(path) : null,
  };
}

export async function readWatchSourcePath(path) {
  const absolutePath = resolve(path);
  for (const observer of sourceObservers) {
    if (observer.contains(absolutePath)) return await observer.read(absolutePath);
  }
  return await observeSourcePath(path);
}

export function createWatchSourceObserver(paths) {
  const roots = new Set(paths.map(path => resolve(path)));
  const observations = new Map();
  const directories = new Set();
  const invalidate = path => {
    // A native event is authoritative even when the filesystem clock did not advance.
    forgetCachedFileDigest(path);
    observations.delete(path);
    if (directories.has(path)) {
      for (const cached of observations.keys()) if (containsPath(path, cached)) {
        forgetCachedFileDigest(cached);
        observations.delete(cached);
      }
    }
  };
  const observer = {
    contains(path) {
      for (let current = path; ; current = dirname(current)) {
        if (roots.has(current)) return true;
        if (dirname(current) === current) return false;
      }
    },
    hasObservations: () => observations.size > 0,
    read(path) {
      let observation = observations.get(path);
      if (!observation) {
        observation = observeSourcePath(path).then(result => {
          if (result?.stats.isDirectory()) directories.add(path);
          else directories.delete(path);
          return result;
        });
        observations.set(path, observation);
        // A failed read must be retried rather than poisoning the lifetime.
        void observation.catch(() => { if (observations.get(path) === observation) observations.delete(path); });
      }
      return observation;
    },
    observe(event) {
      if (!event?.watchPath || event.filename == null || event.eventType === 'recrawl') {
        for (const path of observations.keys()) forgetCachedFileDigest(path);
        observations.clear();
        return;
      }
      const watchPath = resolve(event.watchPath);
      const path = directories.has(watchPath) ? resolve(watchPath, String(event.filename)) : watchPath;
      invalidate(path);
      // Renames add/remove children; retained sibling subtrees remain valid.
      if (event.eventType === 'rename') observations.delete(dirname(path));
    },
    async reconcile() {
      // Check known metadata, not a recursive walk: no getdents or content reads
      // for unchanged inputs. Await each stat so recovery never fans out a storm.
      for (const [path, pending] of [...observations]) {
        if (observations.get(path) !== pending) continue;
        const before = await pending;
        let after;
        try { after = await lstat(path, { bigint: true }); } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
          after = null;
        }
        const fields = ['ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'];
        if (fields.some(field => before?.stats?.[field] !== after?.[field])) invalidate(path);
      }
    },
    close() { sourceObservers.delete(observer); observations.clear(); },
  };
  sourceObservers.add(observer);
  return observer;
}

export function isDevRuntimeReloadIgnoredPath(path) {
  const normalized = String(path ?? '').replaceAll('\\', '/');
  if (!normalized) return false;
  if (isWorkspaceBuildInputIgnoredPath(normalized)) return true;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => RELOAD_ONLY_DIRECTORY_NAMES.has(part))) return true;
  if (parts.some((part) => /^\.(?:.*[-.])?(?:scratch|tmp|temp)(?:[-.]|$)/.test(part))) return true;
  const base = parts.at(-1) ?? '';
  return (
    BENCHMARK_FILE_RE.test(base)
    || base.endsWith('.snap')
  );
}

export function appendWatchSignatureEntries(path, entries, { ignorePath = isDevRuntimeReloadIgnoredPath, portableSymlinks = false } = {}) {
  if (typeof ignorePath === 'function' && ignorePath(path)) return false;
  let stats;
  try {
    stats = lstatSync(path, { bigint: true });
  } catch {
    forgetCachedFileDigest(path);
    entries.push(`${path}\0missing`);
    return false;
  }

  if (stats.isDirectory()) {
    entries.push(`${path}\0dir`);
    let names = [];
    try {
      names = readdirSync(path, { withFileTypes: true })
        .map((entry) => entry.name)
        .sort();
    } catch {
      return true;
    }
    for (const name of names) {
      appendWatchSignatureEntries(join(path, name), entries, { ignorePath, portableSymlinks });
    }
    return true;
  }

  if (stats.isFile()) {
    entries.push(`${path}\0file\0${stats.size}\0${readCachedFileDigestSync(path, stats)}`);
    return true;
  }

  if (stats.isSymbolicLink()) {
    entries.push(portableSymlinks ? `${path}\0symlink\0${readlinkSync(path)}` : `${path}\0symlink\0${stats.size}\0${stats.mtimeNs}\0${stats.ctimeNs}`);
    return true;
  }

  entries.push(`${path}\0other\0${stats.mtimeNs}`);
  return true;
}

export function readDevReloadWatchChangeSignature(paths, { ignorePath = isDevRuntimeReloadIgnoredPath, portableSymlinks = false } = {}) {
  const entries = [];
  let observed = false;
  for (const path of paths) {
    observed = appendWatchSignatureEntries(path, entries, { ignorePath, portableSymlinks }) || observed;
  }
  return observed ? entries.join('\n') : null;
}

export async function appendWatchSignatureEntriesAsync(path, entries, { ignorePath = isDevRuntimeReloadIgnoredPath, portableSymlinks = false } = {}) {
  if (typeof ignorePath === 'function' && ignorePath(path)) return false;
  let stats;
  let observation;
  try {
    observation = await readWatchSourcePath(path);
    stats = observation?.stats;
    if (!stats) throw Object.assign(new Error('missing source input'), { code: 'ENOENT' });
  } catch {
    forgetCachedFileDigest(path);
    entries.push(`${path}\0missing`);
    return false;
  }

  if (stats.isDirectory()) {
    entries.push(`${path}\0dir`);
    for (const name of observation.names) {
      await appendWatchSignatureEntriesAsync(join(path, name), entries, { ignorePath, portableSymlinks });
    }
    return true;
  }

  if (stats.isFile()) {
    entries.push(`${path}\0file\0${stats.size}\0${await readCachedFileDigest(path, stats)}`);
    return true;
  }

  if (stats.isSymbolicLink()) {
    entries.push(portableSymlinks ? `${path}\0symlink\0${observation.link}` : `${path}\0symlink\0${stats.size}\0${stats.mtimeNs}\0${stats.ctimeNs}`);
    return true;
  }

  entries.push(`${path}\0other\0${stats.mtimeNs}`);
  return true;
}

export async function readDevReloadWatchChangeSignatureAsync(paths, {
  ignorePath = isDevRuntimeReloadIgnoredPath,
  portableSymlinks = false,
  pathSamples = new Map(),
} = {}) {
  const entries = [];
  let observed = false;
  for (const path of paths) {
    // Reload and runtime-publication descriptors share both this projection and
    // the coordinator's event-indexed filesystem observations.
    let sample = pathSamples.get(path);
    if (!sample) {
      sample = (async () => {
        const pathEntries = [];
        const pathObserved = await appendWatchSignatureEntriesAsync(path, pathEntries, { ignorePath, portableSymlinks });
        return { entries: pathEntries, observed: pathObserved };
      })();
      pathSamples.set(path, sample);
    }
    const result = await sample;
    for (const entry of result.entries) entries.push(entry);
    observed = result.observed || observed;
  }
  return observed ? entries.join('\n') : null;
}
