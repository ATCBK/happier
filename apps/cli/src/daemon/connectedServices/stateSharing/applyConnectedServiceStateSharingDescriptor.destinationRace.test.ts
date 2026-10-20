import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConnectedServiceStateSharingDescriptor } from '@/agent/catalog/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const descriptor: ConnectedServiceStateSharingDescriptor = {
  providerId: 'claude',
  providerSupportStatus: 'supported',
  config: { supported: true, modes: ['linked', 'copied', 'isolated'], entries: [] },
  state: {
    supported: true,
    modes: ['shared', 'isolated'],
    entries: [{ path: 'projects', mode: 'linked' }],
    symlinkUnavailableDegradePolicy: 'block_continuity',
  },
  authIsolation: { mode: 'materialized_home', secretEntries: [] },
};

function createRenameError(code: string): NodeJS.ErrnoException {
  const error = new Error(`injected ${code} destination race`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

async function applyDescriptor(params: Readonly<{
  root: string;
  sourceRoot: string;
  targetRoot: string;
  signal?: AbortSignal;
}>): Promise<void> {
  const { applyConnectedServiceStateSharingDescriptor } = await import('./applyConnectedServiceStateSharingDescriptor');
  await applyConnectedServiceStateSharingDescriptor({
    signal: params.signal,
    descriptor,
    nativeSourceContext: { sourceRoot: params.sourceRoot, sourceEnv: {} },
    target: { targetMaterializedRoot: params.targetRoot, targetMaterializedEnv: {} },
    configMode: 'isolated',
    requestedStateMode: 'shared',
    effectiveStateMode: 'shared',
    cwd: params.root,
  });
}

describe('applyConnectedServiceStateSharingDescriptor destination races', () => {
  afterEach(() => {
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  });

  it('blocks continuity when required state symlinks are unavailable without replacing private state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-link-unavailable-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    try {
      await mkdir(join(sourceRoot, 'projects'), { recursive: true });
      await writeFile(join(sourceRoot, 'projects', 'source.jsonl'), '{"id":"source"}\n');
      await mkdir(join(targetRoot, 'projects'), { recursive: true });
      await writeFile(join(targetRoot, 'projects', 'private.jsonl'), '{"id":"private"}\n');
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          symlink: async () => {
            const error = new Error('symlink unavailable') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          },
        };
      });

      await expect(applyDescriptor({ root, sourceRoot, targetRoot })).rejects.toMatchObject({
        code: 'state_symlink_unavailable',
        entryName: 'projects',
        fsCode: 'EPERM',
      });
      await expect(readFile(join(targetRoot, 'projects', 'private.jsonl'), 'utf8')).resolves.toBe('{"id":"private"}\n');
      await expect(readFile(join(sourceRoot, 'projects', 'source.jsonl'), 'utf8')).resolves.toBe('{"id":"source"}\n');
      expect((await readdir(targetRoot)).some((name) => name.includes('.happier-link-'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refreshes owned linked-config fallback copies without accumulating private backups', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-config-fallback-repeat-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    try {
      await mkdir(sourceRoot, { recursive: true });
      await mkdir(targetRoot, { recursive: true });
      await writeFile(join(sourceRoot, 'settings.json'), 'source-one');
      await writeFile(join(targetRoot, 'settings.json'), 'private-original');
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return { ...actual, symlink: async () => { throw createRenameError('EPERM'); } };
      });
      const { applyConnectedServiceStateSharingDescriptor: apply } = await import('./applyConnectedServiceStateSharingDescriptor');
      const input = {
        descriptor: { ...descriptor, config: { ...descriptor.config, entries: [{ path: 'settings.json', mode: 'linked' as const }] } },
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        configMode: 'linked', requestedStateMode: 'isolated', effectiveStateMode: 'isolated', cwd: root,
      } as const;
      const first = await apply(input);
      const privateBackups = (await readdir(targetRoot)).filter(name => name.startsWith('settings.json.local-'));
      expect(privateBackups).toHaveLength(1);
      const before = await lstat(join(targetRoot, 'settings.json'));
      await apply({ ...input, existingManifest: first.manifest });
      expect((await lstat(join(targetRoot, 'settings.json'))).ino).toBe(before.ino);
      await writeFile(join(sourceRoot, 'settings.json'), 'source-two');
      await apply({ ...input, existingManifest: first.manifest });
      expect((await readdir(targetRoot)).filter(name => name.startsWith('settings.json.local-'))).toEqual(privateBackups);
      await expect(readFile(join(targetRoot, privateBackups[0]!), 'utf8')).resolves.toBe('private-original');
      await expect(readFile(join(targetRoot, 'settings.json'), 'utf8')).resolves.toBe('source-two');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries when moving an existing entry aside collides with a directory suffix', async () => {
    const renameMock = vi.fn()
      .mockRejectedValueOnce(createRenameError('EISDIR'))
      .mockResolvedValueOnce(undefined);
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return { ...actual, rename: renameMock };
    });
    const { moveConnectedServiceHomeEntryAside } = await import('./connectedServiceHomeEntrySync');

    await expect(moveConnectedServiceHomeEntryAside('/tmp/provider-home')).resolves.toBeUndefined();
    expect(renameMock).toHaveBeenCalledTimes(2);
  });

  it.each(['EISDIR', 'ENOTEMPTY', 'EEXIST', 'EPERM'] as const)(
    'preserves provider-created content and retries the same prepared link after %s',
    async (raceCode) => {
      const root = await mkdtemp(join(tmpdir(), 'happier-state-link-race-'));
      const sourceRoot = join(root, 'source');
      const targetRoot = join(root, 'target');
      const targetProjects = join(targetRoot, 'projects');
      const promotionSources: string[] = [];

      try {
        await mkdir(join(sourceRoot, 'projects'), { recursive: true });
        await writeFile(join(sourceRoot, 'projects', 'session.jsonl'), '{"type":"assistant"}\n');
        await mkdir(targetRoot, { recursive: true });

        vi.doMock('node:fs/promises', async () => {
          const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
          let injectedDestinationRace = false;
          return {
            ...actual,
            rename: vi.fn(async (sourcePath: string, destinationPath: string) => {
              if (sourcePath.includes('projects.happier-link-') && destinationPath === targetProjects) {
                promotionSources.push(sourcePath);
                if (!injectedDestinationRace) {
                  injectedDestinationRace = true;
                  await actual.mkdir(targetProjects, { recursive: true });
                  await actual.writeFile(join(targetProjects, 'provider-created.txt'), raceCode);
                  throw createRenameError(raceCode);
                }
              }
              return await actual.rename(sourcePath, destinationPath);
            }),
          };
        });

        await applyDescriptor({ root, sourceRoot, targetRoot });

        expect(promotionSources).toHaveLength(2);
        expect(new Set(promotionSources).size).toBe(1);
        expect((await lstat(targetProjects)).isSymbolicLink()).toBe(true);
        await expect(readFile(join(targetProjects, 'session.jsonl'), 'utf8')).resolves.toBe('{"type":"assistant"}\n');
        const preservedEntries = (await readdir(targetRoot)).filter((name) => name.startsWith('projects.local-'));
        expect(preservedEntries).toHaveLength(1);
        await expect(readFile(join(targetRoot, preservedEntries[0]!, 'provider-created.txt'), 'utf8')).resolves.toBe(raceCode);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['complete', 'cancel'] as const)('preserves six repeated destination races until %s and removes the prepared temporary link', async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-link-race-exhausted-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    const targetProjects = join(targetRoot, 'projects');
    const promotionSources: string[] = [];
    const controller = new AbortController();
    const cancellation = new Error('Caller retired materialization');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_785_907_024_119);

    try {
      await mkdir(join(sourceRoot, 'projects'), { recursive: true });
      await writeFile(join(sourceRoot, 'projects', 'session.jsonl'), '{}\n');
      await mkdir(targetRoot, { recursive: true });

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          rename: vi.fn(async (sourcePath: string, destinationPath: string) => {
            if (sourcePath.includes('projects.happier-link-') && destinationPath === targetProjects) {
              promotionSources.push(sourcePath);
              if (promotionSources.length <= 6) {
                await actual.mkdir(targetProjects, { recursive: true });
                await actual.writeFile(join(targetProjects, `provider-${promotionSources.length}.txt`), 'preserve me');
                if (outcome === 'cancel' && promotionSources.length === 6) controller.abort(cancellation);
                throw createRenameError('EEXIST');
              }
            }
            return await actual.rename(sourcePath, destinationPath);
          }),
        };
      });

      const applied = applyDescriptor({ root, sourceRoot, targetRoot, signal: controller.signal });
      if (outcome === 'cancel') {
        await expect(applied).rejects.toBe(cancellation);
      } else {
        await applied;
        expect((await lstat(targetProjects)).isSymbolicLink()).toBe(true);
        await expect(readFile(join(targetProjects, 'session.jsonl'), 'utf8')).resolves.toBe('{}\n');
      }
      expect(promotionSources).toHaveLength(outcome === 'cancel' ? 6 : 7);
      expect(new Set(promotionSources).size).toBe(1);
      const targetEntries = await readdir(targetRoot);
      expect(targetEntries.some((name) => name.includes('.happier-link-'))).toBe(false);
      const preserved = targetEntries.filter((name) => name.startsWith('projects.local-'));
      expect(preserved).toHaveLength(outcome === 'cancel' ? 5 : 6);
      for (let race = 1; race <= 6; race++) {
        const directory = outcome === 'cancel' && race === 6
          ? targetProjects
          : join(targetRoot, preserved[race - 1]!);
        await expect(readFile(join(directory, `provider-${race}.txt`), 'utf8')).resolves.toBe('preserve me');
      }
    } finally {
      now.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['EACCES', 'EPERM'])('propagates permanent %s without retrying and removes the temporary link', async (code) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-link-race-nonretry-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    const targetProjects = join(targetRoot, 'projects');
    const promotionSources: string[] = [];
    const permissionError = createRenameError(code);

    try {
      await mkdir(join(sourceRoot, 'projects'), { recursive: true });
      await writeFile(join(sourceRoot, 'projects', 'session.jsonl'), '{}\n');
      await mkdir(targetRoot, { recursive: true });

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          rename: vi.fn(async (sourcePath: string, destinationPath: string) => {
            if (sourcePath.includes('projects.happier-link-') && destinationPath === targetProjects) {
              promotionSources.push(sourcePath);
              throw permissionError;
            }
            return await actual.rename(sourcePath, destinationPath);
          }),
        };
      });

      await expect(applyDescriptor({ root, sourceRoot, targetRoot })).rejects.toBe(permissionError);
      expect(promotionSources).toHaveLength(1);
      expect((await readdir(targetRoot)).some((name) => name.includes('.happier-link-'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
