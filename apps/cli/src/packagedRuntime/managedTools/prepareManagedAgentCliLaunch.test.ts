import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAgentCliRuntimeSpec } from '@happier-dev/agents';
import { resolvePlatformFromNodePlatform } from '@happier-dev/cli-common/agents';
import { describe, expect, it } from 'vitest';

import { bindAgentCliLaunchSpec, resolveAgentCliLaunchSpecForRuntime } from './agentCliLaunchSpec';
import { prepareManagedAgentCliLaunch } from './prepareManagedAgentCliLaunch';

function expectedOhMyPiReleaseAssetName(): string | null {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'omp-darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'omp-darwin-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'omp-linux-arm64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'omp-linux-x64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'omp-windows-x64.exe';
  return null;
}

function ohMyPiRuntimeSpec() {
  const runtimeSpec = getAgentCliRuntimeSpec('ohMyPi');
  if (!runtimeSpec) throw new Error('Expected a bundled ohMyPi CLI runtime spec');
  return runtimeSpec;
}

function releaseInstallDeps(assetName: string, download: () => Promise<void> | void) {
  return {
    fetchGitHubLatestRelease: async () => ({
      tag_name: 'v16.1.5',
      assets: [
        {
          name: assetName,
          browser_download_url: `https://example.test/${assetName}`,
          digest: 'sha256:testdigest',
        },
      ],
    }),
    downloadGitHubReleaseAsset: async (params: Readonly<{ destinationPath: string }>) => {
      await download();
      await writeFile(params.destinationPath, '#!/bin/sh\nexit 0\n', 'utf8');
    },
  };
}

describe('prepareManagedAgentCliLaunch', () => {
  it('returns no launch for a canceled Runner acquisition', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-runner-canceled-launch-'));
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(prepareManagedAgentCliLaunch({
        runtimeSpec: ohMyPiRuntimeSpec(),
        platform: resolvePlatformFromNodePlatform(process.platform)!,
        processEnv: { ...process.env, HAPPIER_HOME_DIR: homeDir },
        signal: controller.signal,
      })).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('launches the exact prepared managed executable even when an override appears before launch', async () => {
    if (process.platform === 'win32') return;
    const assetName = expectedOhMyPiReleaseAssetName();
    if (!assetName) return;

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-runner-managed-launch-home-'));
    const overrideDir = await mkdtemp(join(tmpdir(), 'happier-runner-managed-launch-override-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      const processEnv = {
        ...process.env,
        HAPPIER_HOME_DIR: homeDir,
        PATH: '',
      } as NodeJS.ProcessEnv;

      const prepared = await prepareManagedAgentCliLaunch({
        runtimeSpec: ohMyPiRuntimeSpec(),
        platform,
        processEnv,
        deps: releaseInstallDeps(assetName, () => {}),
      });

      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const managedCommand = join(homeDir, 'tools', 'providers', 'ohMyPi', 'current', 'bin', 'omp');
      expect(prepared.resolution).toEqual({ source: 'managed', command: managedCommand });
      expect(prepared.launch).toEqual({
        source: 'managed',
        resolvedPath: managedCommand,
        command: managedCommand,
        args: [],
        providerExitOwnership: 'direct',
      });

      // An endpoint override that appears after readiness must not reach the
      // Agent: the admitted launch is consumed unchanged, while ordinary
      // resolution would now answer the override.
      const overridePath = join(overrideDir, 'omp');
      await writeFile(overridePath, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(overridePath, 0o755);
      const launchTimeEnv = { ...processEnv, HAPPIER_OHMYPI_PATH: overridePath };

      expect(resolveAgentCliLaunchSpecForRuntime(ohMyPiRuntimeSpec(), { processEnv: launchTimeEnv }))
        .toMatchObject({ source: 'override', resolvedPath: overridePath });

      // The retained-launch custody the daemon and Runner share carries that
      // exact spec forward; binding must not reopen resolution.
      const bound = bindAgentCliLaunchSpec({ localAgentId: 'ohMyPi', spec: prepared.launch });
      expect(bound.spec).toEqual(prepared.launch);
      expect(bound.spec.command).toBe(managedCommand);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(overrideDir, { recursive: true, force: true });
    }
  });

  it('returns no launch when the managed installation fails', async () => {
    const assetName = expectedOhMyPiReleaseAssetName();
    if (!assetName) return;

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-runner-managed-launch-failure-home-'));
    const systemDir = await mkdtemp(join(tmpdir(), 'happier-runner-managed-launch-failure-bin-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      const systemPath = join(systemDir, process.platform === 'win32' ? 'omp.exe' : 'omp');
      await writeFile(systemPath, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(systemPath, 0o755);

      const prepared = await prepareManagedAgentCliLaunch({
        runtimeSpec: ohMyPiRuntimeSpec(),
        platform,
        processEnv: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          PATH: systemDir,
        } as NodeJS.ProcessEnv,
        deps: releaseInstallDeps(assetName, () => {
          throw new Error('release asset download refused');
        }),
      });

      expect(prepared.ok).toBe(false);
      if (prepared.ok) return;
      expect(prepared).not.toHaveProperty('launch');
      expect(prepared.errorMessage).toContain('release asset download refused');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(systemDir, { recursive: true, force: true });
    }
  });
});
