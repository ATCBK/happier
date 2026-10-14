import type { ModelPackManifest } from '@/voice/modelPacks/manifest';

import type { InstallerFs } from './types';

export function filePathParts(path: string): string[] {
  const raw = path.trim();
  if (!raw) throw new Error('model_pack_invalid_path');
  if (raw.startsWith('/') || raw.startsWith('\\')) throw new Error('model_pack_invalid_path');
  if (raw.includes('\\')) throw new Error('model_pack_invalid_path');
  if (raw.includes('\0')) throw new Error('model_pack_invalid_path');

  const parts = raw
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error('model_pack_invalid_path');
  for (const p of parts) {
    if (p === '.' || p === '..') throw new Error('model_pack_invalid_path');
  }
  return parts;
}

export function normalizePackId(packId: string | null): string {
  return packId && packId.trim().length > 0 ? packId.trim() : 'default';
}

export function getPackRootDir(fs: InstallerFs, packId: string): any {
  return new fs.Directory(fs.Paths.document, 'happier', 'voice', 'modelPacks', packId);
}

// Updates stage changed files outside the pack so the installed pack stays usable until the swap.
export function getPackUpdateDir(fs: InstallerFs, packId: string): any {
  return new fs.Directory(fs.Paths.document, 'happier', 'voice', 'modelPackUpdates', packId);
}

export function getPackFile(fs: InstallerFs, rootDir: any, path: string, opts: { createParents?: boolean } = {}): any {
  const parts = filePathParts(path);
  let dir = rootDir;
  for (const p of parts.slice(0, -1)) {
    dir = new fs.Directory(dir, p);
  }
  if (opts.createParents) {
    try {
      dir.create({ intermediates: true, idempotent: true });
    } catch {
      // ignore
    }
  }
  return new fs.File(dir, parts[parts.length - 1]!);
}

export function getMetaFile(fs: InstallerFs, rootDir: any): any {
  return new fs.File(rootDir, 'pack.json');
}

export function assertManifestPathsSafe(manifest: ModelPackManifest): void {
  for (const f of manifest.files) {
    // This will throw model_pack_invalid_path on invalid paths.
    filePathParts(f.path);
  }
}

