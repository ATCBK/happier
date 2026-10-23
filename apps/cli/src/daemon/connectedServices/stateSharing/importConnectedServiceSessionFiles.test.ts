import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

// Count OS directory reads while retaining the real importer and filesystem.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

import { importConnectedServiceSessionFiles } from './importConnectedServiceSessionFiles';
import { reconcileCodexSharedJsonlState } from '../../../../../../packages/plugins/codex/src/agent/auth/services/home/sync/fixedJsonlState';

describe('importConnectedServiceSessionFiles', () => {
  it('imports declared state without traversing ten thousand unrelated native plugin files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-selected-state-import-'));
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    const pluginsRoot = join(sourceRoot, 'plugins');
    try {
      await mkdir(join(sourceRoot, 'sessions'), { recursive: true });
      await writeFile(join(sourceRoot, 'sessions', 'rollout.jsonl'), 'private rollout\n');
      await writeFile(join(sourceRoot, 'history.jsonl'), 'private history\n');
      await writeFile(join(sourceRoot, 'auth.json'), 'fixture-only-auth');
      for (let directory = 0; directory < 100; directory++) {
        const path = join(pluginsRoot, String(directory));
        await mkdir(path, { recursive: true });
        await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(path, `${i}.json`), '{}')));
      }
      const reads = vi.mocked(filesystem.readdir);
      reads.mockClear();
      try {
        const result = await importConnectedServiceSessionFiles({ roots: [{
          sourceRoot, destinationRoot, includePaths: ['sessions', 'sessions/rollout.jsonl', 'history.jsonl'],
          includeFile: path => path === 'history.jsonl' || path.startsWith('sessions/'),
        }] });
        const unrelatedDirectoryReads = reads.mock.calls.filter(([path]) => String(path).startsWith(pluginsRoot)).length;
        expect(result).toMatchObject({ imported: 2, skippedIdentical: 0, conflicted: 0 });
        expect(await readFile(join(destinationRoot, 'sessions', 'rollout.jsonl'), 'utf8')).toBe('private rollout\n');
        expect(await readFile(join(destinationRoot, 'history.jsonl'), 'utf8')).toBe('private history\n');
        expect(await readdir(destinationRoot)).toEqual(['history.jsonl', 'sessions']);
        expect(unrelatedDirectoryReads).toBe(0);
      } finally { reads.mockClear(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('imports only exact selected resume files and observes later private writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-exact-state-import-'));
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    const selected = new Set(['sessions/nested/selected.jsonl']);
    try {
      await mkdir(join(sourceRoot, 'sessions', 'nested'), { recursive: true });
      await writeFile(join(sourceRoot, 'sessions', 'nested', 'selected.jsonl'), 'first');
      await writeFile(join(sourceRoot, 'sessions', 'nested', 'unselected.jsonl'), 'unselected');
      const roots = [{ sourceRoot, destinationRoot, includePaths: selected }];
      expect(await importConnectedServiceSessionFiles({ roots })).toMatchObject({ imported: 1, conflicted: 0 });
      expect(await readdir(join(destinationRoot, 'sessions', 'nested'))).toEqual(['selected.jsonl']);
      await writeFile(join(sourceRoot, 'sessions', 'nested', 'selected.jsonl'), 'later write');
      expect(await importConnectedServiceSessionFiles({ roots })).toMatchObject({ imported: 0, conflicted: 1 });
      expect(await readFile(join(destinationRoot, 'sessions', 'nested', 'selected.jsonl'), 'utf8')).toBe('first');
      const conflict = (await readdir(join(destinationRoot, 'sessions', 'nested'))).find(path => path.includes('.happier-import-'));
      expect(conflict).toBeDefined();
      expect(await readFile(join(destinationRoot, 'sessions', 'nested', conflict!), 'utf8')).toBe('later write');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['root', 'ancestor'] as const)('does not follow a selected file through a linked %s', async linkedPart => {
    const root = await mkdtemp(join(tmpdir(), 'happier-selected-state-link-'));
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    const foreign = join(root, 'foreign');
    try {
      await mkdir(foreign);
      await writeFile(join(foreign, 'rollout.jsonl'), 'foreign rollout');
      if (linkedPart === 'root') {
        await symlink(foreign, sourceRoot, process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        await mkdir(sourceRoot);
        await symlink(foreign, join(sourceRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      }
      const includePaths = [linkedPart === 'root' ? 'rollout.jsonl' : 'linked/rollout.jsonl'];
      expect(await importConnectedServiceSessionFiles({ roots: [{ sourceRoot, destinationRoot, includePaths }] }))
        .toMatchObject({ imported: 0, conflicted: 0, details: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not expand an invalid state selection to the entire home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-invalid-state-selection-'));
    const sourceRoot = join(root, 'source');
    try {
      await mkdir(sourceRoot);
      await writeFile(join(sourceRoot, 'auth.json'), 'fixture-only-auth');
      expect(await importConnectedServiceSessionFiles({ roots: [{
        sourceRoot, destinationRoot: join(root, 'destination'), includePaths: [],
      }] })).toMatchObject({ imported: 0, conflicted: 0, details: [] });
      const result = await importConnectedServiceSessionFiles({ roots: [{
        sourceRoot, destinationRoot: join(root, 'destination'), includePaths: ['.', '../', '/'],
      }] });
      expect(result).toMatchObject({ imported: 0, conflicted: 0, details: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves valid session imports beyond one hundred occupied conflict names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-many-conflicts-'));
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    const source = 'source-session\n';
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
    try {
      await mkdir(sourceRoot);
      await mkdir(destinationRoot);
      await writeFile(join(sourceRoot, 'rollout.jsonl'), source);
      await writeFile(join(destinationRoot, 'rollout.jsonl'), 'retained-session');
      await Promise.all(Array.from({ length: 105 }, (_, index) => writeFile(
        join(destinationRoot, `rollout.happier-import-${hash}${index === 0 ? '' : `-${index}`}.jsonl`), `retained-conflict-${index}`,
      )));
      const result = await importConnectedServiceSessionFiles({ roots: [{ sourceRoot, destinationRoot, includeFile: () => true }] });
      expect(result).toMatchObject({ conflicted: 1 });
      expect(await readFile(join(destinationRoot, `rollout.happier-import-${hash}-105.jsonl`), 'utf8')).toBe(source);
      expect(await readFile(join(destinationRoot, 'rollout.jsonl'), 'utf8')).toBe('retained-session');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('adopts fixed-name native state through the pure codec before linking without duplicating data or dropping generic conflicts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-state-import-'));
    const sourceRoot = join(root, 'private');
    const destinationRoot = join(root, 'native');
    try {
      await mkdir(sourceRoot, { recursive: true });
      await mkdir(destinationRoot, { recursive: true });
      await writeFile(join(sourceRoot, 'history.jsonl'), '{"text":"native"}\n{"text":"private"}\n{"text":"private"}\n');
      await writeFile(join(destinationRoot, 'history.jsonl'), '{"text":"native"}');
      await writeFile(join(sourceRoot, 'session_index.jsonl'), '{"id":"session","updated_at":"2026-10-11"}\n');
      await writeFile(join(destinationRoot, 'session_index.jsonl'), '{"id":"session","updated_at":"2026-10-10"}\n');
      await writeFile(join(sourceRoot, 'rollout.jsonl'), '{"id":"private"}\n');
      await writeFile(join(destinationRoot, 'rollout.jsonl'), '{"id":"native"}\n');
      await writeFile(join(sourceRoot, 'auth.json'), '{"token":"fixture-only"}\n');
      const importRoot = {
        sourceRoot, destinationRoot,
        includeFile: (entryPath: string) => entryPath.endsWith('.jsonl'),
        mergeSharedStateFile: reconcileCodexSharedJsonlState,
      };
      const first = await importConnectedServiceSessionFiles({ roots: [importRoot] });
      await expect(readFile(join(destinationRoot, 'history.jsonl'), 'utf8')).resolves.toBe('{"text":"native"}\n{"text":"private"}\n');
      await expect(readFile(join(destinationRoot, 'session_index.jsonl'), 'utf8')).resolves.toBe('{"id":"session","updated_at":"2026-10-10"}\n{"id":"session","updated_at":"2026-10-11"}\n');
      expect(first).toMatchObject({ imported: 2, conflicted: 1 });
      const entries = await readdir(destinationRoot);
      expect(entries.filter(entry => entry.startsWith('history.happier-import-') || entry.startsWith('session_index.happier-import-'))).toEqual([]);
      const rolloutConflict = entries.find(entry => entry.startsWith('rollout.happier-import-'));
      expect(rolloutConflict).toBeDefined();
      await expect(readFile(join(destinationRoot, rolloutConflict!), 'utf8')).resolves.toBe('{"id":"private"}\n');
      expect(entries).not.toContain('auth.json');
      const second = await importConnectedServiceSessionFiles({ roots: [importRoot] });
      expect(second).toMatchObject({ imported: 0, conflicted: 0, skippedIdentical: 3 });
      expect(await readdir(destinationRoot)).toEqual(entries);
      await expect(readFile(join(destinationRoot, 'history.jsonl'), 'utf8')).resolves.toBe('{"text":"native"}\n{"text":"private"}\n');
      await expect(readFile(join(sourceRoot, 'history.jsonl'), 'utf8')).resolves.toBe('{"text":"native"}\n{"text":"private"}\n{"text":"private"}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('imports matching nested session files without moving the source files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-import-'));
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    await mkdir(join(sourceRoot, '2026', '05', '21'), { recursive: true });
    await writeFile(join(sourceRoot, '2026', '05', '21', 'rollout.jsonl'), '{"id":"local"}\n');
    await writeFile(join(sourceRoot, '2026', '05', '21', 'state.sqlite'), 'sqlite');

    const result = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeFile: (relativePath) => relativePath.endsWith('.jsonl'),
      }],
    });

    expect(result).toMatchObject({
      imported: 1,
      skippedIdentical: 0,
      conflicted: 0,
    });
    await expect(readFile(join(destinationRoot, '2026', '05', '21', 'rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
    await expect(readFile(join(sourceRoot, '2026', '05', '21', 'rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
    await expect(readdir(join(destinationRoot, '2026', '05', '21'))).resolves.not.toContain('state.sqlite');
  });

  it('preserves conflicting destination files and is idempotent for existing imported conflicts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-import-conflict-'));
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(destinationRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'rollout.jsonl'), '{"id":"local"}\n');
    await writeFile(join(destinationRoot, 'rollout.jsonl'), '{"id":"main"}\n');

    const first = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeFile: (relativePath) => relativePath.endsWith('.jsonl'),
      }],
    });

    expect(first).toMatchObject({
      imported: 0,
      skippedIdentical: 0,
      conflicted: 1,
    });
    await expect(readFile(join(destinationRoot, 'rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"main"}\n');
    const conflictEntry = (await readdir(destinationRoot)).find((entry) => entry.startsWith('rollout.happier-import-') && entry.endsWith('.jsonl'));
    expect(conflictEntry).toBeDefined();
    await expect(readFile(join(destinationRoot, conflictEntry!), 'utf8')).resolves.toBe('{"id":"local"}\n');

    const second = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeFile: (relativePath) => relativePath.endsWith('.jsonl'),
      }],
    });

    expect(second).toMatchObject({
      imported: 0,
      skippedIdentical: 1,
      conflicted: 0,
    });
    const conflictEntries = (await readdir(destinationRoot)).filter((entry) => entry.startsWith('rollout.happier-import-') && entry.endsWith('.jsonl'));
    expect(conflictEntries).toHaveLength(1);
  });

  it('skips a root entirely when the destination root is a symlink to the source root', async () => {
    // Shared-mode staged rebuild regression: `staged/projects` is symlinked to the shared store
    // before the import pass runs. The same-root guard must compare PHYSICAL roots so the pass
    // performs zero work — otherwise every store file is hashed twice against itself, and an
    // append between the two reads mints a `<id>.happier-import-<hash>.jsonl` conflict copy of a
    // file onto itself in the shared store.
    const root = await mkdtemp(join(tmpdir(), 'happier-session-import-symlink-root-'));
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    await mkdir(join(sourceRoot, 'project-a'), { recursive: true });
    await writeFile(join(sourceRoot, 'project-a', 'rollout.jsonl'), '{"id":"shared"}\n');
    await writeFile(join(sourceRoot, 'project-a', 'other.jsonl'), '{"id":"other"}\n');
    await symlink(sourceRoot, destinationRoot, 'junction');

    const result = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeFile: (relativePath) => relativePath.endsWith('.jsonl'),
      }],
    });

    expect(result).toEqual({
      imported: 0,
      skippedIdentical: 0,
      conflicted: 0,
      details: [],
    });
    // The shared store must be untouched: no conflict copies minted onto itself.
    await expect(readdir(join(sourceRoot, 'project-a'))).resolves.toEqual(['other.jsonl', 'rollout.jsonl']);
  });

  it('skips a root entirely when the source root is a symlink to the destination root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-import-symlink-src-'));
    const destinationRoot = join(root, 'store');
    const sourceRoot = join(root, 'linked-store');
    await mkdir(destinationRoot, { recursive: true });
    await writeFile(join(destinationRoot, 'rollout.jsonl'), '{"id":"shared"}\n');
    await symlink(destinationRoot, sourceRoot, 'junction');

    const result = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeFile: (relativePath) => relativePath.endsWith('.jsonl'),
      }],
    });

    expect(result).toEqual({
      imported: 0,
      skippedIdentical: 0,
      conflicted: 0,
      details: [],
    });
    await expect(readdir(destinationRoot)).resolves.toEqual(['rollout.jsonl']);
  });

  it('still imports when a symlinked destination root resolves to a different physical directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-import-symlink-other-'));
    const sourceRoot = join(root, 'source');
    const physicalDestination = join(root, 'physical-destination');
    const destinationRoot = join(root, 'destination-link');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(physicalDestination, { recursive: true });
    await writeFile(join(sourceRoot, 'rollout.jsonl'), '{"id":"local"}\n');
    await symlink(physicalDestination, destinationRoot, 'junction');

    const result = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeFile: (relativePath) => relativePath.endsWith('.jsonl'),
      }],
    });

    expect(result).toMatchObject({
      imported: 1,
      skippedIdentical: 0,
      conflicted: 0,
    });
    await expect(readFile(join(physicalDestination, 'rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
  });

  it('still imports into a not-yet-existing destination beneath a symlinked ancestor when it is not the source root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-import-symlink-ancestor-'));
    const sourceRoot = join(root, 'source');
    const physicalParent = join(root, 'physical-parent');
    const linkedParent = join(root, 'linked-parent');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(physicalParent, { recursive: true });
    await writeFile(join(sourceRoot, 'rollout.jsonl'), '{"id":"local"}\n');
    await symlink(physicalParent, linkedParent, 'junction');
    const destinationRoot = join(linkedParent, 'projects');

    const result = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeFile: (relativePath) => relativePath.endsWith('.jsonl'),
      }],
    });

    expect(result).toMatchObject({
      imported: 1,
      skippedIdentical: 0,
      conflicted: 0,
    });
    await expect(readFile(join(physicalParent, 'projects', 'rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
  });

  it('skips a root when a destination reached through a symlinked ancestor resolves to the source root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-import-symlink-pending-'));
    const store = join(root, 'store');
    const sourceRoot = join(store, 'projects');
    const linkedStore = join(root, 'linked-store');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'rollout.jsonl'), '{"id":"shared"}\n');
    await symlink(store, linkedStore, 'junction');
    const destinationRoot = join(linkedStore, 'projects');

    const result = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeFile: (relativePath) => relativePath.endsWith('.jsonl'),
      }],
    });

    expect(result).toEqual({
      imported: 0,
      skippedIdentical: 0,
      conflicted: 0,
      details: [],
    });
    await expect(readdir(sourceRoot)).resolves.toEqual(['rollout.jsonl']);
  });
});
