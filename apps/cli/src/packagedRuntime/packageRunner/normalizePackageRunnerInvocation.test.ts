import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as managedPnpm from '@/packagedRuntime/managedTools/pnpm/managedPnpm';

import { isPackageRunnerCommand, normalizePackageRunnerInvocation } from './normalizePackageRunnerInvocation';

describe('normalizePackageRunnerInvocation', () => {
  it('recognizes named and absolute package runner commands', () => {
    expect(isPackageRunnerCommand(join('tools', 'npx.cmd'))).toBe(true);
    expect(isPackageRunnerCommand('bunx')).toBe(true);
    expect(isPackageRunnerCommand('agent-cli')).toBe(false);
  });
  let rootDir: string;
  let processEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'happier-normalize-package-runner-'));
    const pnpmPath = join(rootDir, 'pnpm');
    await writeFile(pnpmPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(pnpmPath, 0o755);
    processEnv = {
      HAPPIER_PNPM_BIN: pnpmPath,
      HAPPIER_HOME_DIR: rootDir,
      HAPPIER_JS_RUNTIME_PATH: process.execPath,
      PATH: '',
    } as NodeJS.ProcessEnv;
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('rewrites npx invocations to managed pnpm dlx', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'npx',
        args: ['-y', '--prefer-offline', '@scope/server', '--flag'],
        processEnv,
      }),
    ).resolves.toMatchObject({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['dlx', '@scope/server', '--flag'],
      cwdPolicy: 'neutral',
    });
  });

  it('resolves a Node command through the managed JavaScript runtime', async () => {
    await expect(normalizePackageRunnerInvocation({ command: 'node', args: ['agent.js', '--acp'],
      processEnv: { ...processEnv, HAPPIER_JS_RUNTIME_PATH: process.execPath },
    })).resolves.toEqual({ command: process.execPath, args: ['agent.js', '--acp'], cwdPolicy: 'workspace' });
  });

  it('refuses Node when its explicit runtime override is unavailable', async () => {
    await expect(normalizePackageRunnerInvocation({ command: 'node', args: ['agent.js'],
      processEnv: { ...processEnv, HAPPIER_JS_RUNTIME_PATH: join(rootDir, 'missing-node') },
    })).resolves.toBeNull();
  });

  it('refuses package execution when the selected JavaScript runtime is unavailable', async () => {
    await expect(normalizePackageRunnerInvocation({ command: 'npx', args: ['fixture'],
      processEnv: { ...processEnv, HAPPIER_JS_RUNTIME_PATH: join(rootDir, 'missing-node') },
    })).resolves.toBeNull();
  });

  it('preserves authored Windows Path through the canonical case-insensitive merge', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const normalized = await normalizePackageRunnerInvocation({ command: 'npx.cmd', args: ['fixture'],
        processEnv: { ...processEnv, PATH: 'inherited-path' }, launchEnv: { Path: 'authored-path' },
      });
      expect(normalized?.env?.PATH.split(delimiter)).toEqual([dirname(process.execPath), 'authored-path']);
      expect(normalized?.env).not.toHaveProperty('Path');
    } finally { Object.defineProperty(process, 'platform', platform); }
  });

  it('preserves npm exec invocations without package flags for workspace-local binaries', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'npm',
        args: ['exec', '--', '@scope/server', '--flag'],
        processEnv,
      }),
    ).resolves.toMatchObject({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['exec', '@scope/server', '--flag'],
      cwdPolicy: 'workspace',
    });
  });

  it('rewrites npm exec package installs to managed pnpm dlx', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'npm',
        args: ['exec', '--package', '@scope/server', '--', 'server', '--flag'],
        processEnv,
      }),
    ).resolves.toMatchObject({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['dlx', '--package', '@scope/server', 'server', '--flag'],
      cwdPolicy: 'neutral',
    });
  });

  it('rewrites npm exec combined package flags to managed pnpm dlx', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'npm',
        args: ['exec', '--package=@scope/server', '--', 'server', '--flag'],
        processEnv,
      }),
    ).resolves.toMatchObject({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['dlx', '--package=@scope/server', 'server', '--flag'],
      cwdPolicy: 'neutral',
    });
  });

  it('preserves npm run invocations on managed pnpm for workspace-local scripts', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'npm',
        args: ['run', 'dev', '--', '--port', '3000'],
        processEnv,
      }),
    ).resolves.toMatchObject({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['run', 'dev', '--', '--port', '3000'],
      cwdPolicy: 'workspace',
    });
  });

  it('preserves pnpm exec invocations on managed pnpm for workspace-local binaries', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'pnpm',
        args: ['exec', 'tsx', 'server.ts'],
        processEnv,
      }),
    ).resolves.toMatchObject({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['exec', 'tsx', 'server.ts'],
      cwdPolicy: 'workspace',
    });
  });

  it('rewrites yarn dlx invocations to managed pnpm dlx', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'yarn',
        args: ['dlx', '@scope/server', '--flag'],
        processEnv,
      }),
    ).resolves.toMatchObject({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['dlx', '@scope/server', '--flag'],
      cwdPolicy: 'neutral',
    });
  });

  it('rewrites yarnpkg.cmd dlx invocations to managed pnpm dlx', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'yarnpkg.cmd',
        args: ['dlx', '@scope/server'],
        processEnv,
      }),
    ).resolves.toMatchObject({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['dlx', '@scope/server'],
      cwdPolicy: 'neutral',
    });
  });

  it('does not bootstrap managed pnpm for unsupported runner commands', async () => {
    const ensureSpy = vi.spyOn(managedPnpm, 'ensureManagedPnpmCommand');

    await expect(
      normalizePackageRunnerInvocation({
        command: 'unsupported-runner',
        args: ['--help'],
        processEnv,
      }),
    ).resolves.toBeNull();

    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it('does not rewrite non-dlx yarn invocations whose semantics depend on yarn', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'yarn',
        args: ['workspace', 'docs', 'run', 'dev'],
        processEnv,
      }),
    ).resolves.toBeNull();
  });

  it('rewrites bunx invocations to managed pnpm dlx', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'bunx',
        args: ['@scope/server'],
        processEnv,
      }),
    ).resolves.toMatchObject({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['dlx', '@scope/server'],
      cwdPolicy: 'neutral',
    });
  });

  it('keeps pnpm invocations on managed pnpm', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'pnpm',
        args: ['dlx', '@scope/server'],
        processEnv,
      }),
    ).resolves.toMatchObject({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['dlx', '@scope/server'],
      cwdPolicy: 'neutral',
    });
  });

  it('fails closed when HAPPIER_PNPM_BIN is set but invalid', async () => {
    processEnv = {
      HAPPIER_PNPM_BIN: join(rootDir, 'missing-pnpm'),
      PATH: rootDir,
    } as NodeJS.ProcessEnv;

    await expect(
      normalizePackageRunnerInvocation({
        command: 'npx',
        args: ['@scope/server'],
        processEnv,
      }),
    ).resolves.toBeNull();
  });

  it('fails closed when HAPPIER_PNPM_BIN points to an executable directory', async () => {
    const pnpmDir = join(rootDir, 'pnpm-dir');
    await mkdir(pnpmDir, { recursive: true });
    await chmod(pnpmDir, 0o755);

    processEnv = {
      HAPPIER_PNPM_BIN: pnpmDir,
      PATH: rootDir,
    } as NodeJS.ProcessEnv;

    await expect(
      normalizePackageRunnerInvocation({
        command: 'npx',
        args: ['@scope/server'],
        processEnv,
      }),
    ).resolves.toBeNull();
  });
});
