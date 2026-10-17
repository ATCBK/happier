import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { preparePluginDevelopmentRoot } from './developmentCandidateMaterializer';
import { isPluginAuthorRootMaterialized, runManagedPluginPnpm, runPluginAuthorToolchain, type PluginAuthorToolchainDeps } from '@/plugins/authoring/toolchain';

describe('preparePluginDevelopmentRoot', () => {
  it('prepares the first-party source workspace without a managed tool or primary dependency refresh', async () => {
    const sourceRootPath = resolve(import.meta.dirname, '../../../../../packages/plugins/channels');
    const ensureManagedPnpmCommand = vi.fn(async () => null);
    const spawn = vi.fn(async () => {
      throw new Error('Source workspace preparation must not install into the shared checkout');
    });
    const prepared = await preparePluginDevelopmentRoot({
      sourceRootPath,
      prepareDependencies: true,
    }, {
      runManagedPluginPnpm: (params) => runManagedPluginPnpm(params, {
        ensureManagedPnpmCommand,
        managedPnpmBinPath: () => '/unused-managed-pnpm',
        buildManagedPnpmEnvironment: (env = {}) => env,
        spawn,
        processEnv: {},
      }),
    });

    expect(prepared.rootPath).toBe(sourceRootPath);
    await prepared.cleanup();
    expect(ensureManagedPnpmCommand).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    { installedVersion: null, message: 'Cannot find module' },
    { installedVersion: '2.0.0', message: 'does not satisfy declared range' },
  ])('refuses an incomplete source-workspace dependency declaration ($installedVersion)', async ({ installedVersion, message }) => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'happier-dev-workspace-declaration-'));
    const sourceRootPath = join(repoRoot, 'packages', 'plugins', 'fixture');
    const ensureManagedPnpmCommand = vi.fn(async () => null);
    const spawn = vi.fn(async () => {
      throw new Error('A dependency failure must not mutate the shared workspace');
    });
    try {
      await mkdir(sourceRootPath, { recursive: true });
      await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ workspaces: ['packages/plugins/*'] }));
      await writeFile(join(repoRoot, 'yarn.lock'), '');
      await writeFile(join(sourceRootPath, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugins-fixture',
        dependencies: { '@fixture/dependency': '^1.0.0' },
      }));
      const sdkRoot = join(sourceRootPath, 'node_modules', '@happier-dev', 'plugin-sdk');
      await mkdir(sdkRoot, { recursive: true });
      await writeFile(join(sdkRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugin-sdk', version: '0.0.0',
      }));
      if (installedVersion) {
        const dependencyRoot = join(repoRoot, 'node_modules', '@fixture', 'dependency');
        await mkdir(dependencyRoot, { recursive: true });
        await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({
          name: '@fixture/dependency', version: installedVersion,
        }));
      }
      await expect(isPluginAuthorRootMaterialized(sourceRootPath)).resolves.toBe(false);
      const result = await runPluginAuthorToolchain({ operation: 'install', projectRoot: sourceRootPath }, {
        ensureManagedPnpmCommand,
        managedPnpmBinPath: () => '/unused-managed-pnpm',
        buildManagedPnpmEnvironment: (env = {}) => env,
        ensureManagedJavaScriptRuntimeCommand: async () => null,
        managedJavaScriptRuntimeBinPath: () => '/unused-managed-runtime',
        resolveNativeTypeScriptBin: () => '/unused-compiler',
        spawn,
        processEnv: {},
      });
      expect(result).toMatchObject({
        ok: false,
        diagnostics: [{ code: 'plugin_author_tool_failed', message: expect.stringContaining(message) }],
      });
      expect(ensureManagedPnpmCommand).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('keeps a similarly named external root on the managed author dependency path', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'happier-dev-external-workspace-name-'));
    const sourceRootPath = join(repoRoot, 'packages', 'plugins', 'external');
    const managedCommand = '/managed-pnpm';
    const ensureManagedPnpmCommand = vi.fn(async () => managedCommand);
    const spawn = vi.fn(async (_input: Parameters<PluginAuthorToolchainDeps['spawn']>[0]) => ({
      exitCode: 0, signal: null, stdout: '', stderr: '',
    }));
    try {
      await mkdir(sourceRootPath, { recursive: true });
      await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ workspaces: ['packages/plugins/*'] }));
      await writeFile(join(repoRoot, 'yarn.lock'), '');
      await writeFile(join(sourceRootPath, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-fixture' }));
      const prepared = await preparePluginDevelopmentRoot({ sourceRootPath, prepareDependencies: true }, {
        runManagedPluginPnpm: (params) => runManagedPluginPnpm(params, {
          ensureManagedPnpmCommand,
          managedPnpmBinPath: () => managedCommand,
          buildManagedPnpmEnvironment: (env = {}) => env,
          spawn,
          processEnv: {},
        }),
      });
      expect(prepared.rootPath).toBe(sourceRootPath);
      expect(ensureManagedPnpmCommand).toHaveBeenCalledOnce();
      expect(spawn.mock.calls[0]?.[0]).toMatchObject({ command: managedCommand, cwd: sourceRootPath });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('uses the trusted author root in place and does no package-manager or copy work for source-only changes', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-dev-source-in-place-'));
    try {
      await mkdir(join(rootPath, 'src'));
      await writeFile(join(rootPath, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
      const runManagedPluginPnpm = vi.fn();

      const prepared = await preparePluginDevelopmentRoot({
        sourceRootPath: rootPath,
        prepareDependencies: false,
      }, { runManagedPluginPnpm });

      expect(prepared.rootPath).toBe(rootPath);
      expect(runManagedPluginPnpm).not.toHaveBeenCalled();
      await prepared.cleanup();
      await expect(readFile(join(rootPath, 'src', 'index.ts'), 'utf8'))
        .resolves.toBe('export const value = 1;\n');
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('prepares changed dependencies once in the author root through the managed toolchain', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-dev-dependencies-in-place-'));
    try {
      await writeFile(join(rootPath, 'package.json'), '{"name":"fixture"}\n', 'utf8');
      await writeFile(join(rootPath, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
      const runManagedPluginPnpm = vi.fn(async () => ({
        ok: true as const,
        result: { exitCode: 0, signal: null, stdout: '', stderr: '' },
      }));

      const prepared = await preparePluginDevelopmentRoot({
        sourceRootPath: rootPath,
        prepareDependencies: true,
        sdkRegistryOrigin: 'https://registry.example.test/',
      }, { runManagedPluginPnpm });

      expect(prepared.rootPath).toBe(rootPath);
      expect(runManagedPluginPnpm).toHaveBeenCalledOnce();
      expect(runManagedPluginPnpm).toHaveBeenCalledWith({
        projectRoot: rootPath,
        args: ['install', '--ignore-scripts', '--frozen-lockfile'],
        sdkRegistryOrigin: 'https://registry.example.test',
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
