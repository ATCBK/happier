import { createHash } from 'node:crypto';
import { appendFile, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

import type { AgentConnectedAccountSharedStateFileMergeV1 } from '@happier-dev/plugin-sdk/agents/runtime';

export type ConnectedServiceSessionFileImportDetail = Readonly<{
  sourcePath: string;
  destinationPath: string;
  relativePath: string;
  action: 'imported' | 'skipped_identical' | 'conflicted';
}>;

export type ConnectedServiceSessionFileImportRoot = Readonly<{
  sourceRoot: string;
  destinationRoot: string;
  includeFile?: (relativePath: string) => boolean;
  mergeSharedStateFile?: AgentConnectedAccountSharedStateFileMergeV1;
}>;

export type ConnectedServiceSessionFileImportResult = Readonly<{
  imported: number;
  skippedIdentical: number;
  conflicted: number;
  details: readonly ConnectedServiceSessionFileImportDetail[];
}>;

export async function importConnectedServiceSessionFiles(params: Readonly<{
  roots: readonly ConnectedServiceSessionFileImportRoot[];
}>): Promise<ConnectedServiceSessionFileImportResult> {
  const details: ConnectedServiceSessionFileImportDetail[] = [];
  for (const root of params.roots) {
    const sourceRoot = resolve(root.sourceRoot);
    const destinationRoot = resolve(root.destinationRoot);
    // Compare PHYSICAL roots: a destination symlinked into the source store (e.g. a shared-mode
    // staged home whose `projects` links to the shared store) is the same root even though the
    // lexical paths differ. Importing a store onto itself would hash every file twice for nothing
    // and, if a live session appends between the two reads, mint a conflict copy of a file onto
    // itself inside the shared store. The physical paths are used only for this guard; emitted
    // details keep the caller-provided (lexically resolved) paths.
    const [physicalSourceRoot, physicalDestinationRoot] = await Promise.all([
      resolvePhysicalRoot(sourceRoot),
      resolvePhysicalRoot(destinationRoot),
    ]);
    if (physicalSourceRoot === physicalDestinationRoot) continue;
    for (const sourcePath of await listImportableFiles(sourceRoot)) {
      const relativePath = normalizeRelativePath(relative(sourceRoot, sourcePath));
      if (!isSafeRelativePath(relativePath)) continue;
      if (root.includeFile && !root.includeFile(relativePath)) continue;
      const detail = await importSessionFile({
        sourcePath,
        destinationPath: join(destinationRoot, ...relativePath.split('/')),
        relativePath,
        mergeSharedStateFile: root.mergeSharedStateFile,
      });
      if (detail) {
        details.push(detail);
      }
    }
  }
  return {
    imported: details.filter((detail) => detail.action === 'imported').length,
    skippedIdentical: details.filter((detail) => detail.action === 'skipped_identical').length,
    conflicted: details.filter((detail) => detail.action === 'conflicted').length,
    details,
  };
}

async function listImportableFiles(root: string): Promise<readonly string[]> {
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return [];
    throw error;
  }
  if (!rootStat.isDirectory()) return [];
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (!dir) break;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

/**
 * Resolves a root to its physical path. When the path does not exist yet (a destination root is
 * commonly created lazily), the deepest existing ancestor is realpath'd and the missing remainder
 * re-joined, so symlinked ancestors still resolve. Falls back to the lexical resolve on any
 * non-ENOENT failure.
 */
async function resolvePhysicalRoot(path: string): Promise<string> {
  const lexical = resolve(path);
  let current = lexical;
  const pendingSegments: string[] = [];
  while (true) {
    try {
      const physical = await realpath(current);
      return pendingSegments.length > 0 ? join(physical, ...pendingSegments) : physical;
    } catch (error) {
      if (!isEnoentError(error)) return lexical;
      const parent = dirname(current);
      if (parent === current) return lexical;
      pendingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/');
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('\\')) return false;
  return !path.split('/').includes('..');
}

function isEnoentError(error: unknown): error is NodeJS.ErrnoException {
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: unknown }).code === 'ENOENT';
}

async function importSessionFile(params: Readonly<{
  sourcePath: string;
  destinationPath: string;
  relativePath: string;
  mergeSharedStateFile?: AgentConnectedAccountSharedStateFileMergeV1;
}>): Promise<ConnectedServiceSessionFileImportDetail | null> {
  let incomingContents: Buffer;
  try {
    incomingContents = await readFile(params.sourcePath);
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }
    throw error;
  }
  const sourceHash = createHash('sha256').update(incomingContents).digest('hex');
  let currentContents: Buffer | null = null;
  if (params.mergeSharedStateFile) {
    try {
      currentContents = await readFile(params.destinationPath);
    } catch (error) {
      if (!isEnoentError(error)) throw error;
    }
    // Provider policy is a pure text codec. Only this importer has filesystem authority, and
    // unrecognized paths still use the incumbent binary-safe, conflict-preserving import below.
    const merge = params.mergeSharedStateFile({
      entryPath: params.relativePath,
      currentContents: currentContents?.toString('utf8') ?? null,
      incomingContents: incomingContents.toString('utf8'),
    });
    if (merge) {
      if (merge.appendText.length > 0) {
        await mkdir(dirname(params.destinationPath), { recursive: true });
        await appendFile(params.destinationPath, merge.appendText, { encoding: 'utf8', mode: 0o600 });
      }
      return {
        sourcePath: params.sourcePath,
        destinationPath: params.destinationPath,
        relativePath: params.relativePath,
        action: merge.appendText.length > 0 ? 'imported' : 'skipped_identical',
      };
    }
  }
  const identical = params.mergeSharedStateFile
    ? currentContents !== null && createHash('sha256').update(currentContents).digest('hex') === sourceHash
    : await filesHaveSameHash(params.destinationPath, sourceHash);
  if (identical) {
    return {
      sourcePath: params.sourcePath,
      destinationPath: params.destinationPath,
      relativePath: params.relativePath,
      action: 'skipped_identical',
    };
  }

  const destination = await resolveWritableDestinationPath(params.destinationPath, sourceHash);
  if (destination.alreadyImported) {
    return {
      sourcePath: params.sourcePath,
      destinationPath: destination.path,
      relativePath: params.relativePath,
      action: 'skipped_identical',
    };
  }
  try {
    await copyFileAtomically(params.sourcePath, destination.path);
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }
    throw error;
  }
  return {
    sourcePath: params.sourcePath,
    destinationPath: destination.path,
    relativePath: params.relativePath,
    action: destination.path === params.destinationPath ? 'imported' : 'conflicted',
  };
}

async function filesHaveSameHash(path: string, expectedHash: string): Promise<boolean> {
  try {
    const actualHash = await hashFile(path);
    return actualHash === expectedHash;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return false;
    throw error;
  }
}

async function resolveWritableDestinationPath(destinationPath: string, sourceHash: string): Promise<Readonly<{
  path: string;
  alreadyImported: boolean;
}>> {
  try {
    await lstat(destinationPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return { path: destinationPath, alreadyImported: false };
    throw error;
  }

  const dir = dirname(destinationPath);
  const ext = extname(destinationPath);
  const stem = basename(destinationPath, ext);
  const hashPrefix = sourceHash.slice(0, 12);
  for (let attempt = 0; ; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const candidate = join(dir, `${stem}.happier-import-${hashPrefix}${suffix}${ext}`);
    if (await filesHaveSameHash(candidate, sourceHash)) return { path: candidate, alreadyImported: true };
    try {
      await lstat(candidate);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') return { path: candidate, alreadyImported: false };
      throw error;
    }
  }
}

async function copyFileAtomically(sourcePath: string, destinationPath: string): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  const tempPath = `${destinationPath}.happier-import-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await copyFile(sourcePath, tempPath);
    await rename(tempPath, destinationPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
