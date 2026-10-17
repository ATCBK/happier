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
    dir.create({ intermediates: true, idempotent: true });
  }
  return new fs.File(dir, parts[parts.length - 1]!);
}

export function getMetaFile(fs: InstallerFs, rootDir: any): any {
  return new fs.File(rootDir, 'pack.json');
}

export function assertManifestPathsSafe(manifest: ModelPackManifest): void {
  const destinations = new Set<string>();
  for (const f of manifest.files) {
    // Use the same normalization as getPackFile. Case folding also protects iOS filesystems.
    const path = filePathParts(f.path).join('/').toLowerCase();
    if (path === 'pack.json' || path.startsWith('pack.json/')) throw new Error('model_pack_reserved_path');
    if (destinations.has(path)) throw new Error('model_pack_path_alias');
    destinations.add(path);
  }
  for (const path of destinations) {
    const parts = path.split('/');
    for (let length = 1; length < parts.length; length++) {
      if (destinations.has(parts.slice(0, length).join('/'))) {
        throw new Error('model_pack_path_file_directory_conflict');
      }
    }
  }
}
