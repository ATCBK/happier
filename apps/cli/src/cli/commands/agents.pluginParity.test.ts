import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';

const { resolveMergedContributionRegistryMock } = vi.hoisted(() => ({
  resolveMergedContributionRegistryMock: vi.fn(),
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/projection/registry/createResolvedContributionRegistry')>();
  return {
    ...actual,
    resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
  };
});

import { handleAgentsCommand } from './agents';

describe('happier agents plugin-provider parity', () => {
  let home = '';
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);

  beforeEach(async () => {
    resolveMergedContributionRegistryMock.mockReset();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    home = await createTempDir('happier-agents-plugin-parity-');
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const pluginProvider = {
      id: 'acme.plugin',
      source: 'plugin' as const,
      definition: {
        id: 'acme.plugin',
      },
      runtimeSpec: {
        kindVersion: 1,
        id: 'acme.plugin',
        title: 'Acme Plugin CLI',
        binaryName: 'acme-plugin',
        sourcePreferenceDefault: 'system-first',
        managedInstall: {
          kind: 'managed_package',
          packageName: '@acme/plugin-cli',
          binaryName: 'acme-plugin',
        },
        manualInstallKind: 'command',
        manualInstallRecipes: null,
        acceptsJavaScriptFileOverride: false,
      },
    };

    resolveMergedContributionRegistryMock.mockResolvedValue({
      agents: [pluginProvider],
      backends: [],
      runtimeAdaptersByBackendId: new Map(),
      catalogEntriesById: {},
      agentDefinitionsById: new Map([['acme.plugin', pluginProvider]]),
      backendDefinitionsById: new Map(),
      pluginDiagnosticsByPluginId: {},
    });
  });

  afterEach(async () => {
    envScope.restore();
    reloadConfiguration();
    if (home) await removeTempDir(home);
  });

  it('includes plugin-provided provider CLI rows in agents list JSON output', async () => {
    // Listing reads the accepted installed declarations, so the plugin is installed
    // at the plugin-store boundary rather than injected into the executable registry.
    const pluginRoot = join(home, 'acme-plugin-source');
    const manifest = PluginManifestV2Schema.parse(createPluginManifestV2Fixture({
      id: 'acme.plugin',
      contributes: { agents: [{
        id: 'cli', title: 'Acme Plugin CLI', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { surfaces: ['terminal'], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        cli: {
          executable: { binaryName: 'acme-plugin', sourcePreference: 'system-first', acceptsJavaScriptFileOverride: false },
          install: { manual: { kind: 'none' } },
          auth: { support: 'login_terminal', loginLaunches: [{ kind: 'primary', args: ['login'] }] },
        },
      }] },
    }));
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}\n');
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest));
    await seedCurrentLocalPathPluginFixture({ happyHomeDir: home, pluginRoot, pluginId: 'acme.plugin', manifestVersion: manifest.version, devWatch: true });
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleAgentsCommand(['list', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('agents_list');
      expect(parsed.data.agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'acme.plugin/cli',
            title: 'Acme Plugin CLI',
          }),
        ]),
      );
    } finally {
      output.restore();
    }
  });

  it('accepts plugin provider ids in agents setup selection', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleAgentsCommand(['setup', '--providers', 'acme.plugin', '--dry-run', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('agents_setup');
      expect(parsed.data.agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agentId: 'acme.plugin',
            ok: true,
          }),
        ]),
      );
    } finally {
      output.restore();
    }
  });

  it('installs a plugin provider via agents install dry-run', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleAgentsCommand(['install', 'acme.plugin', '--dry-run', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('agents_install');
      expect(parsed.data).toEqual(
        expect.objectContaining({
          agentId: 'acme.plugin',
        }),
      );
      expect(parsed.data.plan).toEqual(expect.objectContaining({
        agentId: 'acme.plugin',
        installMode: 'managed_package',
      }));
    } finally {
      output.restore();
    }
  });
});
