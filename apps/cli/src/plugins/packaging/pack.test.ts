import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as tar from 'tar';
import { describe, expect, it } from 'vitest';
import { PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH } from '../authoring/daemonOutputManifest';
import { createTestNpmTarball, sriSha512 } from '../distribution/testkit/npmTarball';
import { createTestPluginSdkTarball } from '../distribution/testkit/pluginSdkTarball';
import { createPluginManifestV2Fixture } from '../testkit/manifestV2Fixture';
import { startCandidateRegistry } from '../../../../../packages/tests/scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import { packLocalPlugin } from './pack';

async function startCandidateSdkRegistry(params: Readonly<{
  sdkTarball: Buffer;
}>): Promise<Readonly<{
  origin: string;
  close(): Promise<void>;
}>> {
  const registry = await startCandidateRegistry({
    packages: [{
      packageName: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      integrity: sriSha512(params.sdkTarball),
      bytes: params.sdkTarball,
    }],
  });
  return Object.freeze({
    origin: registry.origin,
    close: async () => await registry.close(),
  });
}

async function writeSdkRegistryPackFixture(
  root: string,
  options?: Readonly<{ sdkVersion?: string }>,
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'happier-plugin-sdk-registry-pack-fixture',
    version: '1.0.0',
    type: 'module',
    keywords: ['happier-plugin'],
    happier: { manifest: '.happier-plugin/plugin.json' },
    files: ['index.ts'],
    dependencies: { '@happier-dev/plugin-sdk': options?.sdkVersion ?? '0.0.0' },
  }, null, 2), 'utf8');
  await writeFile(join(root, 'index.ts'), [
    "import { definePlugin } from '@happier-dev/plugin-sdk';",
    'export const { manifest, activate } = definePlugin({',
    "  id: 'acme.sdk-registry-pack', version: '1.0.0',",
    "  displayName: 'SDK registry pack', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
    "  entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] },",
    `  metadata: JSON.parse(${JSON.stringify('{"__proto__":{"inert":true},"ordinary":"preserved"}')}),`,
    '});',
    '',
  ].join('\n'), 'utf8');
}

async function createCandidateChannelsProtocolTarball(): Promise<Buffer> {
  return await createTestNpmTarball([
    {
      name: 'package/package.json',
      body: JSON.stringify({
        name: '@happier-dev/channels-protocol',
        version: '0.0.0',
        type: 'module',
        exports: {
          '.': './index.js',
          './v1': './v1/index.js',
          './testing/v1': './testing/v1/index.js',
        },
      }),
    },
    {
      name: 'package/index.js',
      body: "export const CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1 = 'happier.channels/providers';\n",
    },
    {
      name: 'package/v1/index.js',
      body: "export const CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1 = 'happier.channels/providers';\n",
    },
    {
      name: 'package/testing/v1/index.js',
      body: 'export function createConversationProviderSetupResultV1Fixture() { return {}; }\n',
    },
  ]);
}

async function writeBundledFirstPartyPackFixture(repoRoot: string): Promise<Readonly<{
  packageRoot: string;
  packageJsonPath: string;
}>> {
  const packageRoot = join(repoRoot, 'packages', 'plugins', 'channel-telegram');
  const packageJsonPath = join(packageRoot, 'package.json');
  await mkdir(join(repoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(repoRoot, 'packages', 'plugin-sdk'), { recursive: true });
  await mkdir(join(repoRoot, 'packages', 'channels-protocol'), { recursive: true });
  await mkdir(join(packageRoot, 'src'), { recursive: true });
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await Promise.all([
    writeFile(join(repoRoot, 'package.json'), JSON.stringify({ private: true }), 'utf8'),
    writeFile(join(repoRoot, 'pnpm-lock.yaml'), '', 'utf8'),
    writeFile(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n'),
    writeFile(join(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.0.0',
      bundledDependencies: [
        '@happier-dev/channels-protocol',
        '@happier-dev/plugin-sdk',
        '@happier-dev/plugins-channel-telegram',
      ],
    }, null, 2), 'utf8'),
    writeFile(join(repoRoot, 'packages', 'plugin-sdk', 'package.json'), JSON.stringify({
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
    }), 'utf8'),
    writeFile(join(repoRoot, 'packages', 'channels-protocol', 'package.json'), JSON.stringify({
      name: '@happier-dev/channels-protocol',
      version: '0.0.0',
    }), 'utf8'),
    writeFile(packageJsonPath, JSON.stringify({
      name: '@happier-dev/plugins-channel-telegram',
      version: '0.0.0',
      private: true,
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          default: './dist/index.js',
        },
      },
      files: ['dist', 'package.json'],
      dependencies: {
        '@happier-dev/channels-protocol': '0.0.0',
        '@happier-dev/plugin-sdk': '0.0.0',
      },
    }, null, 2), 'utf8'),
    writeFile(join(packageRoot, 'dist', 'index.js'), 'export const stale = true;\n', 'utf8'),
    writeFile(join(packageRoot, 'dist', 'index.d.ts'), 'export declare const stale: true;\n', 'utf8'),
    writeFile(join(packageRoot, 'src', 'index.ts'), [
      "import { CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1 } from '@happier-dev/channels-protocol';",
      "import { definePlugin } from '@happier-dev/plugin-sdk';",
      '',
      'export const { manifest, activate } = definePlugin({',
      "  id: 'happier.channel.telegram', version: '0.0.0',",
      '  displayName: CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1, engines: { happier: \'>=0.0.0\' }, runtime: { apiVersion: 1 },',
      "  entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] },",
      '});',
      '',
    ].join('\n'), 'utf8'),
  ]);
  return Object.freeze({ packageRoot, packageJsonPath });
}

async function writeBundledFirstPartyDescriptorPackFixture(repoRoot: string): Promise<Readonly<{
  packageRoot: string;
}>> {
  const packageRoot = join(repoRoot, 'packages', 'plugins', 'channels');
  await mkdir(join(repoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(packageRoot, '.happier-plugin'), { recursive: true });
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await Promise.all([
    writeFile(join(repoRoot, 'package.json'), JSON.stringify({ private: true }), 'utf8'),
    writeFile(join(repoRoot, 'pnpm-lock.yaml'), '', 'utf8'),
    writeFile(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n'),
    writeFile(join(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.0.0',
      bundledDependencies: ['@happier-dev/plugins-channels'],
    }, null, 2), 'utf8'),
    writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugins-channels',
      version: '0.0.0',
      private: true,
      type: 'module',
      // A descriptor-only package declares no author entry: a `main` module is
      // an author entry and would require the public SDK dependency instead.
      files: ['dist', '.happier-plugin', 'package.json'],
    }, null, 2), 'utf8'),
    writeFile(join(packageRoot, 'dist', 'index.js'), 'export const bundled = true;\n', 'utf8'),
    writeFile(join(packageRoot, '.happier-plugin', 'daemon.js'), 'export function activate() {}\n', 'utf8'),
    writeFile(
      join(packageRoot, '.happier-plugin', 'plugin.json'),
      `${JSON.stringify(createPluginManifestV2Fixture({
        id: 'happier.channels',
        version: '0.0.0',
        displayName: 'Channels',
        // The bundled release stamp, exactly as the shipped descriptor carries
        // it: a range the running development CLI never satisfies.
        engines: { happier: '^0.0.0' },
        entrypoints: { daemon: './.happier-plugin/daemon.js' },
      }))}\n`,
      'utf8',
    ),
  ]);
  return Object.freeze({ packageRoot });
}

describe('packLocalPlugin', () => {
  it('keeps explicit manifest locators cold when a package also contains author source', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-explicit-manifest-pack-'));
    const root = join(parent, 'plugin');
    try {
      await mkdir(join(root, '.happier-plugin'), { recursive: true });
      const manifest = createPluginManifestV2Fixture({ id: 'acme.explicit-manifest', entrypoints: undefined });
      const manifestPath = join(root, '.happier-plugin', 'plugin.json');
      await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
      await writeFile(join(root, 'index.ts'), "throw new Error('Explicit manifest packing must not evaluate author source');\n", 'utf8');
      await writeFile(join(root, 'package.json'), JSON.stringify({
        name: 'happier-plugin-explicit-manifest', version: manifest.version,
        keywords: ['happier-plugin'], happier: { manifest: '.happier-plugin/plugin.json' },
        files: ['.happier-plugin/plugin.json'],
      }), 'utf8');

      for (const [index, locator] of [manifestPath, join(root, '.happier-plugin')].entries()) {
        expect(await packLocalPlugin({ locator, outPath: join(parent, `explicit-${index}.tgz`) }))
          .toMatchObject({ ok: true, pluginId: manifest.id });
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('removes only manifest-owned outputs from a descriptor-only pack copy before archive traversal', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-descriptor-transition-pack-'));
    const root = join(parent, 'plugin');
    const archivePath = join(parent, 'descriptor-transition.tgz');
    try {
      await mkdir(join(root, '.happier-plugin'), { recursive: true });
      await mkdir(join(root, 'dist', '.happier-chunks'), { recursive: true });
      await mkdir(join(root, 'dist', 'actions'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({
        name: 'happier-plugin-descriptor-transition',
        version: '1.0.0',
        type: 'module',
        keywords: ['happier-plugin'],
        happier: { manifest: '.happier-plugin/plugin.json' },
        files: ['.happier-plugin/plugin.json', 'dist'],
      }, null, 2), 'utf8');
      await writeFile(
        join(root, '.happier-plugin', 'plugin.json'),
        `${JSON.stringify(createPluginManifestV2Fixture({
          id: 'acme.descriptor-transition',
          entrypoints: undefined,
        }))}\n`,
        'utf8',
      );
      await writeFile(join(root, 'dist', 'daemon.js'), 'stale daemon output\n', 'utf8');
      await writeFile(join(root, 'dist', 'source-owned.js'), 'stale custom daemon output\n', 'utf8');
      await writeFile(join(root, 'dist', 'index.js'), 'fresh descriptor output\n', 'utf8');
      await writeFile(join(root, 'dist', '.happier-chunks', 'chunk-stale.js'), 'stale chunk output\n', 'utf8');
      await writeFile(
        join(root, 'dist', 'actions', 'index.js'),
        'export const authorOwned = true;\n',
        'utf8',
      );
      await writeFile(
        join(root, PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH),
        `${JSON.stringify({ version: 1, outputs: ['dist/source-owned.js'] })}\n`,
        'utf8',
      );

      const result = await packLocalPlugin({ locator: root, outPath: archivePath });

      expect(result, result.ok ? '' : result.diagnostics.map((entry) => entry.message).join('\n'))
        .toMatchObject({ ok: true, pluginId: 'acme.descriptor-transition' });
      const archiveEntries: string[] = [];
      await tar.t({
        file: archivePath,
        onentry(entry) {
          archiveEntries.push(entry.path);
        },
      });
      expect(archiveEntries).toContain('package/dist/daemon.js');
      expect(archiveEntries).not.toContain('package/dist/source-owned.js');
      expect(archiveEntries).toContain('package/dist/index.js');
      expect(archiveEntries).toContain('package/dist/.happier-chunks/chunk-stale.js');
      expect(archiveEntries).toContain('package/dist/actions/index.js');
      await expect(readFile(join(root, 'dist', 'index.js'), 'utf8'))
        .resolves.toBe('fresh descriptor output\n');
      await expect(readFile(join(root, 'dist', 'source-owned.js'), 'utf8'))
        .resolves.toBe('stale custom daemon output\n');
      await expect(readFile(join(root, PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH), 'utf8'))
        .resolves.toMatch(/source-owned\.js/u);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects and redacts a credential-bearing SDK registry override before author preparation', async () => {
    const secret = 'sdk-registry-secret';
    const result = await packLocalPlugin({
      locator: '/fixture/plugin',
      sdkRegistryOrigin: `https://author:${secret}@registry.example.test`,
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        message: 'Plugin SDK registry must be a credential-free HTTPS origin or loopback HTTP origin',
      })],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('returns the managed author-install failure when the supplied SDK registry cannot serve the declared version', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-sdk-registry-pack-missing-'));
    const root = join(parent, 'plugin');
    const registry = await startCandidateSdkRegistry({ sdkTarball: await createTestPluginSdkTarball() });
    try {
      await writeSdkRegistryPackFixture(root, { sdkVersion: '9999.0.0' });
      const result = await packLocalPlugin({
        locator: root,
        outPath: join(parent, 'missing-sdk.tgz'),
        sdkRegistryOrigin: registry.origin,
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({
          code: 'plugin_pack_sdk_dependency_invalid',
          message: expect.stringContaining("supported specifier '0.0.0'"),
        })],
      });
    } finally {
      await registry.close();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('does not promote a locally sourced workspace plugin to bundled first-party authority while packing', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-bundled-first-party-pack-'));
    const fixture = await writeBundledFirstPartyPackFixture(parent);
    const [sdkTarball, channelsProtocolTarball] = await Promise.all([
      createTestPluginSdkTarball(),
      createCandidateChannelsProtocolTarball(),
    ]);
    const registry = await startCandidateRegistry({
      packages: [
        {
          packageName: '@happier-dev/plugin-sdk',
          version: '0.0.0',
          integrity: sriSha512(sdkTarball),
          bytes: sdkTarball,
        },
        {
          packageName: '@happier-dev/channels-protocol',
          version: '0.0.0',
          integrity: sriSha512(channelsProtocolTarball),
          bytes: channelsProtocolTarball,
        },
      ],
    });
    try {
      const result = await packLocalPlugin({
        locator: fixture.packageRoot,
        outPath: join(parent, 'bundled-first-party.tgz'),
        sdkRegistryOrigin: registry.origin,
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ message: expect.stringContaining('happier-plugin keyword') })],
      });
      const sourcePackageJson = JSON.parse(await readFile(fixture.packageJsonPath, 'utf8')) as Record<string, unknown>;
      expect(sourcePackageJson).not.toHaveProperty('keywords');
      expect(sourcePackageJson).not.toHaveProperty('happier');
    } finally {
      await registry.close();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('does not infer bundled first-party authority from a package name outside the canonical workspace', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-noncanonical-first-party-pack-'));
    const fixture = await writeBundledFirstPartyPackFixture(parent);
    const outsidePackageRoot = join(parent, 'outside-package');
    await cp(fixture.packageRoot, outsidePackageRoot, { recursive: true });
    const [sdkTarball, channelsProtocolTarball] = await Promise.all([
      createTestPluginSdkTarball(),
      createCandidateChannelsProtocolTarball(),
    ]);
    const registry = await startCandidateRegistry({
      packages: [
        {
          packageName: '@happier-dev/plugin-sdk',
          version: '0.0.0',
          integrity: sriSha512(sdkTarball),
          bytes: sdkTarball,
        },
        {
          packageName: '@happier-dev/channels-protocol',
          version: '0.0.0',
          integrity: sriSha512(channelsProtocolTarball),
          bytes: channelsProtocolTarball,
        },
      ],
    });
    try {
      const result = await packLocalPlugin({
        locator: outsidePackageRoot,
        outPath: join(parent, 'noncanonical-first-party.tgz'),
        sdkRegistryOrigin: registry.origin,
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ message: expect.stringContaining('happier-plugin keyword') })],
      });
    } finally {
      await registry.close();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('does not promote a locally sourced descriptor package to bundled first-party authority while packing', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-bundled-first-party-descriptor-pack-'));
    const fixture = await writeBundledFirstPartyDescriptorPackFixture(parent);
    try {
      const result = await packLocalPlugin({
        locator: fixture.packageRoot,
        outPath: join(parent, 'bundled-first-party-descriptor.tgz'),
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({
          message: expect.stringContaining('happier-plugin keyword'),
        })],
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('still rejects a reserved-namespace descriptor package outside the canonical bundled workspace', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-noncanonical-descriptor-pack-'));
    const fixture = await writeBundledFirstPartyDescriptorPackFixture(parent);
    const outsidePackageRoot = join(parent, 'outside-package');
    await cp(fixture.packageRoot, outsidePackageRoot, { recursive: true });
    try {
      const result = await packLocalPlugin({
        locator: outsidePackageRoot,
        outPath: join(parent, 'noncanonical-descriptor.tgz'),
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({
          message: expect.stringContaining('happier-plugin keyword'),
        })],
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('packs an isolated package-root author project through its supplied SDK registry', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-sdk-registry-pack-success-'));
    const root = join(parent, 'plugin');
    const registry = await startCandidateSdkRegistry({ sdkTarball: await createTestPluginSdkTarball() });
    try {
      await writeSdkRegistryPackFixture(root);
      const result = await packLocalPlugin({
        locator: root,
        outPath: join(parent, 'candidate-sdk.tgz'),
        sdkRegistryOrigin: registry.origin,
      });

      expect(result, result.ok ? '' : result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'))
        .toMatchObject({ ok: true, pluginId: 'acme.sdk-registry-pack' });
      await expect(readFile(join(root, 'node_modules', '@happier-dev', 'plugin-sdk', 'index.js'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await registry.close();
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe('plugin pack SDK dependency contract', () => {
  async function writeSdkContractFixture(root: string, options?: Readonly<{ sdkSpecifier?: string | null }>): Promise<void> {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'happier-plugin-sdk-contract-fixture',
      version: '1.0.0',
      type: 'module',
      keywords: ['happier-plugin'],
      happier: { manifest: '.happier-plugin/plugin.json' },
      files: ['index.ts'],
      ...(options?.sdkSpecifier === null
        ? {}
        : { dependencies: { '@happier-dev/plugin-sdk': options?.sdkSpecifier ?? '0.0.0' } }),
    }, null, 2), 'utf8');
    await writeFile(join(root, 'index.ts'), [
      "import { definePlugin } from '@happier-dev/plugin-sdk';",
      'export const { manifest, activate } = definePlugin({',
      "  id: 'acme.sdk-contract', version: '1.0.0',",
      "  displayName: 'SDK contract', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
      "  entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] },",
      '  contributes: {},',
      '});',
      '',
    ].join('\n'), 'utf8');
  }

  it('rejects an author package that imports the SDK without declaring the runtime dependency', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-pack-sdk-missing-'));
    const root = join(parent, 'plugin');
    await writeSdkContractFixture(root, { sdkSpecifier: null });
    try {
      const result = await packLocalPlugin({ locator: root });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics).toEqual([expect.objectContaining({
        code: 'plugin_pack_sdk_dependency_invalid',
        message: expect.stringMatching(/dependencies/),
      })]);
      expect(result.diagnostics[0]?.message).toContain('@happier-dev/plugin-sdk');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects forbidden local/workspace SDK dependency forms', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-pack-sdk-workspace-'));
    const root = join(parent, 'plugin');
    await writeSdkContractFixture(root, { sdkSpecifier: 'workspace:*' });
    try {
      const result = await packLocalPlugin({ locator: root });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics).toEqual([expect.objectContaining({
        code: 'plugin_pack_sdk_dependency_invalid',
        message: expect.stringMatching(/workspace:/),
      })]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects SDK dependency versions outside the canonical supported packet', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-pack-sdk-incompatible-'));
    const root = join(parent, 'plugin');
    await writeSdkContractFixture(root, { sdkSpecifier: '9.9.9' });
    const sdkTarball = await createTestPluginSdkTarball();
    const registry = await startCandidateSdkRegistry({ sdkTarball });
    try {
      const result = await packLocalPlugin({ locator: root, sdkRegistryOrigin: registry.origin });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics).toEqual([expect.objectContaining({
        code: 'plugin_pack_sdk_dependency_invalid',
        message: expect.stringMatching(/9\.9\.9/),
      })]);
    } finally {
      await registry.close();
      await rm(parent, { recursive: true, force: true });
    }
  });
}, 240_000);
