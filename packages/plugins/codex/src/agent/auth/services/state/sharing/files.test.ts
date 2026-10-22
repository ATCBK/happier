import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveCodexConfiguredSqliteHome,
  resolveCodexRuntimeHomeEnvironment,
} from './files.js';

describe('Codex state sharing files', () => {
  it('retains predecessor shared affinity and keeps isolated homes independent of ambient SQLite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-home-affinity-'));
    try {
      const codexHome = join(root, 'pool');
      const nativeHome = join(root, 'native');
      await mkdir(codexHome);
      const manifestPath = join(codexHome, '.happier-codex-home-sharing.json');
      // 0.2's existing manifest contains the sharing mode but no root projection.
      await writeFile(manifestPath, JSON.stringify({ v: 1, requestedStateMode: 'shared', effectiveStateMode: 'shared', stateEntries: ['sessions'] }));
      const resolveHome = (env: Readonly<Record<string, string | undefined>>) => resolveCodexRuntimeHomeEnvironment({
        env, codexHome, cwd: root, expandHomePath: path => path,
      });
      expect((await resolveHome({ CODEX_HOME: nativeHome })).CODEX_SQLITE_HOME).toBe(nativeHome);
      expect((await resolveHome({ CODEX_HOME: codexHome, HOME: root })).CODEX_SQLITE_HOME).toBe(join(root, '.codex'));
      expect((await resolveHome({ CODEX_SQLITE_HOME: 'custom' })).CODEX_SQLITE_HOME).toBe(join(root, 'custom'));
      await writeFile(manifestPath, JSON.stringify({ v: 1, effectiveStateMode: 'isolated' }));
      expect((await resolveHome({ CODEX_SQLITE_HOME: 'custom' })).CODEX_SQLITE_HOME).toBe(codexHome);
      await rm(manifestPath);
      expect((await resolveCodexRuntimeHomeEnvironment({
        env: { CODEX_SQLITE_HOME: 'custom' }, codexHome, home: 'connectedService', cwd: root, expandHomePath: path => path,
      })).CODEX_SQLITE_HOME).toBe(codexHome);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('resolves configured SQLite state homes without owning generic env expansion', () => {
    const expandHomePath = (raw: string) => raw.replace(/^~(?=\/|$)/, '/Users/alice');
    expect(resolveCodexConfiguredSqliteHome({
      codexSqliteHome: '/tmp/codex-sqlite-home',
      fallbackCodexHome: '/tmp/codex-home',
      cwd: '/work/repo',
      expandHomePath,
    })).toBe('/tmp/codex-sqlite-home');

    expect(resolveCodexConfiguredSqliteHome({
      codexSqliteHome: '   ',
      fallbackCodexHome: '/tmp/codex-home',
      cwd: '/work/repo',
      expandHomePath,
    })).toBe('/tmp/codex-home');

    expect(resolveCodexConfiguredSqliteHome({
      codexSqliteHome: '~/.codex-state',
      fallbackCodexHome: '/tmp/codex-home',
      cwd: '/work/repo',
      expandHomePath,
    })).toBe('/Users/alice/.codex-state');

    expect(resolveCodexConfiguredSqliteHome({
      codexSqliteHome: 'relative-sqlite',
      fallbackCodexHome: '/tmp/codex-home',
      cwd: '/work/repo',
      expandHomePath,
    })).toBe('/work/repo/relative-sqlite');
  });
});
