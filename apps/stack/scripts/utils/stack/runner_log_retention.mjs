import { watch } from 'node:fs';
import { open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const DEFAULT_KEEP_COUNT = 8;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const RUNNER_LOG_NAME = /^(?:dev|run)\.(\d+)\.log(?:\.1)?$/;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export async function pruneStackRunnerLogs({
  logsDir,
  preservePaths = [],
  activeLogPath = null,
  keepCount = DEFAULT_KEEP_COUNT,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
} = {}) {
  const byteLimit = positiveInteger(maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  if (activeLogPath) {
    if (dirname(resolve(activeLogPath)) !== resolve(logsDir)
        || !/^(?:dev|run)\.\d+\.log$/.test(basename(activeLogPath))) {
      throw new Error('Active runner log must be a runner file in its stack logs directory');
    }
    // Two 64 MiB segments fit the existing 128 MiB history disk budget. The
    // active segment adds at most 64 MiB (plus writes awaiting the watcher).
    await rotateActiveRunnerLog(activeLogPath, Math.max(1, Math.floor(byteLimit / 2)));
  }
  const preserved = new Set(
    [...preservePaths, activeLogPath]
      .map((path) => String(path ?? '').trim())
      .filter(Boolean)
      .map((path) => resolve(path)),
  );
  const entries = await readdir(logsDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = RUNNER_LOG_NAME.exec(entry.name);
    if (!match) continue;
    const path = resolve(logsDir, entry.name);
    const fileStat = await stat(path).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!fileStat) continue;
    candidates.push({ path, sequence: Number(match[1]), size: fileStat.size });
  }
  candidates.sort((left, right) => right.sequence - left.sequence || left.path.localeCompare(right.path));

  const historyLimit = positiveInteger(keepCount, DEFAULT_KEEP_COUNT);
  let historyCount = 0;
  let historyBytes = 0;
  const keptPaths = [];
  const removedPaths = [];
  for (const candidate of candidates) {
    if (preserved.has(candidate.path)) {
      keptPaths.push(candidate.path);
      continue;
    }
    const fitsBudget = historyBytes + candidate.size <= byteLimit;
    if (historyCount < historyLimit && (fitsBudget || historyCount === 0)) {
      historyCount += 1;
      historyBytes += candidate.size;
      keptPaths.push(candidate.path);
      continue;
    }
    await rm(candidate.path, { force: true });
    removedPaths.push(candidate.path);
  }

  return { keptPaths, removedPaths };
}

async function rotateActiveRunnerLog(logPath, maxBytes) {
  const file = await open(logPath, 'a+');
  try {
    const { size, mode } = await file.stat();
    if (size <= maxBytes) return;
    const tail = Buffer.alloc(maxBytes);
    const { bytesRead } = await file.read(tail, 0, tail.length, size - tail.length);
    await writeFile(`${logPath}.1`, tail.subarray(0, bytesRead), { mode: mode & 0o777 });
    // stdout/stderr are inherited O_APPEND descriptors. Preserve their inode,
    // and tail -f observes truncation without needing to follow a renamed file.
    await file.truncate(0);
    await file.write(`[stack] runner log rotated (previousBytes=${size}, retainedBytes=${bytesRead}, archive=${basename(logPath)}.1)\n`);
  } finally {
    await file.close();
  }
}

/** The runner owns this watcher; closing it does not touch any log or process. */
export function watchStackRunnerLogRetention({ logPath, maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  onError = error => console.warn(`[stack] runner log rotation stopped: ${error.message}`),
} = {}) {
  if (!logPath) return null;
  let closed = false;
  let pending = false;
  let checking = null;
  let watcher;
  const close = () => {
    closed = true;
    watcher.close();
    return checking;
  };
  const check = () => {
    if (closed) return;
    pending = true;
    if (checking) return;
    checking = (async () => {
      while (pending && !closed) {
        pending = false;
        const { size } = await stat(logPath);
        if (size > Math.max(1, Math.floor(positiveInteger(maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES) / 2))) {
          await pruneStackRunnerLogs({ logsDir: dirname(logPath), activeLogPath: logPath, maxTotalBytes });
        }
      }
    })().catch(error => {
      close();
      onError(error);
    }).finally(() => { checking = null; });
  };
  try {
    watcher = watch(logPath, event => {
      if (event === 'rename') { close(); return; }
      check();
    });
  } catch (error) {
    onError(error);
    return null;
  }
  watcher.on('error', error => { close(); onError(error); });
  watcher.unref();
  check();
  return close;
}
